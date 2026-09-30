/**
 * HighSeaz shared protocol — the single source of truth for the wire format
 * between the Babylon.js client and the authoritative Node server.
 *
 * On-chain rule (see design spec): ONLY mint loot / escrow+claim bounty /
 * auction settle / ship transfer touch the chain. Everything below is OFF-chain
 * realtime + DB state.
 */

// ---------------------------------------------------------------------------
// Math / spatial primitives (kept dependency-free so both sides can import)
// ---------------------------------------------------------------------------

export interface Vec3 {
	x: number;
	y: number;
	z: number;
}

/** Yaw-only heading in radians. Ships are constrained to the sea surface. */
export type Heading = number;

// ---------------------------------------------------------------------------
// World entities
// ---------------------------------------------------------------------------

export type ShipClass =
	| "starter_sloop"
	| "raider_sloop"
	| "raider_brig"
	| "brigantine"
	| "merchant"
	| "galleon"
	| "war_galleon"
	| "imperial";

/** pirate / naval / merchant — the three reputation counters in the design. */
export type Faction = "pirate" | "naval" | "merchant";

export type ShipMode = "player" | "auto";

export type ShipStatus = "active" | "sunk_needs_repair" | "on_auto";

// ---------------------------------------------------------------------------
// Gear-based sail modes (task #138)
// ---------------------------------------------------------------------------

/**
 * Discrete sail ORDERS that replace the raw 0..1 analog throttle as the
 * canonical helm control. Each gear fixes a target throttle multiplier AND a
 * turn-authority factor, so the feel of a ship is chosen by order, not by how
 * far a stick is pushed:
 *   stop    — lie-to: no way on, but the rudder still has whatever steerage the
 *             water gives it (used to hold position / wait out a storm).
 *   half    — cruise: the easy default, balanced speed and handling.
 *   full    — full sail: fast and agile, what you fight a chase in.
 *   travel  — the Black Flag run: the highest sustained speed, but a heavy,
 *             sluggish helm (worst turning), because she is over-pressed.
 * The table is shared so the SERVER (which resolves the sim) and the CLIENT
 * (which shows the gear label) agree exactly on the numbers.
 */
export type SailGear = "stop" | "half" | "full" | "travel";

export interface SailGearSpec {
	label: string;
	/** Target throttle multiplier, 0..1, fed into the sail model. */
	throttle: number;
	/** Multiplier on turn authority; <1 makes the hull wallow (travel gear). */
	turnFactor: number;
}

export const SAIL_GEARS: Record<SailGear, SailGearSpec> = {
	stop: { label: "Stop", throttle: 0, turnFactor: 1.0 },
	half: { label: "Half", throttle: 0.5, turnFactor: 1.0 },
	full: { label: "Full", throttle: 0.85, turnFactor: 1.0 },
	travel: { label: "Travel", throttle: 1.0, turnFactor: 0.55 },
};

/** The gear ladder, in order, so the client can cycle it and map a key index. */
export const SAIL_GEAR_ORDER: SailGear[] = ["stop", "half", "full", "travel"];

/**
 * Snap a continuous 0..1 analog throttle (gamepad / touch) back to the nearest
 * canonical gear. Kept so the analog path and the gear path never disagree: the
 * server derives gear from an analog value the same way the HUD will label it.
 */
export function gearForThrottle(throttle: number): SailGear {
	if (throttle <= 0.02) return "stop";
	if (throttle <= 0.55) return "half";
	if (throttle <= 0.9) return "full";
	return "travel";
}

export interface ShipState {
	/** Server-assigned runtime id (differs from the on-chain ERC-721 tokenId). */
	id: string;
	/** ERC-721 token id of the hull, if the ship is owned/minted. */
	tokenId?: bigint;
	ownerAddress?: string;
	name: string;
	shipClass: ShipClass;
	faction: Faction;
	mode: ShipMode;

	position: Vec3;
	heading: Heading;
	velocity: Vec3;
	angularVelocity: number;

	/** Hull integrity in points; 0 => sunk. Max is SHIP[class].hullMax. */
	hull: number;
	/**
	 * Rigging/sail integrity in points; 0 => becalmed (almost no steerage and a
	 * hard speed cap), but the hull is still afloat — sails are a cripple track,
	 * never a kill track. Max is SHIP[class].sailsMax. Repairing at a dock
	 * restores both hull and sails.
	 */
	sails: number;
	/** Off-chain cargo units carried; the cargo is the stake lost on sink. */
	cargo: number;

	/**
	 * The current sail ORDER (gear) on the helm. Absent until the captain issues a
	 * gear order — while absent the server falls back to the raw analog throttle
	 * (gamepad / touch). Once set it is the canonical control and rides the
	 * snapshot so the HUD can show "Stop / Half / Full / Travel".
	 */
	gear?: SailGear;

	/**
	 * Lifetime kills this hull has taken (sunk) — the PROVENANCE-as-PRESTIGE badge.
	 * The durable truth is written on-chain (ShipNFT.recordProvenance via the
	 * relayer); this is the OFF-chain mirror that rides the snapshot so a battle-
	 * hardened hull reads as feared on its marker live, chain or no chain. Absent/0
	 * until it has actually sunk a rival.
	 */
	kills?: number;

	status: ShipStatus;
}

/**
 * Static combat/sailing tuning per hull class. Lives in the shared protocol so
 * the SERVER (which resolves combat) and the CLIENT (which shows HUD numbers and
 * predicts the shell arc) never drift. All damage/range/reload are authoritative
 * server inputs; the client reads them only for display + cosmetic projection.
 */
export interface ShipClassSpec {
	label: string;
	/** Full hull integrity at 100%. */
	hullMax: number;
	/** Full rigging/sail integrity at 100%. */
	sailsMax: number;
	/** Hull points dealt by one broadside volley at point-blank, before falloff. */
	broadsideDamage: number;
	/** Cannon ports that loose together in one broadside. This is purely how many
	 *  shells the volley visibly splits into — total damage stays `broadsideDamage`,
	 *  spread across the guns — so bigger hulls throw a wider fan of shot without
	 *  becoming unbalanced. */
	guns: number;
	/** Effective range in world units; falloff is linear to ~35% at the edge. */
	range: number;
	/** Seconds a full broadside takes to reload. Larger hulls carry more guns, so
	 *  this scales DOWN with ship size — a Man-o'-War looses volleys far faster than
	 *  a two-gun sloop. */
	reloadSeconds: number;
	/** World units/s the shell travels — fixes flight time for the arc. */
	shellSpeed: number;
	/** Top speed (world units/s) used by the sail model. */
	maxSpeed: number;
	/** Cargo bay capacity (units) — how much a prize is worth taking. */
	cargoCapacity: number;
}

export const SHIP_CLASSES: Record<ShipClass, ShipClassSpec> = {
	starter_sloop: { label: "Starter Sloop", hullMax: 100, sailsMax: 60, broadsideDamage: 9, guns: 1, range: 150, reloadSeconds: 9, shellSpeed: 60, maxSpeed: 12, cargoCapacity: 10 },
	raider_sloop: { label: "Raider Sloop", hullMax: 120, sailsMax: 72, broadsideDamage: 13, guns: 2, range: 175, reloadSeconds: 8, shellSpeed: 66, maxSpeed: 13, cargoCapacity: 18 },
	raider_brig: { label: "Raider Brig", hullMax: 170, sailsMax: 104, broadsideDamage: 19, guns: 3, range: 210, reloadSeconds: 6, shellSpeed: 72, maxSpeed: 12.5, cargoCapacity: 30 },
	brigantine: { label: "Brigantine", hullMax: 210, sailsMax: 128, broadsideDamage: 24, guns: 4, range: 235, reloadSeconds: 5, shellSpeed: 76, maxSpeed: 12, cargoCapacity: 42 },
	merchant: { label: "Merchant", hullMax: 180, sailsMax: 110, broadsideDamage: 11, guns: 2, range: 170, reloadSeconds: 7, shellSpeed: 60, maxSpeed: 9.5, cargoCapacity: 70 },
	galleon: { label: "Galleon", hullMax: 300, sailsMax: 180, broadsideDamage: 30, guns: 6, range: 260, reloadSeconds: 4, shellSpeed: 80, maxSpeed: 10.5, cargoCapacity: 85 },
	war_galleon: { label: "War Galleon", hullMax: 380, sailsMax: 226, broadsideDamage: 38, guns: 8, range: 285, reloadSeconds: 3.2, shellSpeed: 84, maxSpeed: 11, cargoCapacity: 60 },
	imperial: { label: "Imperial Man-o'-War", hullMax: 460, sailsMax: 272, broadsideDamage: 46, guns: 10, range: 310, reloadSeconds: 2.6, shellSpeed: 88, maxSpeed: 11.5, cargoCapacity: 75 },
};

/**
 * How a single incoming broadside splits its damage between the rigging and the
 * hull. Rigging is the exposed, soft target — shot that finds its mark tears
 * sails and shrouds before it starts smashing frames — so a gunnery duel first
 * cripples you (bleeds speed + steerage, per `sailPenalty`), and only a hull
 * that has already lost its canvas is a hull easy to finish. Applied as a fixed
 * fraction of each hit; once the sails are gone the whole hit goes to the hull.
 */
export const SAIL_DAMAGE_FRACTION = 0.4;

/**
 * Directional gunnery. The weapon a hull can bring to bear is decided by WHERE
 * the gunner points relative to the bow, not by a selector: a sailing ship's
 * guns face fixed arcs, so aiming down the bow looses a chaser, off the beam a
 * full broadside, over the quarter a fire-ship's barrels. The SAME table drives
 * the server resolve and the client's HUD arc indicator so they never disagree.
 */
export type WeaponType = "chain" | "swivel" | "broadside" | "fire";

export interface WeaponTuning {
	label: string;
	/** Aim angle off the bow (radians) at which this weapon takes over, measured
	 *  outward from the bow. The four buckets tile 0..PI. */
	maxArc: number;
	rangeFactor: number;
	/** Fraction of the class broadside that lands as hull damage vs canvas. */
	hullFactor: number;
	/** Fraction of each hit that tears rigging instead of the frames. */
	sailShare: number;
	reloadFactor: number;
	/** Extra aim-cone slack (world units) beyond the target's beam — a wide cone
	 *  auto-aims when roughly pointed; a tight one needs the beam laid square. */
	coneBonus: number;
	/** Cap on how many shells swing (broadside uses the full gun deck). */
	gunCap: number;
	/** Fire barrels: a hit ignites the target, ticking hull damage over time. */
	ignites: boolean;
}

/** Bow-relative buckets, outer edge in radians: bow chain -> quarter swivel ->
 *  beam broadside -> aft fire. */
export const WEAPONS: Record<WeaponType, WeaponTuning> = {
	chain:     { label: "Chain shot",   maxArc: 0.42,     rangeFactor: 1.0,  hullFactor: 0.5,  sailShare: 0.85, reloadFactor: 1.0, coneBonus: 8,  gunCap: 4,  ignites: false },
	swivel:    { label: "Swivel gun",   maxArc: 1.05,     rangeFactor: 0.9,  hullFactor: 0.7,  sailShare: 0.4,  reloadFactor: 0.7, coneBonus: 22, gunCap: 2,  ignites: false },
	broadside: { label: "Broadside",    maxArc: 2.14,     rangeFactor: 1.0,  hullFactor: 1.15, sailShare: 0.4,  reloadFactor: 1.1, coneBonus: 8,  gunCap: 99, ignites: false },
	fire:      { label: "Fire barrels", maxArc: Math.PI,  rangeFactor: 0.6,  hullFactor: 0.6,  sailShare: 0.3,  reloadFactor: 1.3, coneBonus: 30, gunCap: 1,  ignites: true },
};

/** Hull damage per second from an ignition and how long it burns. A fire is
 *  pressure, not an instant kill. */
export const BURN_DPS = 3;
export const BURN_SECONDS = 8;

/** Map an aim angle relative to the bow (any sign) to the weapon that arc
 *  fires. Shared so the HUD and the server resolve agree exactly. */
export function weaponForAim(relAngle: number): WeaponType {
	const a = Math.abs(Math.atan2(Math.sin(relAngle), Math.cos(relAngle))); // wrap to [0,PI]
	if (a <= WEAPONS.chain.maxArc) return "chain";
	if (a <= WEAPONS.swivel.maxArc) return "swivel";
	if (a <= WEAPONS.broadside.maxArc) return "broadside";
	return "fire";
}

/**
 * The kind of shot loaded into whatever gun the aim has brought to bear. Where
 * `WEAPONS` is the GUN (its arc, range, cone, volley size), `AMMO` is the
 * PAYLOAD riding that gun — the four historical kinds of fire. The captain
 * cycles it (the shop sells each) and it MODIFIES the arc's resolve: chain
 * bites canvas not timbers, grape is a savage close-range blast, a heated ball
 * sets the rigging alight. A round shot is the honest default that changes
 * nothing. Multipliers below compose with the arc: hull and range scale,
 * `sailShare` scales the arc's rigging fraction, `coneBonus` adds aim slack,
 * `ignites` forces a fire on top of the arc's own.
 */
export type AmmoType = "round" | "chain" | "grape" | "heated";

export interface AmmoTuning {
	label: string;
	/** Short readout of what this shot is for, shown on the HUD. */
	hint: string;
	/** Multiplies the arc's hull damage. */
	hullFactor: number;
	/** Multiplies the arc's rigging share (capped to 1 downstream). */
	sailShare: number;
	/** Multiplies the arc's reach. */
	rangeFactor: number;
	/** Additive aim-cone slack (world units) on top of the arc's own. */
	coneBonus: number;
	/** Multiplies the arc's reload seconds. */
	reloadFactor: number;
	/** A hot shot ignites whatever it strikes, even on an arc that otherwise wouldn't. */
	ignites: boolean;
}

export const AMMO: Record<AmmoType, AmmoTuning> = {
	round:  { label: "Round shot",     hint: "solid iron — balanced against the frames", hullFactor: 1.0,  sailShare: 1.0, rangeFactor: 1.0,  coneBonus: 0,  reloadFactor: 1.0, ignites: false },
	chain:  { label: "Chain shot",     hint: "twin balls on a bar — shreds canvas",      hullFactor: 0.7,  sailShare: 1.7, rangeFactor: 1.0, coneBonus: 0,  reloadFactor: 1.1, ignites: false },
	grape:  { label: "Grape & canister",hint: "a bag of slugs — deadly at pistol shot",  hullFactor: 0.55, sailShare: 1.0, rangeFactor: 0.45, coneBonus: 26, reloadFactor: 0.5, ignites: false },
	heated: { label: "Heated shot",    hint: "red-hot ball — sets the rigging alight",   hullFactor: 0.85, sailShare: 1.0, rangeFactor: 1.0,  coneBonus: 0,  reloadFactor: 1.2, ignites: true },
};

export const AMMO_KEYS: AmmoType[] = ["round", "chain", "grape", "heated"];

/** Hull hitbox radius (world units) per class, used for the broadside solve. */
export const SHIP_RADIUS: Record<ShipClass, number> = {
	starter_sloop: 6, raider_sloop: 7, raider_brig: 9, brigantine: 10,
	merchant: 10, galleon: 13, war_galleon: 15, imperial: 17,
};

/**
 * Solid-hull footprint for ship-ship collision, shared by the server (which
 * separates hulls) and any client that needs to reason about it. A hull is a
 * CAPSULE: a line segment of `HULL_HALF_LENGTH` along the heading, rounded out
 * by `HULL_HALF_BEAM`. A circle alone can't represent a long, thin ship — it
 * either lets bows sail straight through (radius too small) or builds invisible
 * walls beam-to-beam (radius too big). These mirror the GLB model lengths in
 * src/game/entities/ShipModels.ts so the collision matches what is drawn.
 */
export const HULL_HALF_LENGTH: Record<ShipClass, number> = {
	starter_sloop: 10, raider_sloop: 12, raider_brig: 14, brigantine: 17,
	merchant: 18, galleon: 22, war_galleon: 26, imperial: 30,
};

/** Half-beam (rounded capsule radius) per class. Sailing hulls are ~L:3 beam. */
export const HULL_HALF_BEAM: Record<ShipClass, number> = {
	starter_sloop: 3, raider_sloop: 3.5, raider_brig: 4, brigantine: 4.5,
	merchant: 5.5, galleon: 6, war_galleon: 6.5, imperial: 7.5,
};

/**
 * A live player→player SELL ORDER on the off-chain trading post. This is the
 * "list an item, set your own price, another player buys it" market — priced and
 * settled entirely OFF-chain in cargo units (the in-world purse), so it needs no
 * contract and never touches chain finality. The seller's goods are escrowed with
 * the server when the order is posted (deducted from their ledger up front), so
 * a buy is an atomic server-side swap: buyer's purse → seller's purse, escrowed
 * goods → buyer's ledger.
 */
export interface TradeListing {
	/** Server-assigned order id (decimal string). */
	id: string;
	/** Seller wallet address (lower-cased). */
	seller: string;
	/** What is on offer: a stack of cargo, or a shop item by id. */
	kind: "cargo" | "item";
	/** Shop item id when `kind === "item"`. */
	itemId?: string;
	/** Units (cargo) or count (item) committed to the order. */
	qty: number;
	/** Ask price, in cargo units off the buyer's purse. Set by the seller. */
	price: number;
}

// ---------------------------------------------------------------------------
// Off-chain economy: canonical ports, treasure POIs, faction reputation.
// These are OFF-chain by design (the hard line: only mint/loot/bounty/auction/
// alliance touch the chain). The lists are constants shared by BOTH the server
// (which gates docking and resolves treasure) and the client (which draws the
// markers and opens the dock menu), so neither side has to replicate the other
// and the two can never drift on WHERE a port or a buried cache actually is.
// ---------------------------------------------------------------------------

export interface PortDef {
	id: number;
	name: string;
	x: number;
	z: number;
	/** Who nominally runs this port; sinking ships there is a provocation. */
	faction: Faction;
}

export interface PoiDef {
	id: number;
	x: number;
	z: number;
	/** Cargo units buried here; claimed once by the first hull to reach it. */
	cargo: number;
	/** Cache type: "cargo" is an ordinary off-chain purse payout (the default);
	 *  "rare" is a world-shard treasure that also MINTS an on-chain loot NFT to
	 *  the digger's wallet (the only POI kind that touches the chain). */
	kind: "cargo" | "rare";
	/** Loot tier minted for a "rare" cache (maps to LootMint's tier argument). */
	tier: number;
}

/**
 * Named salvage materials (task #139) — a PARALLEL resource track to the
 * abstract "cargo" purse. Where cargo is fungible money, materials are the raw
 * timber, iron and canvas a wreck breaks up into, and hull upgrades consume them
 * IN ADDITION to their cargo-purse price. Kept lenient: materials make upgrades
 * feel earned but never hard-gate them (see `buyItem` on the server, which still
 * completes with no materials by auto-buying them off the purse).
 */
export type SalvageMaterial = "wood" | "iron" | "cloth";

/** A player's banked salvage materials, one count each. */
export type SalvageLedger = Record<SalvageMaterial, number>;

export const SALVAGE_MATERIALS: SalvageMaterial[] = ["wood", "iron", "cloth"];

/**
 * The salvage yield of a wreck, split by material. The `cargo` figure is what
 * the debris field is worth as money (the existing abstract unit); the
 * `materials` breakdown is what physically lifts out of it — small amounts,
 * weighted by the victim's ship class (a war galleon sheds iron, a merchant
 * sheds timber and canvas). Both ride the same record so the server resolves the
 * sink/dive once and the client + HUD read exactly what landed.
 */
export interface MaterialYield {
	wood: number;
	iron: number;
	cloth: number;
}

/**
 * Per-class salvage material yield weights. Big warships shed IRON (plating,
 * guns), merchants and galleons shed WOOD (deep timber hulls, cargo fittings),
 * light sail-rigged hulls shed CLOTH (large canvas). Amounts are intentionally
 * small — this seeds a slow material economy, not a flood. Server computes these
 * at the wreck's spawn and applies them on the dive/pillage.
 */
export const SALVAGE_YIELD_BY_CLASS: Record<ShipClass, MaterialYield> = {
	starter_sloop: { wood: 1, iron: 0, cloth: 2 },
	raider_sloop: { wood: 1, iron: 1, cloth: 3 },
	raider_brig: { wood: 3, iron: 2, cloth: 2 },
	brigantine: { wood: 3, iron: 2, cloth: 3 },
	merchant: { wood: 5, iron: 1, cloth: 2 },
	galleon: { wood: 7, iron: 3, cloth: 2 },
	war_galleon: { wood: 5, iron: 7, cloth: 2 },
	imperial: { wood: 6, iron: 10, cloth: 3 },
};

/**
 * How a salvage amount scales with the cargo actually taken from that source.
 * The victor's plunder and a dove wreck both yield materials PROPORTIONAL to the
 * cargo they moved (so a bigger prize is worth more scrap), floored at zero and
 * rounded down. `weight` is the class's `SALVAGE_YIELD_BY_CLASS` figure.
 */
export function salvageYieldFor(cls: ShipClass, cargo: number): MaterialYield {
	const w = SALVAGE_YIELD_BY_CLASS[cls];
	// A handful of cargo is the reference "one full share" — scale gently so a
	// small skim still pays a bit and a fat hold pays the class weight, not more.
	const share = Math.max(0, Math.floor(cargo)) / 20;
	return {
		wood: Math.round(w.wood * share),
		iron: Math.round(w.iron * share),
		cloth: Math.round(w.cloth * share),
	};
}

/** Total cargo-purse cost to auto-buy a shortfall of materials (shop.ts hook). */
export const PURCHASE_MATERIALS = true;

/**
 * A salvageable debris field left where a hull went down. OFF-chain by design
 * (like buried caches). When a hull sinks, the cargo the victor could NOT take
 * (its hold was full, or there was no victor at all — a storm founder) settles
 * on the sea floor here instead of vanishing, so a rival captain who sails over
 * the wreck can dive it. Any hull within SALVAGE_RADIUS uncovers it once, first
 * come first served; the field then scatters after WRECK_TTL_S. `x`/`z` are the
 * position it sits at (a wreck does not move); `cargo` is what it is worth;
 * `materials` is the typed scrap that physically lifts out of it (task #139).
 */
export interface Wreck {
	id: number;
	x: number;
	z: number;
	cargo: number;
	/** Typed salvage breakdown banked on the dive (additive to `cargo`). */
	materials: MaterialYield;
}

/** Radius (world units) inside which a ship counts as "docked" at a port. */
export const PORT_RADIUS = 140;
/** Radius inside which a hull uncovers a treasure POI. */
export const POI_RADIUS = 60;

/** Four named trading ports, spread so a sail always has a destination. */
export const PORT_DEFS: PortDef[] = [
	{ id: 0, name: "Tortuga Reach", x: 900, z: 300, faction: "pirate" },
	{ id: 1, name: "King's Landing Bay", x: -1100, z: -800, faction: "naval" },
	{ id: 2, name: "Amber Company Dock", x: 800, z: -900, faction: "merchant" },
	{ id: 3, name: "Freeport Hollow", x: -700, z: 600, faction: "merchant" },
];

/** Buried caches scattered across the sea — the off-chain treasure the loop
 *  rewards. Most are ordinary cargo; a few rare caches also mint an on-chain
 *  loot NFT to whoever digs them (the chain-touching POIs). */
export const POI_DEFS: PoiDef[] = [
	{ id: 0, x: 1500, z: -200, cargo: 45, kind: "cargo", tier: 0 },
	{ id: 1, x: 300, z: 1400, cargo: 60, kind: "cargo", tier: 0 },
	{ id: 2, x: -1500, z: 200, cargo: 40, kind: "rare", tier: 2 },
	{ id: 3, x: 0, z: -1500, cargo: 55, kind: "cargo", tier: 0 },
	{ id: 4, x: -250, z: 250, cargo: 25, kind: "cargo", tier: 0 },
	{ id: 5, x: 520, z: 520, cargo: 30, kind: "cargo", tier: 0 },
	{ id: 6, x: -1800, z: -1400, cargo: 70, kind: "rare", tier: 3 },
	{ id: 7, x: 1900, z: 1500, cargo: 65, kind: "cargo", tier: 0 },
];

/**
 * Shallow reef/shoal fields — the asymmetric hazard of the coast. A reef is a
 * disc of water too shallow for a deep-draught hull: light sloops skim straight
 * across it, mid ships slow hard, and heavy galleons RUN AGROUND (nearly stop
 * and grind out their keel). It is why a warship cannot chase a sloop through
 * the shoals — the shallow sea is the little ship's ally. The server grounds
 * hulls by `hullMax` draught; the client paints each as a pale turquoise shelf
 * ringed with breakers so you can see the hazard before you commit to it.
 */
export interface Reef {
	id: number;
	name: string;
	x: number;
	z: number;
	radius: number;
}
export const REEF_DEFS: Reef[] = [
	{ id: 0, name: "The Teeth", x: 420, z: -360, radius: 155 },
	{ id: 1, name: "Bone Shoal", x: -340, z: 940, radius: 175 },
	{ id: 2, name: "Amber Shoals", x: 1240, z: 640, radius: 165 },
	{ id: 3, name: "Grey Ledge", x: -1020, z: -140, radius: 150 },
	{ id: 4, name: "Midground Reef", x: 60, z: -1180, radius: 170 },
];

/**
 * Destructible shore forts — the naval-boss arena. A fort is a static, heavily
 * armed landmass battery that contests its harbour: while its mortar tower
 * stands it looses cannon volleys at any hostile hull that comes within range,
 * and it can only be silenced by bombardment from the sea. There is no on-foot
 * phase; you fight it the way you fight a ship — bring it broadside.
 *
 * The fort is modelled as four separately-destructible SECTIONS, which is what
 * makes it a puzzle and not a health bar:
 *   northWall / southWall  — the bastions shield the magazine. While BOTH still
 *                            stand, incoming shot is absorbed by the walls, so you
 *                            must batter them down before the real prize is exposed.
 *   mortarTower            — the gun that fires on you. Kill it and the fort goes
 *                            silent even though the magazine may still stand.
 *   powderMagazine         — the boss core. Only once both walls fall does it take
 *                            damage; put it at zero and the whole fort DETONATES in
 *                            a chain explosion that also damages any hull riding too
 *                            close to the beach.
 */
export type FortSectionKey = "northWall" | "southWall" | "mortarTower" | "powderMagazine";

export interface FortDef {
	id: number;
	name: string;
	x: number;
	z: number;
	/** Aim-cone radius (world units) for bombarding the fort as a target. */
	radius: number;
	/** The fort's own gunnery, mirroring a ship class's broadside fields. */
	range: number;
	reloadSeconds: number;
	shellSpeed: number;
	broadsideDamage: number;
	/** Starting (and max) hull of each section. */
	max: Record<FortSectionKey, number>;
	/** Blast radius + damage of the magazine detonation. */
	blastRadius: number;
	blastDamage: number;
}

export const FORT_DEFS: FortDef[] = [
	{
		id: 0,
		name: "Fort of the Bay",
		// A fortified islet STANDING OFF the naval harbour rather than on top of it.
		// It used to share King's Landing Bay's exact centre, so the real (large)
		// battery mesh intersected the harbour island — assets must never pass
		// through each other. This seat is clear of every port island + the scatter's
		// keep-out, yet close enough to read as the bay's defending fort.
		x: -1480,
		z: -940,
		radius: 46,
		range: 320,
		reloadSeconds: 5,
		shellSpeed: 70,
		broadsideDamage: 22,
		max: { northWall: 160, southWall: 160, mortarTower: 120, powderMagazine: 140 },
		blastRadius: 190,
		blastDamage: 70,
	},
];

/** A fort's live, server-authoritative state, broadcast in every snapshot so the
 *  client can crumble each section as it takes damage and play the detonation. */
export interface FortState {
	id: number;
	/** Current hull of each section (0 = destroyed). */
	hp: Record<FortSectionKey, number>;
	/** True once the magazine has gone up — the fort is a smoking ruin. */
	defeated: boolean;
}

/** -100 (outlaw) .. +100 (hero) standing with one faction. */
export type ReputationMap = Record<Faction, number>;

export const REP_CAP = 100;

/**
 * One live player→player hull auction, as tracked by the server registry. The
 * AUTHORITATIVE bid state (current high bid, winner) lives ON-CHAIN in the
 * ShipAuction house and is read straight from the chain by whoever opens a row;
 * the server only maintains the *roster* of open listings so a player can browse
 * what rivals have put up without indexing chain events. `endsAt` is unix seconds,
 * so clients can both sort the list and expire stale rows locally.
 */
export interface AuctionListing {
	/** On-chain auctionId (decimal string over the wire). */
	auctionId: string;
	/** ERC-721 tokenId being auctioned (decimal string). */
	tokenId: string;
	/** Seller wallet address (lower-cased). */
	seller: string;
	/** Hull class, so the browser shows what's on the block. */
	shipClass: ShipClass;
	/** Unix seconds when the lot closes. */
	endsAt: number;
}

/**
 * One row on the live Most-Wanted board — the head-hunting marquee. It is the
 * server's OFF-chain roll-up of every bounty currently escrowed against a hull,
 * so every player can see who the sea is paying to have killed without indexing
 * chain events. `tokenId` is the targeted hull; `amount` is the USDG escrowed
 * against it in base units (summed if several bounties sit on the same hull);
 * `name`/`shipClass` describe the hull so the board reads like a poster, not a
 * hex id. The authoritative payout still settles on-chain; this is the display.
 */
export interface WantedEntry {
	tokenId: string;
	amount: string;
	name: string;
	shipClass: ShipClass;
}

/**
 * A real-time parley / surrender demand between two PLAYER hulls (off-chain, no
 * contract). One captain demands terms of another within hailing range; the
 * targeted captain has a short window to accept (strike their colors: hand over
 * `demand` cargo units from the hold and be spared under a brief truce) or
 * decline (fight on). This is the alternative to a sink: the attacker takes the
 * cargo WITHOUT destroying the hull, and the defender keeps their ship but loses
 * their hold. Everything here is realtime and settles off-chain.
 */
export interface ParleyOffer {
	/** Runtime id of the hull being asked to surrender (the defender). */
	defenderShipId: string;
	/** Runtime id of the hull demanding terms (the attacker). */
	attackerShipId: string;
	/** Display name of the attacker, so the prompt can name who hails you. */
	attackerName: string;
	/** Cargo units the attacker demands from the defender's hold. */
	demand: number;
	/** Seconds the offer stays live before it lapses. Both prompts self-close on
	 *  this clock so a vanished/sunk counterpart can never leave a stuck dialog. */
	ttlSeconds: number;
}

/**
 * The outcome of a parley, sent to BOTH hulls so each can toast what happened.
 * `accepted` = the defender paid the toll and a truce began; the `moved` figure is
 * the actual cargo that changed hands (may be less than the demand if the hold
 * came up short). `attackerShipId`/`defenderShipId` identify the parties.
 */
export interface ParleyResolved {
	accepted: boolean;
	attackerShipId: string;
	defenderShipId: string;
	/** Cargo units handed over (0 when declined). */
	moved: number;
}

/** Human-readable reason a parley action was refused, so the client can toast it. */
export type ParleyFailReason =
	| "gone" // one of the hulls sank, left, or was never there
	| "self" // tried to hail your own hull
	| "ally" // same owner — you do not demand terms of your own fleet
	| "range" // target is out of hailing (cannon) range
	| "empty" // target carries no cargo worth demanding
	| "full" // your own hold is full — nowhere to stow the toll
	| "stale"; // the offer already lapsed or was answered

/** A player's OFF-chain ledger: banked cargo, standing with each faction, and
 *  the runtime hulls currently sailing as their auto-mode ghost fleet. */
export interface PlayerPublicState {
	address: string;
	purse: number;
	reputation: ReputationMap;
	fleet: string[];
	/** Owned outfitting goods: item id -> quantity bought (from `./shop.ts`). */
	items: Record<string, number>;
	/** The currently-equipped item id per shop slot, or null for an empty slot. */
	equipped: Record<string, string | null>;
	/** Banked salvage materials (task #139), the parallel resource to `purse`. */
	materials: SalvageLedger;
}

// ---------------------------------------------------------------------------
// Weather — ONE authoritative scalar set read by BOTH VFX and physics.
// This is what makes weather a mechanic, not just visuals (design spec).
// ---------------------------------------------------------------------------

export interface WeatherState {
	/** Normalised wind direction on the XZ plane. */
	wind: { x: number; z: number };
	windSpeed: number;
	waveAmplitude: number;
	fogDensity: number;
	rainIntensity: number;
	cloudCoverage: number;
	lightningFrequency: number;
}

// ---------------------------------------------------------------------------
// Client -> Server messages
// ---------------------------------------------------------------------------

export interface HelmInput {
	/** -1..1 throttle (sail set / engine equivalent). */
	throttle: number;
	/** -1..1 rudder. */
	rudder: number;
}

export type ClientToServer =
	| {
			t: "join";
			payload: {
				clientPlayerId: string;
				displayName: string;
				/** On-chain wallet address that owns this player's hulls, so the
				 *  server can bind a runtime ship to an on-chain owner for bounty
				 *  settlement. Optional until the client connects a wallet. */
				address?: string;
				/** ERC-721 tokenId (decimal string) of the on-chain hull this session
				 *  sails, when the player has bought one. Binding it lets the server
				 *  key bounty claims and ship provenance on the exact hull rather than
				 *  the owner wallet. Optional until a hull is bought/selected. */
				tokenId?: string;
			};
	  }
	| { t: "input"; payload: { shipId: string; helm: HelmInput; aim?: Heading } }
	| { t: "fire"; payload: { shipId: string; turretHeading: Heading; ammo?: AmmoType } }
	| {
			/** Bind the connected wallet (and, once known, the on-chain hull tokenId it
			 *  sails) to this client's runtime ship so the server can settle bounties
			 *  to/from it and record provenance on the right tokenId. Sent after the
			 *  wallet connects and again when a hull is bought/selected. */
			t: "chain:bind";
			payload: { address: string; tokenId?: string };
	  }
	| {
			t: "chain:bountyPosted";
			payload: {
				/** BountyEscrow bountyId, returned by the on-chain postBounty tx. */
				bountyId: number;
				/** ERC-721 tokenId of the targeted hull (decimal string over the wire). */
				tokenId: string;
				/** Declarer wallet address (excluded from claiming). */
				declarer: string;
				/** Escrowed USDG in base units (decimal string). */
				amount: string;
			};
	  }
	| {
			/** Offload a docked hull's cargo hold into the off-chain purse. */
			t: "dock:unload";
			payload: { shipId: string };
	  }
	| {
			/** Pay cargo from the purse to bring a sunk hull back to service. */
			t: "dock:repair";
			payload: { shipId: string };
	  }
	| {
			/** Send one of your owned hulls out as an auto-mode ghost-fleet trader. */
			t: "fleet:dispatch";
			payload: { tokenId: string; name: string };
	  }
	| {
			/** Move the helm to another of your owned, active hulls: the currently
			 *  sailed hull drops to auto mode and the target becomes player-driven.
			 *  The client retargets its camera/input to the returned shipId. */
			t: "helm:switch";
			payload: { shipId: string };
	  }
	| {
			/** Set this hull's sail ORDER (gear). Canonical helm control (task #138):
			 *  the server maps the gear to a target throttle multiplier + turn
			 *  authority and echoes it back on every snapshot as `ShipState.gear`. */
			t: "helm:gear";
			payload: { shipId: string; gear: SailGear };
	  }
	| {
			/** Convert cargo from the purse into salvage materials at a fixed rate
			 *  (task #139). The lenient "buy materials I don't have" path the shop uses
			 *  when a purchase's cargo covers the price but the hold is short on scrap. */
			t: "salvage:autoBuy";
			payload: { materials: Partial<SalvageLedger> };
	  }
	| {
			/** Announce a live on-chain auction so the server lists it for other
			 *  players to browse + bid on (the bid itself still goes wallet→chain). */
			t: "auction:listed";
			payload: {
				auctionId: string;
				tokenId: string;
				shipClass: ShipClass;
				endsAt: number;
			};
	  }
	| {
			/** Buy an outfitting good with the off-chain cargo purse (server prices
			 *  it authoritatively from the shared shop table; adds one to inventory). */
			t: "shop:buyItem";
			payload: { itemId: string };
	  }
	| {
			/** Put on / take off one owned good in its slot, applying or clearing its
			 *  stat bonus. Free; you must own at least one of the item. */
			t: "shop:equip";
			payload: { itemId: string; equipped: boolean };
	  }
	| {
			/** Post a player→player sell order on the off-chain trading post. The
			 *  seller must be docked and own the goods; the server escrows them (cargo
			 *  qty, or the item stack) out of the seller's ledger at post time. The
			 *  ask price is the seller's own choice, in cargo units. */
			t: "trade:list";
			payload: { kind: "cargo" | "item"; itemId?: string; qty: number; price: number };
	  }
	| {
			/** Cancel one of your own open orders; the escrowed goods return. */
			t: "trade:cancel";
			payload: { orderId: string };
	  }
	| {
			/** Buy an open order: the server checks you are docked and your purse
			 *  covers the ask, then swaps purse→seller and escrow→you atomically. */
			t: "trade:buy";
			payload: { orderId: string };
	  }
	| {
			/** Demand terms of a rival PLAYER hull within hailing range: "strike your
			 *  colors and hand over your hold, or be sunk." The server computes the
			 *  demand and routes the incoming offer to the target's client. */
			t: "parley:demand";
			payload: { targetShipId: string };
	  }
	| {
			/** Accept a live parley demand: hand over the toll and be spared under a
			 *  brief truce. Sent by the DEFENDER (no payload — it answers the offer on
			 *  their own hull). */
			t: "parley:accept";
			payload: Record<string, never>;
	  }
	| {
			/** Refuse a live parley demand; the fight continues. Sent by the DEFENDER. */
			t: "parley:decline";
			payload: Record<string, never>;
	  }
	| { t: "ping"; payload: { sentAt: number } };

// ---------------------------------------------------------------------------
// Server -> Client messages
// ---------------------------------------------------------------------------

/** Why the anti-cheat guard intervened on a hull this tick. */
export type SecurityReason =
	| "helm_clamp" // throttle/rudder sent out of the legal -1..1 range
	| "helm_nan" // non-finite helm (would corrupt the physics integration)
	| "aim_nan" // non-finite aim
	| "ownership" // tried to command a hull the socket does not own
	| "rate_limit"; // input packets faster than the tick allows

/**
 * A server-authoritative anti-cheat notice. The server owns every hull's
 * position, so a client cannot teleport or set a position directly — the only
 * way to cheat movement is to feed the physics illegal inputs (a >1 throttle is
 * a speed hack, a NaN helm corrupts the sim, firing another hull commandeers its
 * guns). The Guard clamps those back to the legal value ("clamp + rollback") and
 * raises a `blocked` event; a hull that keeps offending accumulates a suspicion
 * score and, past the threshold, a `flagged` event naming it on every client.
 */
export interface SecurityEvent {
	/** "blocked" = an illegal input was corrected (routine, per-hull); "flagged"
	 *  = this hull crossed the suspicion threshold and is being watched. */
	t: "blocked" | "flagged";
	shipId: string;
	/** Display name of the offending hull, so the HUD can name it. */
	shipName: string;
	reason?: SecurityReason;
	/** Running suspicion score for this hull, 0..100. */
	score: number;
}

export type CombatEvent =
	| { t: "muzzleFlash"; shipId: string }
	/** An authoritative shell launch. Endpoints are pre-solved by the server so
	 *  the client draws the exact arc it resolves — no client-side hit logic. */
	| {
			t: "shot";
			shipId: string;
			origin: Vec3;
			/** The point the shell resolves at (impact or splash), pre-computed. */
			impactPoint: Vec3;
			/** Seconds in flight; the client animates the parabola over this. */
			flightTime: number;
			/** True if the server has already committed to a hull hit. */
			hit: boolean;
			/** Which bow-relative arc loosed this shot (drives tracer/VFX). */
			weapon?: WeaponType;
	  }
	| { t: "hullImpact"; targetId: string; point: Vec3; damage: number }
	| { t: "waterImpact"; point: Vec3 }
	| { t: "sunk"; shipId: string; killerShipId?: string }
	/** A hull came back from the dead at a dock. `patched` is true for the
	 *  emergency-patch path (the owner couldn't cover a full refit and sailed away
	 *  battered) — the client toasts the two outcomes differently. */
	| { t: "repair"; shipId: string; patched: boolean }
	/** A player shell that found a fort section: the client crumbles that piece. */
	| { t: "fortImpact"; fortId: number; section: FortSectionKey; point: Vec3; damage: number }
	/** The magazine went up — play the full-fort chain detonation. */
	| { t: "fortDetonate"; fortId: number; point: Vec3 };

export type ServerToClient =
	| {
			t: "welcome";
			payload: { selfShipId: string; tickRateHz: number; worldSeed: number };
	  }
	| {
			t: "snapshot";
			payload: {
				tick: number;
				/** Server wall-clock ms when the snapshot was produced; the
				 *  client interpolates remote ships against this clock. */
				serverTimeMs: number;
				ships: ShipState[];
				weather: WeatherState;
				/** Salvageable debris fields THIS viewer can legally sight (culled by
				 *  the same weather-visibility range as ships). */
				wrecks: Wreck[];
				/** Live state of every shore fort (always sent — they are landmarks
				 *  like harbours, visible from across the sea, not distance-culled). */
				forts: FortState[];
			};
	  }
	| { t: "spawn"; payload: { ship: ShipState } }
	| { t: "despawn"; payload: { shipId: string } }
	| {
			/** Ack to a helm:switch: the server has moved this client's control to the
			 *  target hull (old hull dropped to auto). Client retargets selfShipId. */
			t: "helm:switched";
			payload: { shipId: string };
	  }
	| { t: "combat"; payload: CombatEvent }
	| { t: "security"; payload: SecurityEvent }
	| {
			t: "chain:bountyClaimed";
			payload: { bountyId: number; claimant: string; txHash: string; amount: string };
	  }
	| {
			/** A player's off-chain ledger (purse, faction standing, ghost fleet).
			 *  Sent to the owning client on connect and whenever it changes. */
			t: "player:state";
			payload: { state: PlayerPublicState };
	  }
	| {
			/** A hull uncovered a buried cache: broadcast so every client can pop
			 *  the marker and show the loot. */
			t: "poi:claimed";
			payload: { poiId: number; shipId: string; cargo: number };
	  }
	| {
			/** A hull sailed over a debris field and dove it: broadcast so every client
			 *  drops that wreck marker, and the salver sees the haul. OFF-chain. */
			t: "salvage:claimed";
			payload: { wreckId: number; shipId: string; cargo: number; materials: MaterialYield };
	  }
	| {
			/** The full live roster of player→player auctions (see AuctionListing).
			 *  Sent to a client on connect and re-broadcast whenever a lot is added. */
			t: "auction:list";
			payload: { auctions: AuctionListing[] };
	  }
	| {
			/** The live Most-Wanted board: every hull with a bounty escrowed against
			 *  it, ranked by payout. Sent on connect and re-broadcast whenever a
			 *  bounty is posted or a wanted hull sinks. */
			t: "bounty:board";
			payload: { wanted: WantedEntry[] };
	  }
	| {
			/** The live player→player trading-post roster (off-chain sell orders). Sent
			 *  on connect and re-broadcast whenever an order is posted, bought, or
			 *  cancelled. */
			t: "trade:orders";
			payload: { orders: TradeListing[] };
	  }
	| {
			/** A rival is demanding terms of YOUR hull — show the strike-your-colors
			 *  prompt (Accept pays the toll + truce; Decline fights on). Sent only to
			 *  the defender. */
			t: "parley:incoming";
			payload: ParleyOffer;
	  }
	| {
			/** Your demand has been put to the target and awaits their answer. Sent only
			 *  to the attacker, so their prompt can show a "terms demanded" state. */
			t: "parley:asked";
			payload: { defenderShipId: string; defenderName: string; demand: number; ttlSeconds: number };
	  }
	| {
			/** A parley resolved — sent to BOTH hulls. `accepted` pays the toll under a
			 *  truce; otherwise the fight continues. `moved` is the cargo transferred. */
			t: "parley:resolved";
			payload: ParleyResolved;
	  }
	| {
			/** A parley action you attempted was refused. Sent only to the requester. */
			t: "parley:failed";
			payload: { reason: ParleyFailReason };
	  }
	| { t: "error"; payload: { code: string; message: string } };

// ---------------------------------------------------------------------------
// Constants shared by both sides
// ---------------------------------------------------------------------------

export const TICK_RATE_HZ = 20;
export const TICK_INTERVAL_MS = Math.round(1000 / TICK_RATE_HZ);
/**
 * Playable sea radius. The client ocean grid follows the camera, so this is a
 * movement bound rather than a visible edge — but it MUST stay within the range
 * the seeded island field covers (IslandSystem scatters land out to ~2750). The
 * old 5000 left a 2400-unit barren ring at the rim, which is why long sail legs
 * read as featureless open water. Keep this just outside ISLAND_R_MAX.
 */
export const WORLD_SEA_RADIUS = 2900;

// On-chain config (`./onchain.ts`) and the auto-generated contract ABIs
// (`./abis.ts`) are consumed DIRECTLY by name, not re-exported through this
// barrel. Two resolution regimes share this package — the browser is bundled by
// Turbopack (`moduleResolution: bundler`, which does not rewrite a relative
// `.js` specifier to its `.ts` source) and the server is compiled by `tsc` under
// `moduleResolution: NodeNext` (which *requires* that `.js`). A single `export *`
// edge here can satisfy one and break the other, so both sides import these two
// modules at their own extension convention instead of funneling them through
// this file.
