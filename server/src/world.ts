import {
	type ShipState,
	type WeatherState,
	type HelmInput,
	type Heading,
	type CombatEvent,
	type ShipClass,
	type Vec3,
	type Faction,
	type ReputationMap,
	type PlayerPublicState,
	type WantedEntry,
	type TradeListing,
	type ParleyOffer,
	type ParleyResolved,
	type ParleyFailReason,
	type Wreck,
	SHIP_CLASSES,
	SHIP_RADIUS,
	SAIL_DAMAGE_FRACTION,
	type WeaponType,
	WEAPONS,
	weaponForAim,
	type AmmoType,
	AMMO,
	BURN_DPS,
	BURN_SECONDS,
	HULL_HALF_LENGTH,
	HULL_HALF_BEAM,
	WORLD_SEA_RADIUS,
	PORT_DEFS,
	POI_DEFS,
	REEF_DEFS,
	FORT_DEFS,
	type FortDef,
	type FortState,
	type FortSectionKey,
	PORT_RADIUS,
	POI_RADIUS,
	REP_CAP,
	type SailGear,
	SAIL_GEARS,
	gearForThrottle,
	type SalvageMaterial,
	type SalvageLedger,
	type MaterialYield,
	salvageYieldFor,
} from "../../shared-types/index.js";
import { SHOP_ITEMS, SLOT_STAT, shopItemById, type ShopSlot, materialBuyPrice } from "../../shared-types/shop.js";

/**
 * Authoritative world. Owns every ship + the shared WeatherState and steps the
 * simulation forward one fixed tick. Clients never move ships themselves — they
 * send intent (HelmInput) and reconcile to the snapshots we broadcast.
 *
 * SCAFFOLD: physics here is a deliberately simple model. The full Gerstner
 * sail-force / current / wave model lives client-side in src/game/ocean + is
 * mirrored here once gameplay is green-lit for real.
 */

/** Top speed (world units/s) of a hull at fully-set sails with perfect trim. */
const MAX_SPEED = 14;
/** Speed a sunk, player-owned hull drifts toward the nearest port under tow. */
const TOW_SPEED = 6;
/** Seconds for the rigging to reach ~63% of the commanded speed. */
const SAIL_RESPONSE_S = 1.6;
/**
 * Rudder authority. A rudder is a hydrofoil: it generates side force from the
 * water flowing past it, so its authority scales with speed through the water.
 * At a standstill it does nothing at all — that is "no steerage way", and it is
 * why a becalmed sailing ship cannot be steered however hard you spin the wheel.
 */
const RUDDER_MAX_TURN_RATE = 0.55; // rad/s at full speed, full helm
/** Speed at which the rudder reaches full authority (fraction of MAX_SPEED). */
const RUDDER_FULL_AUTHORITY = 0.55;
/** Below this speed the rudder is effectively dead (no steerage way). */
const STEERAGE_MIN_SPEED = 0.35;
/**
 * Seconds for the hull to answer the helm. A ship is not a car: the rudder
 * moves instantly but the HULL takes time to swing, and once turning it carries
 * that momentum until counter-rudder stops it.
 */
const YAW_RESPONSE_S = 1.9;

/**
 * Seconds for the VELOCITY vector to swing onto the bow line. The rudder swings
 * the hull (yaw) but a ship's momentum keeps it travelling briefly along its OLD
 * heading — that lag is "leeway", and it is why a hull carves a wide, drifting
 * arc through a turn instead of pivoting like a slot car. Without it the ship
 * moves exactly where it points, which reads as a car on rails no matter how the
 * yaw is tuned. Longer = heavier/more schooning; shorter = more responsive.
 */
const LEEWAY_RESPONSE_S = 1.5;

/** Per-ship simulation state that is NOT part of the wire format. */
interface ShipSim {
	/** Commanded sail setting, -1..1, held between ticks. */
	throttle: number;
	/** Commanded rudder angle, -1..1, held between ticks. */
	rudder: number;
	/**
	 * The active sail ORDER (gear), or null while the hull is driven by the raw
	 * analog throttle (gamepad / touch). When non-null it is the canonical control:
	 * `step()` derives both the target throttle AND a turn-authority factor from
	 * `SAIL_GEARS[gear]`, so "travel" trades helm response for top speed. Set by the
	 * `helm:gear` message; an analog-only hull keeps this null.
	 */
	gear: SailGear | null;
	/** Current forward speed through the water. Eases toward the commanded
	 *  speed so a ship leans into its acceleration instead of snapping to full
	 *  throttle the instant W goes down. */
	speed: number;
	/** Current yaw rate (rad/s). Eases toward the rudder's command so the hull
	 *  carries its turn instead of pivoting instantly. */
	yawRate: number;
	/** sim-time stamp of the last broadside; gates the reload cooldown. */
	lastFireAt: number;
	/** sim-time until which this hull burns (a fire-barrel hit). 0 = not alight. */
	burnUntil: number;
	/** Current sailing goal for an auto-mode hull; null for player-driven ships. */
	dest: Vec3 | null;
	/** Whether the hull was inside a port radius last tick (edge-detects arrivals
	 *  so an auto trader only banks its cargo once per dock, not every tick). */
	atPort: boolean;
	/** For a dispatched ghost-fleet trader: the two PORT_DEFS indices it plies
	 *  between as a DEFINED run (index into PORT_DEFS), swapped each time it
	 *  reaches the active end. null for ambient NPC traffic, which free-cruises. */
	routeA: number;
	routeB: number;
}

/** Hull points a storm strips per second from an exposed, full-sail hull AT THE
 *  CREST of a storm (scaled by storm intensity and how much sail is set). Weather
 *  is a mechanic, not a death sentence: this is deliberately gentle so a storm is
 *  a hazard you manage (reef the sails, run for port) rather than a wall that
 *  grinds a healthy hull down in seconds. */
const STORM_DAMAGE_PER_SEC = 1.1;

/**
 * Naval standing at or below which a captain is "wanted": warships actively hunt
 * them, not just pirates. Sinking merchants drags a player's naval rep here, so
 * predation on trade draws the navy down on YOU — the causal hunt the spec asks
 * for, layered on top of the navy's standing feud with pirates.
 */
const NAVAL_OUTLAW_REP = -25;

/** Seconds between Kraken surfacings — a rare, scheduled world event, not per-raid. */
const KRAKEN_PERIOD_S = 240;

/** A player's OFF-chain ledger, keyed by lower-cased wallet address. */
interface PlayerRecord {
	purse: number;
	reputation: ReputationMap;
	/** Runtime ids of this owner's hulls currently sailing in auto mode. */
	fleet: string[];
	/** Owned outfitting goods: item id -> quantity. */
	items: Record<string, number>;
	/** Equipped item id per shop slot, or null when that slot is empty. */
	equipped: Record<string, string | null>;
	/**
	 * Banked salvage materials (task #139) — the parallel resource track to
	 * `purse`. Earned by pillaging a prize and diving wrecks, spent (leniently) by
	 * hull upgrades. Mirrored to the owning client on `player:state`.
	 */
	materials: SalvageLedger;
	/**
	 * Sunk hulls awaiting repair (sunk ≠ burned). Ships are otherwise transient —
	 * NPCs reseed and player hulls re-join on their socket — but this durable
	 * debt means a rejoin after a full server restart hands the captain back
	 * their wreck at a harbour (still `sunk_needs_repair`), NOT a free, fully
	 * armed hull. Cleared when the hull is repaired at a dock.
	 */
	repairDebt: RepairDebt[];
}

/** A player-owned hull that went down and has not been bought back into service. */
interface RepairDebt {
	name: string;
	shipClass: ShipClass;
	tokenId?: string;
}

/** One non-combat world update the server loop turns into a wire message. */
export type MetaEvent =
	| { kind: "player"; address: string }
	| {
			kind: "poi";
			poiId: number;
			shipId: string;
			cargo: number;
			/** Rare caches also mint an on-chain loot NFT to the digger's wallet. */
			rare: boolean;
			tier: number;
			ownerAddress?: string;
	  }
	| {
			/** A hull dove a debris field — an OFF-chain cargo payout (no chain). */
			kind: "salvage";
			wreckId: number;
			shipId: string;
			cargo: number;
			/** Typed scrap that came up with it (task #139). */
			materials: MaterialYield;
	  };

/**
 * Reputation swing applied to the VICTOR's owner when they sink a hull of each
 * faction. Sinking a warship wins you standing with its own side's rivals and
 * costs you with its allies; plundering a merchant is piracy everyone else
 * quietly frowns on except the pirates.
 */
const REP_ON_SINK: Record<Faction, Partial<ReputationMap>> = {
	pirate: { pirate: 4, naval: -8, merchant: -2 },
	naval: { naval: 4, pirate: -8, merchant: -2 },
	merchant: { pirate: 6, naval: -4, merchant: -8 },
};

/** An in-flight shell. The server owns the whole arc and pre-solves where it
 *  resolves, so the client only has to draw the parabola it is told. */
interface Projectile {
	ownerId: string;
	targetId: string | null;
	origin: Vec3;
	impactPoint: Vec3;
	/** sim-time at launch and total flight; elapsed = now - launchedAt. */
	launchedAt: number;
	flightTime: number;
	/** True when the server has committed to a hull hit (drives the impact VFX). */
	hit: boolean;
	damage: number;
	/** Which bow-relative arc loosed this shell (drives resolve + tracer colour). */
	weapon: WeaponType;
	/** Fraction of `damage` that tears rigging vs the frames (weapon-specific). */
	sailShare: number;
	/** Fire barrels: a hull hit ignites the target. */
	ignites: boolean;
	/** Set when this shell is aimed at a shore fort (id) rather than a hull:
	 *  resolves against the fort's sections in stepProjectiles. */
	fortTarget?: number;
}

/**
 * Runtime state for a shore fort. Sections hold current hull; `defeated` latches
 * once the magazine detonates (nothing fires or takes damage after). Keyed by the
 * FORT_DEFS id. Fort geometry is static on the client from FORT_DEFS; only this
 * dynamic hp rides the snapshot.
 */
interface FortRuntime {
	id: number;
	def: FortDef;
	hp: Record<FortSectionKey, number>;
	lastFireAt: number;
	defeated: boolean;
}

/**
 * A live OFF-chain parley: one player hull has demanded terms of another and the
 * demand is awaiting an answer. Keyed by defender ship id in `World.parleys`. The
 * `demand` (cargo units) is fixed at offer time so it can't drift while the
 * defender deliberates; `expiresAt` is sim seconds after which the offer lapses
 * (the client is told the same deadline via the incoming message's ttl).
 */
interface Parley {
	attackerId: string;
	defenderId: string;
	demand: number;
	expiresAt: number;
}

/** Server-side form of a salvage debris field, with its scatter clock. The wire
 *  `Wreck` omits `expiresAt` (clients only need position + value). */
interface WreckRecord {
	id: number;
	x: number;
	z: number;
	cargo: number;
	/** Typed salvage that lifts out on the dive (task #139), weighted by the
	 *  victim class and scaled to `cargo`; the abstract `cargo` stays the money. */
	materials: MaterialYield;
	expiresAt: number;
}

/** Seconds a surrender demand stays open before it lapses. Real-time pressure,
 *  not a standing treaty — the defender must answer while the guns still run. */
const PARLEY_TTL_S = 20;
/** Seconds an ACCEPTED surrender holds both hulls' fire. Quarter is only worth
 *  taking if it buys the spared hull room to get clear; long enough to break off,
 *  short enough that it is a stay-of-execution, not immunity. */
const TRUCE_S = 25;

/** Radius inside which an active hull dove a debris field (same scale as a cache). */
const SALVAGE_RADIUS = 55;
/** Seconds a wreck sits on the sea floor before its debris scatters and it is gone.
 *  Long enough to sail back to a fresh kill-site, short enough to keep the seabed
 *  from silting up with every battle of the session. */
const WRECK_TTL_S = 150;

export class World {
	private ships = new Map<string, ShipState>();
	private sim = new Map<string, ShipSim>();
	private projectiles: Projectile[] = [];
	/** Live shore forts (the naval-boss arenas), keyed by FORT_DEFS id. Rebuilt at
	 *  full strength each boot — like reefs they are static world fixtures, not
	 *  persisted state, so a server restart always re-arms the battery. */
	private forts = new Map<number, FortRuntime>();
	private fortsBuilt = false;
	/** Combat events queued this tick, drained + broadcast by the server loop. */
	private pendingEvents: CombatEvent[] = [];
	/** Non-combat economy updates queued this tick (see MetaEvent). */
	private pendingMeta: MetaEvent[] = [];
	/** OFF-chain player ledgers, keyed by lower-cased wallet address. */
	private players = new Map<string, PlayerRecord>();
	/**
	 * The live Most-Wanted board: USDG bounty escrowed against a hull, keyed by
	 * that hull's on-chain tokenId (decimal string). Mirrors the bounty postings
	 * the server is told about, INDEPENDENT of the relayer, so the board populates
	 * even in a local run with the chain disabled. Summed across repeat postings.
	 */
	private wanted = new Map<string, WantedEntry>();
	/**
	 * The live OFF-chain trading post: player→player sell orders priced in cargo
	 * units, keyed by order id. Goods are escrowed with the server at post time
	 * (deducted from the seller's ledger) and swapped atomically on buy. No chain.
	 */
	private trades = new Map<string, TradeListing>();
	private nextTradeId = 1;
	/**
	 * The live OFF-chain parley board: pending surrender demands, keyed by the
	 * DEFENDER's runtime ship id (one demand per hull at a time — a fresh hail
	 * replaces a stale one). Settled entirely in the sim; no chain. */
	private parleys = new Map<string, Parley>();
	/** Ceasefire windows after an accepted surrender, keyed by the sorted ship-id
	 *  pair -> sim time the truce lapses. While a pair is truced neither hull can
	 *  bring its guns to bear on the other, so quarter is worth accepting. */
	private truces = new Map<string, number>();
	/**
	 * Salvage debris fields on the sea floor, keyed by wreck id. A sunk hull's
	 * untaken cargo settles here for any rival captain to dive (see Wreck). Purely
	 * OFF-chain; transient (never persisted — they scatter within a couple minutes). */
	private wrecks = new Map<number, WreckRecord>();
	private nextWreckId = 1;
	/**
	 * OFF-chain mirror of each hull's lifetime kill count, keyed by on-chain tokenId
	 * (decimal string). The durable truth is recorded on-chain by the relayer; this
	 * rides the snapshot so a provened hull's prestige badge is live with or without
	 * the chain, and persists across restarts (see serialize/restore). */
	private killCounts = new Map<string, number>();
	/** Treasure caches already dug (world-scoped, one-time). */
	private claimedPois = new Set<number>();
	private nextId = 1;
	/** Counts human join-spawns so successive players are placed far apart. */
	private nextSpawnIndex = 0;
	public tick = 0;
	/** Accumulated sim seconds, driving the deterministic weather cycle. */
	private weatherTime = 0;
	/** Current storm envelope 0..1 (set by evolutionWeather); read by gameplay as
	 *  the "how hard the sea is on an exposed hull" factor for storm damage. */
	private stormIntensity = 0;

	/** Runtime id of the live Kraken world-event hull, or null when it is submerged. */
	private krakenId: string | null = null;
	/** Sim-time (weatherTime seconds) of the next Kraken surfacing. */
	private nextKrakenAt = KRAKEN_PERIOD_S;

	/** Single source of truth read by BOTH VFX and gameplay on the client. */
	public weather: WeatherState = {
		wind: { x: 1, z: 0 },
		windSpeed: 6,
		waveAmplitude: 0.6,
		fogDensity: 0.002,
		rainIntensity: 0,
		cloudCoverage: 0.3,
		lightningFrequency: 0,
	};

	spawnShip(init: Partial<ShipState> & { name: string }): ShipState {
		const id = `s${this.nextId++}`;
		const shipClass: ShipClass = init.shipClass ?? "starter_sloop";
		const spec = SHIP_CLASSES[shipClass];
		// An owned hull launches at full strength INCLUDING any equipped plating, so
		// the hullMax bonus is live from spawn (and again on every repair).
		const hullMax = spec.hullMax + (init.ownerAddress ? this.bonusesForAddress(init.ownerAddress).hull : 0);
		const ship: ShipState = {
			id,
			tokenId: init.tokenId,
			ownerAddress: init.ownerAddress,
			name: init.name,
			shipClass,
			faction: init.faction ?? "pirate",
			mode: init.mode ?? "player",
			position: init.position ?? { x: 0, y: 0, z: 0 },
			heading: init.heading ?? 0,
			velocity: { x: 0, y: 0, z: 0 },
			angularVelocity: 0,
			hull: init.hull ?? hullMax,
			sails: init.sails ?? spec.sailsMax,
			cargo: init.cargo ?? 0,
			status: init.status ?? "active",
		};
		// A provened hull re-launches wearing its lifetime kill badge (off-chain
		// mirror of the on-chain provenance), so prestige survives a re-join.
		if (ship.tokenId) ship.kills = this.killCounts.get(ship.tokenId.toString()) ?? 0;
		this.ships.set(id, ship);
		this.sim.set(id, {
			throttle: 0,
			rudder: 0,
			gear: null,
			speed: 0,
			yawRate: 0,
			lastFireAt: -Infinity,
			burnUntil: 0,
			dest: null,
			atPort: false,
			routeA: -1,
			routeB: -1,
		});
		if (ship.ownerAddress) {
			this.ledger(ship.ownerAddress);
			this.queuePlayer(ship.ownerAddress);
		}
		return ship;
	}

	despawnShip(id: string): boolean {
		this.sim.delete(id);
		return this.ships.delete(id);
	}

	/**
	 * A join spawn for a human hull: a DOCKED start at a merchant hub. A fresh
	 * captain begins moored at the pier of a trading harbour, ringed by the
	 * merchant fleet (see IslandSystem's PORT_HUB_SHIPS), not in empty open water —
	 * the AC Black-Flag "you set sail from a busy port" opening. We alternate the
	 * merchant harbours and step each successive join around the harbour mouth on
	 * the golden angle so arrivals never stack. The radius (128) sits just off the
	 * beach (merchant island footprint ~125) and INSIDE PORT_RADIUS (140), so the
	 * "press E to dock" prompt is live the instant you spawn and the merchant shop
	 * is one key away; heading faces OUT to sea so casting off is a straight run.
	 */
	nextPlayerSpawn(): { position: Vec3; heading: number } {
		const k = this.nextSpawnIndex++;
		const GOLDEN_ANGLE = 2.399963229728653; // rad
		const ang = k * GOLDEN_ANGLE;
		const merchantPorts = PORT_DEFS.filter((p) => p.faction === "merchant");
		const port = merchantPorts[k % merchantPorts.length] ?? PORT_DEFS[0];
		const rad = 128;
		const x = port.x + Math.sin(ang) * rad;
		const z = port.z + Math.cos(ang) * rad;
		return { position: { x, y: 0, z }, heading: ang };
	}

	/**
	 * Ground a hull standing in a reef/shoal. Returns the speed multiplier to fold
	 * into the hull's target speed this tick (1 = clear water). Draught is proxied
	 * by hullMax: light sloops skim (0.85), mid ships wallow (0.4), heavy galleons
	 * run aground (0.05) and grind their keel — hull damage floored at 1, so a reef
	 * disables you for an attacker to finish rather than killing you outright.
	 */
	private reefGround(ship: ShipState, dt: number): number {
		for (const r of REEF_DEFS) {
			if (Math.hypot(ship.position.x - r.x, ship.position.z - r.z) > r.radius) continue;
			const draught = SHIP_CLASSES[ship.shipClass].hullMax;
			if (draught >= 300) {
				ship.hull = Math.max(1, ship.hull - 7 * dt);
				return 0.05;
			}
			return draught >= 150 ? 0.4 : 0.85;
		}
		return 1;
	}

	getShip(id: string): ShipState | undefined {
		return this.ships.get(id);
	}

	/**
	 * Resolve which hull a joining socket should command. Three cases, in order:
	 *  1. They already have a hull of this tokenId afloat in the world (an
	 *     accidental double-join, or a socket reconnect before the despawn sweep)
	 *     → hand back that SAME hull, so a refresh never spawns a fresh full one.
	 *  2. They have a durable REPAIR DEBT for this tokenId (their last hull went
	 *     down and was never repaired, possibly across a server restart) → respawn
	 *     the wreck AT ITS RESTING PLACE, still `sunk_needs_repair` with an empty
	 *     hold, so they must tow in and pay `repair()` to sail again. The sunk ≠
	 *     burned penalty SURVIVES the restart; the hull is not handed back free.
	 *  3. A genuinely new hull / first join → a full-strength active spawn.
	 */
	acquireJoinHull(address: string | undefined, tokenId: string | undefined, displayName: string): { ship: ShipState; isNew: boolean } {
		const key = address?.toLowerCase();
		// 1. An owned PLAYER hull already afloat (active, or a wreck still drifting
		//    to harbour) is re-adopted — a reconnect/refresh never spawns a second
		//    one. Prefer an active hull if the owner has both.
		let fallback: ShipState | undefined;
		if (key) {
			for (const s of this.ships.values()) {
				if (s.mode !== "player" || s.ownerAddress?.toLowerCase() !== key) continue;
				if (tokenId && s.tokenId?.toString() !== tokenId) continue;
				if (s.status === "active") return { ship: s, isNew: false };
				if (!fallback) fallback = s;
			}
			if (fallback) return { ship: fallback, isNew: false };
		}

		// 2. No hull in the world (e.g. after a full server restart) but a durable
		//    repair debt exists → respawn the wreck AT ITS LAST PORT, still sunk and
		//    empty, so the captain must tow in and pay `repair()` to sail again.
		if (address) {
			const rec = this.ledger(address);
			const debt = tokenId
				? rec.repairDebt.find((d) => d.tokenId === tokenId)
				: rec.repairDebt.find((d) => d.tokenId === undefined);
			if (debt) {
				const port = PORT_DEFS[0];
				const ship = this.spawnShip({
					name: debt.name || displayName,
					shipClass: debt.shipClass,
					ownerAddress: address,
					tokenId: debt.tokenId ? BigInt(debt.tokenId) : undefined,
					position: { x: port.x, y: 0, z: port.z },
					heading: 0,
					hull: 0,
					sails: 0,
					cargo: 0,
					status: "sunk_needs_repair",
				});
				return { ship, isNew: true };
			}
		}

		// 3. A genuinely new captain → a full-strength active spawn.
		const spawn = this.nextPlayerSpawn();
		const ship = this.spawnShip({
			name: displayName,
			ownerAddress: address,
			tokenId: tokenId ? BigInt(tokenId) : undefined,
			position: spawn.position,
			heading: spawn.heading,
		});
		return { ship, isNew: true };
	}

	/** Bind a wallet address (and optionally the on-chain hull tokenId it sails) to a
	 *  runtime ship, so bounty claims and provenance key on the exact hull. */
	setOwner(id: string, address: string, tokenId?: string): void {
		const ship = this.ships.get(id);
		if (!ship) return;
		ship.ownerAddress = address;
		if (tokenId !== undefined && /^\d+$/.test(tokenId)) {
			ship.tokenId = BigInt(tokenId);
		}
		this.ledger(address);
		this.queuePlayer(address);
	}

	/**
	 * Move the helm to another of this captain's own active hulls — the "own many,
	 * sail one" handover. The hull currently under player control drops to auto
	 * (it becomes a ghost-fleet trader that free-cruises from wherever it sits),
	 * and the target becomes the player-driven ship. Returns the new shipId so the
	 * server can repoint the socket and the client can retarget camera/input.
	 */
	switchHull(address: string, targetShipId: string): { ok: boolean; shipId?: string } {
		const key = address.toLowerCase();
		const target = this.ships.get(targetShipId);
		if (!target || target.ownerAddress?.toLowerCase() !== key || target.status !== "active") {
			return { ok: false };
		}

		// Release any hull this captain currently steers (other than the target).
		for (const s of this.ships.values()) {
			if (s.id === target.id) continue;
			if (s.mode !== "player" || s.ownerAddress?.toLowerCase() !== key) continue;
			s.mode = "auto";
			const sim = this.sim.get(s.id);
			if (sim) {
				sim.throttle = 0;
				sim.rudder = 0;
				sim.dest = null;
			}
		}

		// Take the new hull: clear whatever the autopilot last set so the client's
		// first input lands on a clean helm. Drop any stale gear too — the captain
		// re-orders sail on the new hull from scratch (null = back to analog).
		target.mode = "player";
		target.gear = undefined;
		const sim = this.sim.get(target.id);
		if (sim) {
			sim.throttle = 0;
			sim.rudder = 0;
			sim.gear = null;
			sim.dest = null;
			sim.routeA = -1;
		}
		this.queuePlayer(address);
		return { ok: true, shipId: target.id };
	}

	/** Apply a client's helm intent for this tick (authoritative override). */
	applyInput(id: string, helm: HelmInput, aim?: Heading): void {
		const ship = this.ships.get(id);
		if (!ship || ship.status !== "active") return;
		// The helm sets the RUDDER, not the turn rate. How much that rudder
		// actually turns the hull depends on speed, which step() resolves.
		const sim = this.sim.get(id);
		if (sim) {
			sim.throttle = helm.throttle;
			sim.rudder = helm.rudder;
			// A hull with NO explicit gear engaged (gamepad / touch) is still
			// analog-driven; mirror the throttle to its nearest gear purely so the
			// HUD's sail-order label reads sensibly. Once a gear IS engaged the
			// analog channel no longer moves the ship (step reads the gear), so we
			// leave `ship.gear` owned by the `helm:gear` message alone.
			if (sim.gear === null) ship.gear = gearForThrottle(helm.throttle);
		}
		if (aim !== undefined) ship.heading = aim;
	}

	/**
	 * Engage a sail ORDER (gear) on the helm — the canonical control (task #138).
	 * `step()` derives the target throttle and turn authority from `SAIL_GEARS`, so
	 * "travel" buys top speed at the cost of helm response. The chosen gear is
	 * echoed onto `ShipState.gear` so it rides the snapshot back to the HUD.
	 */
	setGear(id: string, gear: SailGear): void {
		const ship = this.ships.get(id);
		const sim = this.sim.get(id);
		if (!ship || !sim || ship.status !== "active") return;
		if (!(gear in SAIL_GEARS)) return;
		sim.gear = gear;
		ship.gear = gear;
	}

	/**
	 * Authoritative broadside. The server, not the client, decides whether the
	 * shot hits and for how much — a fired volley resolves against the nearest
	 * hostile hull inside the aim cone and this class's range, with linear damage
	 * falloff toward the edge. The full arc (origin, resolved impact point, flight
	 * time, hit/miss) is broadcast as a `shot` event so the client can draw the
	 * exact parabola we commit to; damage lands later, at `step()` time.
	 */
	/** True when a point sits inside any port's harbour radius — neutral ground
	 *  where guns run cold (design doc: hubs/ports are safe zones). */
	private inSafeZone(x: number, z: number): boolean {
		for (const p of PORT_DEFS) {
			if (Math.hypot(p.x - x, p.z - z) <= PORT_RADIUS) return true;
		}
		return false;
	}

	fire(id: string, turretHeading: Heading, ammo?: AmmoType): void {
		const ship = this.ships.get(id);
		const sim = this.sim.get(id);
		if (!ship || !sim || ship.status !== "active") return;
		// A hull sheltering in a harbour cannot open fire — the safe zone is
		// absolute, so no shot is even charged or broadcast.
		if (this.inSafeZone(ship.position.x, ship.position.z)) return;
		const spec = SHIP_CLASSES[ship.shipClass];
		// Owner's equipped gear bends this broadside's reach, weight of shot and
		// reload — the only gunnery numbers the resolve below actually reads.
		const b = this.bonuses(ship);
		// The bow-relative aim angle picks which GUN fires (its arc, range, cone,
		// volley); the loaded shot picks the PAYLOAD riding it (hull vs rigging vs
		// burn). The client HUD reads both from the same shared tables, so what the
		// captain sees is exactly what the server resolves — no hidden selector.
		const weapon = weaponForAim(turretHeading - ship.heading);
		const w = WEAPONS[weapon];
		const a = AMMO[ammo ?? "round"];
		// Compose the arc's mechanics with the payload's effect.
		const range = (spec.range + b.range) * w.rangeFactor * a.rangeFactor;
		const reload = Math.max(0.6, (spec.reloadSeconds - b.reload) * w.reloadFactor * a.reloadFactor);
		const coneBonus = w.coneBonus + a.coneBonus;
		const hullFactor = w.hullFactor * a.hullFactor;
		const sailShare = Math.min(1, w.sailShare * a.sailShare);
		const ignites = w.ignites || a.ignites;

		// Reload gate: a broadside takes the class's reload seconds to run out.
		if (this.weatherTime - sim.lastFireAt < reload) return;
		sim.lastFireAt = this.weatherTime;

		const dirX = Math.sin(turretHeading);
		const dirZ = Math.cos(turretHeading);

		// Pick the best hostile target: positive projection down the aim line,
		// inside range, and closest to the firing axis (smallest perpendicular
		// miss distance). "Hostile" = any other active hull right now.
		let best: ShipState | null = null;
		let bestPerp = Infinity;
		for (const t of this.ships.values()) {
			if (t.id === id || t.status !== "active") continue;
			// A hull sheltering in a harbour is under the safe zone's protection:
			// you cannot engage a rival who has run for neutral ground.
			if (this.inSafeZone(t.position.x, t.position.z)) continue;
			// A surrendered hull is under quarter: while the truce holds, neither
			// side can bring guns to bear on the other, so the spared captain can
			// actually get clear (this is what makes accepting terms worth it).
			if (this.inTruce(id, t.id)) continue;
			const rx = t.position.x - ship.position.x;
			const rz = t.position.z - ship.position.z;
			const along = rx * dirX + rz * dirZ;
			if (along <= 0 || along > range) continue; // behind or out of range
			const perp = Math.abs(rx * dirZ - rz * dirX);
			// Generous aim cone scaled to the target's beam so a broadside the
			// player roughly points at connects without pixel-perfect aiming.
			if (perp > SHIP_RADIUS[t.shipClass] + coneBonus) continue;
			if (perp < bestPerp) {
				bestPerp = perp;
				best = t;
			}
		}

		const deckY = 2.2;
		// Beam-perpendicular unit vector: a broadside's guns sit down the hull's
		// beam, so each shell leaves from a different port along that line rather
		// than every cannon firing from the exact same spot.
		const perpX = dirZ;
		const perpZ = -dirX;
		const cx = ship.position.x + dirX * 4;
		const cz = ship.position.z + dirZ * 4;

		this.pendingEvents.push({ t: "muzzleFlash", shipId: id });

		if (best) {
			const dist = Math.hypot(best.position.x - cx, best.position.z - cz);
			// Linear falloff to 35% at maximum range.
			const rangeFalloff = clamp(1 - 0.65 * (dist / range), 0.35, 1);
			// Hit quality: a shell that lands amidships (small perpendicular miss vs
			// the target's beam) tears the hull; one that just clips the extreme of
			// the aim cone grazes bow or stern and bites far less. This makes aim
			// matter — line the broadside up square on the beam for full damage.
			const cone = SHIP_RADIUS[best.shipClass] + coneBonus;
			const centrality = clamp(1 - 0.55 * (bestPerp / cone), 0.45, 1);
			const total = Math.max(1, Math.round((spec.broadsideDamage + b.dmg) * rangeFalloff * centrality * hullFactor));
			// Loose the volley as `guns` shells whose damage sums back to `total`, so a
			// Man-o'-War throws a wide fan of shot for the SAME weight of fire a sloop
			// puts behind one ball — visibly more cannons, no balance shift. Never more
			// shells than there are whole points to spread.
			const shots = Math.max(1, Math.min(Math.min(spec.guns, w.gunCap), total));
			const base = Math.floor(total / shots);
			const spread = shots > 1 ? (SHIP_RADIUS[ship.shipClass] * 1.6) / (shots - 1) : 0;
			for (let g = 0; g < shots; g++) {
				const lat = (g - (shots - 1) / 2) * spread;
				const origin: Vec3 = { x: cx + perpX * lat, y: deckY, z: cz + perpZ * lat };
				const impactPoint: Vec3 = { x: best.position.x + perpX * lat * 0.25, y: 1, z: best.position.z + perpZ * lat * 0.25 };
				const flightTime = Math.max(0.15, Math.hypot(impactPoint.x - origin.x, impactPoint.z - origin.z) / spec.shellSpeed);
				// The last gun absorbs the rounding remainder so the volley lands exactly
				// `total` across all shells.
				const damage = g === shots - 1 ? total - base * (shots - 1) : base;
				this.projectiles.push({
					ownerId: id,
					targetId: best.id,
					origin,
					impactPoint,
					launchedAt: this.weatherTime,
					flightTime,
					hit: true,
					damage,
					weapon,
					sailShare,
					ignites,
				});
				this.pendingEvents.push({ t: "shot", shipId: id, origin, impactPoint, flightTime, hit: true, weapon });
			}
		} else {
			// No hostile HULL in the cone — but a shore fort may be. Bombarding the
			// battery is how the naval-boss fight is won, so check the static forts
			// inside this weapon's range and aim cone, taking the one nearest the aim
			// line. If a fort is found the volley resolves against its sections.
			let bestFort: FortRuntime | null = null;
			let bestFortPerp = Infinity;
			this.ensureForts();
			for (const f of this.forts.values()) {
				if (f.defeated) continue;
				const rx = f.def.x - ship.position.x;
				const rz = f.def.z - ship.position.z;
				const along = rx * dirX + rz * dirZ;
				if (along <= 0 || along > range) continue;
				const perp = Math.abs(rx * dirZ - rz * dirX);
				if (perp > f.def.radius + coneBonus) continue;
				if (perp < bestFortPerp) {
					bestFortPerp = perp;
					bestFort = f;
				}
			}
			if (bestFort) {
				const centrality = clamp(1 - 0.5 * (bestFortPerp / (bestFort.def.radius + coneBonus)), 0.5, 1);
				const dist = Math.hypot(bestFort.def.x - cx, bestFort.def.z - cz);
				const rangeFalloff = clamp(1 - 0.65 * (dist / range), 0.35, 1);
				const total = Math.max(1, Math.round((spec.broadsideDamage + b.dmg) * rangeFalloff * centrality * hullFactor));
				const shots = Math.max(1, Math.min(Math.min(spec.guns, w.gunCap), total));
				const base = Math.floor(total / shots);
				const spread = shots > 1 ? (SHIP_RADIUS[ship.shipClass] * 1.6) / (shots - 1) : 0;
				const fortCenter: Vec3 = { x: bestFort.def.x, y: 6, z: bestFort.def.z };
				for (let g = 0; g < shots; g++) {
					const lat = (g - (shots - 1) / 2) * spread;
					const origin: Vec3 = { x: cx + perpX * lat, y: deckY, z: cz + perpZ * lat };
					const impactPoint: Vec3 = { x: fortCenter.x + perpX * lat * 0.4, y: 6, z: fortCenter.z + perpZ * lat * 0.4 };
					const flightTime = Math.max(0.15, Math.hypot(impactPoint.x - origin.x, impactPoint.z - origin.z) / spec.shellSpeed);
					const damage = g === shots - 1 ? total - base * (shots - 1) : base;
					this.projectiles.push({
						ownerId: id,
						targetId: null,
						origin,
						impactPoint,
						launchedAt: this.weatherTime,
						flightTime,
						hit: true,
						damage,
						weapon,
						sailShare,
						ignites,
						fortTarget: bestFort.id,
					});
					this.pendingEvents.push({ t: "shot", shipId: id, origin, impactPoint, flightTime, hit: true, weapon });
				}
			} else {
				// No target at all — the whole fan falls short as water columns.
				const reach = range * 0.85;
				const shots = Math.max(1, Math.min(spec.guns, w.gunCap));
				const spread = shots > 1 ? (SHIP_RADIUS[ship.shipClass] * 1.6) / (shots - 1) : 0;
			for (let g = 0; g < shots; g++) {
				const lat = (g - (shots - 1) / 2) * spread;
				const origin: Vec3 = { x: cx + perpX * lat, y: deckY, z: cz + perpZ * lat };
				const impactPoint: Vec3 = {
					x: ship.position.x + dirX * reach + perpX * lat,
					y: 0,
					z: ship.position.z + dirZ * reach + perpZ * lat,
				};
				const flightTime = reach / spec.shellSpeed;
				this.projectiles.push({
					ownerId: id,
					targetId: null,
					origin,
					impactPoint,
					launchedAt: this.weatherTime,
					flightTime,
					hit: false,
					damage: 0,
					weapon,
					sailShare,
					ignites,
				});
				this.pendingEvents.push({ t: "shot", shipId: id, origin, impactPoint, flightTime, hit: false, weapon });
				}
			}
		}
	}

	/** Advance and resolve in-flight shells; called once per tick after ships move. */
	private stepProjectiles(): void {
		if (this.projectiles.length === 0) return;
		const now = this.weatherTime;
		const stillFlying: Projectile[] = [];
		for (const p of this.projectiles) {
			if (now - p.launchedAt < p.flightTime) {
				stillFlying.push(p);
				continue;
			}
			// Shell has landed.
			if (p.fortTarget !== undefined) {
				// A bombardment shell: crack a fort section (or splash if the fort
				// already went up mid-flight).
				const f = this.forts.get(p.fortTarget);
				if (f && !f.defeated) this.damageFort(f, p.damage, p.impactPoint);
				else this.pendingEvents.push({ t: "waterImpact", point: p.impactPoint });
				continue;
			}
			if (p.hit && p.targetId) {
				const target = this.ships.get(p.targetId);
				if (target && target.status === "active") {
					// Rigging soaks its share FIRST; the frames only take the rest
					// once the canvas is gone, so a duel cripples before it kills.
					const spec = SHIP_CLASSES[target.shipClass];
					let hullDamage = p.damage;
					if (target.sails > 0) {
						const toSails = Math.min(target.sails, Math.round(p.damage * p.sailShare));
						target.sails -= toSails;
						hullDamage = p.damage - toSails;
					}
					target.hull -= hullDamage;
					// Fire barrels: a hull-reaching hit sets the deck alight; the burn
					// ticks in step() as pressure, not an instant kill.
					if (p.ignites) {
						const ts = this.sim.get(target.id);
						if (ts) ts.burnUntil = this.weatherTime + BURN_SECONDS;
					}
					this.pendingEvents.push({ t: "hullImpact", targetId: target.id, point: p.impactPoint, damage: p.damage });
					if (target.hull <= 0) this.resolveSink(target, p.ownerId);
				} else {
					// Target sank/cleared mid-flight: the shot still hits water.
					this.pendingEvents.push({ t: "waterImpact", point: p.impactPoint });
				}
			} else {
				this.pendingEvents.push({ t: "waterImpact", point: p.impactPoint });
			}
		}
		this.projectiles = stillFlying;
	}

	/**
	 * A hull reaches zero: it is sunk, not destroyed. The victor takes the cargo
	 * (the real stake), the loser's hold is emptied, and the hull flips to
	 * `sunk_needs_repair` so it can be bought back into service at a dock.
	 */
	private resolveSink(victim: ShipState, killerId?: string): void {
		victim.hull = 0;
		victim.status = "sunk_needs_repair";
		victim.velocity.x = 0;
		victim.velocity.z = 0;
		// A hull that just went down can no longer be hailed, answer a demand, or
		// hide behind a ceasefire — drop any parley state that touches it.
		this.clearParleyFor(victim.id);
		const killer = killerId ? this.ships.get(killerId) : undefined;
		const stranded = victim.cargo;
		let taken = 0;
		if (killer && killer.status === "active") {
			const capacity = SHIP_CLASSES[killer.shipClass].cargoCapacity + this.bonuses(killer).cargo;
			taken = Math.max(0, Math.min(capacity, killer.cargo + victim.cargo) - killer.cargo);
			killer.cargo += taken;
			// Typed salvage (task #139): a player who takes a prize also lifts the
			// victim's class-weighted scrap out of it, banked straight to their
			// ledger (an NPC killer with no bound owner keeps only the abstract cargo).
			if (taken > 0 && killer.ownerAddress) {
				const krec = this.ledger(killer.ownerAddress);
				this.bankMaterials(krec, salvageYieldFor(victim.shipClass, taken));
				this.queuePlayer(killer.ownerAddress);
			}
			// A player pull the trigger: shift their standing with each faction
			// by what the prize was. Cargo the victim carried is now theirs.
			this.applyReputationOnSink(killer, victim.faction);
			// Provenance-as-prestige: sinking ANOTHER PLAYER's hull (a real prize,
			// not ambient scenery) bumps the killer's lifetime kill badge. The
			// relayer mirrors this same event on-chain; this is the live off-chain
			// count that rides the snapshot so the badge shows with or without chain.
			if (
				killer.tokenId &&
				victim.ownerAddress &&
				victim.ownerAddress.toLowerCase() !== killer.ownerAddress?.toLowerCase()
			) {
				const tid = killer.tokenId.toString();
				const n = (this.killCounts.get(tid) ?? 0) + 1;
				this.killCounts.set(tid, n);
				killer.kills = n;
			}
		}
		victim.cargo = 0;
		// Whatever the victor could NOT take (its hold was full) — or the WHOLE hold,
		// if there was no victor at all (a founder) — sinks with the wreck as a
		// salvage field rather than vanishing, so the sea keeps a grudge-worthy prize.
		const salvage = stranded - taken;
		if (salvage >= 1) this.spawnWreck(victim.position.x, victim.position.z, salvage, victim.shipClass);
		// A ghost-fleet trader that sank is no longer sailing: drop it from the
		// owner's fleet roster.
		if (victim.ownerAddress && victim.mode === "auto") {
			const rec = this.players.get(victim.ownerAddress.toLowerCase());
			if (rec) {
				rec.fleet = rec.fleet.filter((id) => id !== victim.id);
				this.queuePlayer(victim.ownerAddress);
			}
		}
		// A player's OWN actively-sailed hull went down: keep a durable repair debt
		// so a rejoin (or even a full server restart, where ships are transient)
		// hands the wrecked captain their hull at a harbour, NOT a free full-strength
		// one. Dedup by identity so a hull that sinks repeatedly does not pile up.
		if (victim.ownerAddress && victim.mode === "player") {
			const rec = this.ledger(victim.ownerAddress);
			const tid = victim.tokenId?.toString();
			rec.repairDebt = rec.repairDebt.filter(
				(d) => (tid ? d.tokenId !== tid : !(d.tokenId === undefined && d.shipClass === victim.shipClass && d.name === victim.name))
			);
			rec.repairDebt.push({ name: victim.name, shipClass: victim.shipClass, tokenId: tid });
			this.queuePlayer(victim.ownerAddress);
		}
		this.pendingEvents.push({ t: "sunk", shipId: victim.id, killerShipId: killerId });
	}

	/** Apply the REP_ON_SINK swing to a player victor's ledger (NPC kills with no
	 *  bound owner are ignored — nothing to update). */
	private applyReputationOnSink(killer: ShipState, victimFaction: Faction): void {
		if (!killer.ownerAddress) return;
		const rec = this.ledger(killer.ownerAddress);
		for (const [faction, delta] of Object.entries(REP_ON_SINK[victimFaction])) {
			const key = faction as Faction;
			rec.reputation[key] = clamp(rec.reputation[key] + (delta ?? 0), -REP_CAP, REP_CAP);
		}
		this.queuePlayer(killer.ownerAddress);
	}

	/** Pop the combat events queued since the last call (the server broadcasts them). */
	drainEvents(): CombatEvent[] {
		if (this.pendingEvents.length === 0) return [];
		const out = this.pendingEvents;
		this.pendingEvents = [];
		return out;
	}

	/** Pop the economy updates queued since the last call (see MetaEvent). */
	drainMeta(): MetaEvent[] {
		if (this.pendingMeta.length === 0) return [];
		const out = this.pendingMeta;
		this.pendingMeta = [];
		return out;
	}

	/** Get-or-create a player's off-chain ledger by wallet address. */
	private ledger(address: string): PlayerRecord {
		const key = address.toLowerCase();
		let rec = this.players.get(key);
		if (!rec) {
			rec = { purse: 0, reputation: { pirate: 0, naval: 0, merchant: 0 }, fleet: [], items: {}, equipped: {}, materials: { wood: 0, iron: 0, cloth: 0 }, repairDebt: [] };
			this.players.set(key, rec);
		}
		return rec;
	}

	/** Queue a "this player changed" signal so the loop re-sends their state. */
	private queuePlayer(address: string): void {
		this.pendingMeta.push({ kind: "player", address: address.toLowerCase() });
	}

	/** Public view of a player's ledger for the owning client. */
	playerState(address: string): PlayerPublicState | null {
		const rec = this.players.get(address.toLowerCase());
		if (!rec) return null;
		return {
			address: address.toLowerCase(),
			purse: rec.purse,
			reputation: { ...rec.reputation },
			fleet: [...rec.fleet],
			items: { ...rec.items },
			equipped: { ...rec.equipped },
			materials: { ...rec.materials },
		};
	}

	/** Add a salvage yield to a ledger, clamping each material to a whole >= 0. */
	private bankMaterials(rec: PlayerRecord, y: MaterialYield): void {
		rec.materials.wood += Math.max(0, Math.floor(y.wood));
		rec.materials.iron += Math.max(0, Math.floor(y.iron));
		rec.materials.cloth += Math.max(0, Math.floor(y.cloth));
	}

	/**
	 * Buy one outfitting good from the off-chain cargo purse (NOT on-chain USDG —
	 * that is only for hulls). Authoritative: we re-price from the shared shop
	 * table so a client can't name its own cost, and only bank it if the purse
	 * covers it. Returns false on an unknown item or insufficient purse.
	 */
	buyItem(address: string, itemId: string): boolean {
		const def = shopItemById(itemId);
		if (!def) return false;
		const rec = this.ledger(address);
		// Faction standing moves the price: a captain the merchants trust (high
		// merchant rep, earned by NOT plundering their trade) gets a discount, one
		// they despise pays a piracy surcharge. Authoritative here, so the client
		// can't name its own cost regardless of what the shop UI displays.
		const cost = this.shopPrice(rec.reputation.merchant, def.cost);
		// Typed salvage (task #139): an upgrade ALSO wants its bill of materials, but
		// as a LENIENT parallel track — spend what we hold, and auto-buy any shortfall
		// off the purse at a flat unit price so a purchase never hard-fails just for
		// lacking scrap. Keeps the existing economy intact; materials just add cost.
		const bill = def.materials;
		const shortWood = Math.max(0, bill.wood - rec.materials.wood);
		const shortIron = Math.max(0, bill.iron - rec.materials.iron);
		const shortCloth = Math.max(0, bill.cloth - rec.materials.cloth);
		const autoPrice = materialBuyPrice({ wood: shortWood, iron: shortIron, cloth: shortCloth });
		const total = cost + autoPrice;
		if (rec.purse < total) return false;
		rec.purse -= total;
		rec.materials.wood = Math.max(0, rec.materials.wood - bill.wood);
		rec.materials.iron = Math.max(0, rec.materials.iron - bill.iron);
		rec.materials.cloth = Math.max(0, rec.materials.cloth - bill.cloth);
		rec.items[itemId] = (rec.items[itemId] ?? 0) + 1;
		this.queuePlayer(address);
		return true;
	}

	/**
	 * Convert cargo from the purse into salvage materials at the shared unit price
	 * (task #139). The explicit "buy the scrap I'm short on" path the shop can offer.
	 * Authoritative, whole-number, no-op if the purse can't cover it.
	 */
	autoBuyMaterials(address: string, want: Partial<SalvageLedger>): boolean {
		const rec = this.ledger(address);
		const wood = Math.max(0, Math.floor(want.wood ?? 0));
		const iron = Math.max(0, Math.floor(want.iron ?? 0));
		const cloth = Math.max(0, Math.floor(want.cloth ?? 0));
		if (wood + iron + cloth <= 0) return false;
		const price = materialBuyPrice({ wood, iron, cloth });
		if (rec.purse < price) return false;
		rec.purse -= price;
		rec.materials.wood += wood;
		rec.materials.iron += iron;
		rec.materials.cloth += cloth;
		this.queuePlayer(address);
		return true;
	}

	/**
	 * Effective shop price for a given merchant standing. Reputation -100..+100
	 * maps linearly to a 1.4x pariah surcharge .. 0.75x hero discount, then we
	 * round up so a price never collapses to zero.
	 */
	shopPrice(merchantRep: number, baseCost: number): number {
		const t = clamp(merchantRep, -REP_CAP, REP_CAP) / REP_CAP; // -1..1
		const mult = 1.075 - 0.325 * t; // +1 -> 0.75, -1 -> 1.4
		return Math.max(1, Math.ceil(baseCost * mult));
	}

	/**
	 * Equip / unequip one owned good in its slot. Free. Unequipping clears the
	 * slot; equipping requires an owned (and not currently equipped) copy. Only
	 * one item is active per slot, so swapping implicitly unloads the previous.
	 */
	equip(address: string, itemId: string, on: boolean): boolean {
		const def = shopItemById(itemId);
		if (!def) return false;
		const rec = this.ledger(address);
		const slot: ShopSlot = def.slot;
		if (on) {
			if ((rec.items[itemId] ?? 0) <= 0) return false;
			rec.equipped[slot] = itemId;
		} else {
			if (rec.equipped[slot] === itemId) rec.equipped[slot] = null;
		}
		this.queuePlayer(address);
		return true;
	}

	/**
	 * Sum the stat bonuses a hull's OWNER has equipped. Read once at each of the
	 * few authoritative stat sites (gunnery, sail speed, hold, hull). A hull with
	 * no owner (an NPC) gets an empty bonus, so the whole feature is a no-op for
	 * the seeded traffic. Slots are independent, so cannons + ammo + a curio all
	 * stack onto broadside damage.
	 */
	private bonuses(ship: ShipState): {
		dmg: number;
		range: number;
		reload: number;
		cargo: number;
		hull: number;
		speed: number;
	} {
		const address = ship.ownerAddress;
		if (!address) return { dmg: 0, range: 0, reload: 0, cargo: 0, hull: 0, speed: 0 };
		return this.bonusesForAddress(address);
	}

	/** Address-keyed form of `bonuses`, usable before a hull object exists. */
	private bonusesForAddress(address: string): {
		dmg: number;
		range: number;
		reload: number;
		cargo: number;
		hull: number;
		speed: number;
	} {
		const b = { dmg: 0, range: 0, reload: 0, cargo: 0, hull: 0, speed: 0 };
		const rec = this.players.get(address.toLowerCase());
		if (!rec) return b;
		for (const slot of Object.keys(rec.equipped) as ShopSlot[]) {
			const itemId = rec.equipped[slot];
			if (!itemId) continue;
			const def = shopItemById(itemId);
			if (!def) continue;
			switch (SLOT_STAT[slot]) {
				case "broadsideDamage":
					b.dmg += def.amount;
					break;
				case "range":
					b.range += def.amount;
					break;
				case "reloadSeconds":
					b.reload += def.amount;
					break;
				case "cargoCapacity":
					b.cargo += def.amount;
					break;
				case "hullMax":
					b.hull += def.amount;
					break;
				case "maxSpeed":
					b.speed += def.amount;
					break;
			}
		}
		return b;
	}

	/** Nearest port to a point, or null if none within docking range. */
	private portAt(x: number, z: number) {
		for (const p of PORT_DEFS) {
			if (Math.hypot(p.x - x, p.z - z) <= PORT_RADIUS) return p;
		}
		return null;
	}

	/** Nearest port to a point regardless of range (the tow destination). */
	private nearestPortDef(x: number, z: number) {
		let best: (typeof PORT_DEFS)[number] | null = null;
		let bestD = Infinity;
		for (const p of PORT_DEFS) {
			const d = Math.hypot(p.x - x, p.z - z);
			if (d < bestD) {
				bestD = d;
				best = p;
			}
		}
		return best;
	}

	/**
	 * Offload a docked hull's cargo hold into the owner's purse. Only works while
	 * the hull is inside a port radius and the caller owns it — cargo is inert at
	 * sea and only becomes spendable (repairs) once landed.
	 */
	unload(shipId: string): boolean {
		const ship = this.ships.get(shipId);
		if (!ship || !ship.ownerAddress || ship.status !== "active") return false;
		if (!this.portAt(ship.position.x, ship.position.z)) return false;
		const rec = this.ledger(ship.ownerAddress);
		rec.purse += ship.cargo;
		ship.cargo = 0;
		this.queuePlayer(ship.ownerAddress);
		return true;
	}

	/**
	 * Bring a sunk hull back to service for a cargo fee from the purse (sunk ≠
	 * burned: the hull returns, but the cost is paid from value you actually
	 * landed). No-op if the hull isn't sunk/docked or the purse can't cover it.
	 */
	repair(shipId: string): boolean {
		const ship = this.ships.get(shipId);
		if (!ship || !ship.ownerAddress || ship.status !== "sunk_needs_repair") return false;
		if (!this.portAt(ship.position.x, ship.position.z)) return false;
		const rec = this.ledger(ship.ownerAddress);
		const hullMax = SHIP_CLASSES[ship.shipClass].hullMax + this.bonuses(ship).hull;
		const cost = Math.ceil(hullMax / 2);
		if (rec.purse < cost) return false;
		rec.purse -= cost;
		ship.hull = hullMax;
		ship.sails = SHIP_CLASSES[ship.shipClass].sailsMax;
		ship.status = "active";
		// The debt is paid: drop the matching repair-debt entry so a future restart
		// does not re-spawn this now-repaired hull as a wreck.
		const tid = ship.tokenId?.toString();
		rec.repairDebt = rec.repairDebt.filter(
			(d) => (tid ? d.tokenId !== tid : !(d.tokenId === undefined && d.shipClass === ship.shipClass))
		);
		this.queuePlayer(ship.ownerAddress);
		return true;
	}

	/**
	 * Record a bounty posting on the Most-Wanted board. `tokenId` is the targeted
	 * hull, `amount` the USDG escrowed in base units (a decimal string, summed
	 * across repeat postings). We enrich the row with the hull's live name/class
	 * when it is afloat; a posted bounty on a hull we cannot see still boards by
	 * id. Returns the updated ranked board so the caller can broadcast it.
	 */
	postBounty(tokenId: string, amount: string): WantedEntry[] {
		const existing = this.wanted.get(tokenId);
		const hull = this.findShipByToken(tokenId);
		const summed = existing ? BigInt(existing.amount) + BigInt(amount) : BigInt(amount);
		this.wanted.set(tokenId, {
			tokenId,
			amount: summed.toString(),
			name: hull?.name ?? `Hull #${tokenId}`,
			shipClass: hull?.shipClass ?? "starter_sloop",
		});
		return this.wantedBoard();
	}

	/** Drop a hull's bounty from the board (it sank and the claim settled). */
	clearWanted(tokenId?: string): WantedEntry[] {
		if (tokenId) this.wanted.delete(tokenId);
		return this.wantedBoard();
	}

	/** The board ranked by payout, biggest bounty first. */
	wantedBoard(): WantedEntry[] {
		return [...this.wanted.values()].sort((a, b) => (BigInt(b.amount) > BigInt(a.amount) ? 1 : -1));
	}

	/** The afloat hull bound to an on-chain tokenId, or null. */
	private findShipByToken(tokenId: string): ShipState | null {
		for (const s of this.ships.values()) {
			if (s.tokenId?.toString() === tokenId) return s;
		}
		return null;
	}

	/** The live trading-post roster, oldest first. */
	currentTrades(): TradeListing[] {
		return [...this.trades.values()];
	}

	/**
	 * A docked player posts a sell order. The goods are escrowed NOW (cargo comes
	 * out of the purse; an item stack out of inventory) so a later buy is a clean
	 * swap and a seller can never double-spend. Returns the new order id, or null
	 * if the hull isn't theirs/docked or they can't cover the escrow.
	 */
	tradeList(
		address: string,
		shipId: string,
		kind: "cargo" | "item",
		itemId: string | undefined,
		qty: number,
		price: number
	): TradeListing | null {
		const ship = this.ships.get(shipId);
		if (!ship || ship.ownerAddress !== address || ship.status !== "active") return null;
		if (!this.portAt(ship.position.x, ship.position.z)) return null;
		if (!Number.isInteger(qty) || qty < 1 || !Number.isInteger(price) || price < 1) return null;
		const rec = this.ledger(address);
		if (kind === "cargo") {
			if (rec.purse < qty) return null;
			rec.purse -= qty;
		} else {
			if (!itemId || !shopItemById(itemId)) return null;
			if ((rec.items[itemId] ?? 0) < qty) return null;
			rec.items[itemId] -= qty;
		}
		this.queuePlayer(address);
		const order: TradeListing = {
			id: String(this.nextTradeId++),
			seller: address.toLowerCase(),
			kind,
			itemId,
			qty,
			price,
		};
		this.trades.set(order.id, order);
		return order;
	}

	/**
	 * A docked player buys an open order. Atomic swap: buyer's purse → seller's
	 * purse, escrowed goods → buyer. No-op if the order is gone, the buyer IS the
	 * seller, they are not docked, or their purse can't cover the ask.
	 */
	tradeBuy(address: string, shipId: string, orderId: string): boolean {
		const order = this.trades.get(orderId);
		if (!order) return false;
		if (order.seller === address.toLowerCase()) return false;
		const ship = this.ships.get(shipId);
		if (!ship || ship.ownerAddress !== address || ship.status !== "active") return false;
		if (!this.portAt(ship.position.x, ship.position.z)) return false;
		const buyer = this.ledger(address);
		if (buyer.purse < order.price) return false;
		buyer.purse -= order.price;
		const seller = this.ledger(order.seller);
		seller.purse += order.price;
		// Deliver the escrowed goods to the buyer.
		if (order.kind === "cargo") {
			buyer.purse += order.qty;
		} else if (order.itemId) {
			buyer.items[order.itemId] = (buyer.items[order.itemId] ?? 0) + order.qty;
		}
		this.trades.delete(orderId);
		this.queuePlayer(address);
		this.queuePlayer(order.seller);
		return true;
	}

	/** Cancel your own open order; the escrowed goods return to your ledger. */
	tradeCancel(address: string, orderId: string): boolean {
		const order = this.trades.get(orderId);
		if (!order || order.seller !== address.toLowerCase()) return false;
		const rec = this.ledger(address);
		if (order.kind === "cargo") rec.purse += order.qty;
		else if (order.itemId) rec.items[order.itemId] = (rec.items[order.itemId] ?? 0) + order.qty;
		this.trades.delete(orderId);
		this.queuePlayer(address);
		return true;
	}

	// ---- Real-time parley / surrender (OFF-chain, PvP) ----------------------

	/** Sorted key for a hull pair, so a truce is symmetric (a↔b == b↔a). */
	private pairKey(a: string, b: string): string {
		return a < b ? `${a}|${b}` : `${b}|${a}`;
	}

	/** Whether two hulls are inside an active ceasefire. Expired truces self-clear. */
	inTruce(a: string, b: string): boolean {
		const exp = this.truces.get(this.pairKey(a, b));
		if (exp === undefined) return false;
		if (this.weatherTime >= exp) {
			this.truces.delete(this.pairKey(a, b));
			return false;
		}
		return true;
	}

	/**
	 * One player hull demands surrender terms of another: "strike your colors and
	 * hand over your hold, or be sunk." Validated authoritatively here (both afloat
	 * and PLAYER-driven, foreign-owned, within the attacker's own cannon range, the
	 * target actually carrying cargo, the attacker having room in its hold). The
	 * demand is the defender's whole hold capped by the attacker's free space, so
	 * accepting is a real transfer, not a token. Returns the offer to route, or a
	 * reason the demand was refused.
	 */
	demandParley(attackerId: string, defenderId: string): { ok: true; offer: ParleyOffer } | { ok: false; reason: ParleyFailReason } {
		const a = this.ships.get(attackerId);
		const d = this.ships.get(defenderId);
		if (!a || !d || a.status !== "active" || d.status !== "active") return { ok: false, reason: "gone" };
		if (a.id === d.id) return { ok: false, reason: "self" };
		// Parley is between rival captains — your own fleet is not for sale at
		// cannonpoint, and NPC/auto hulls have no one to answer the hail.
		if (!a.ownerAddress || !d.ownerAddress || a.ownerAddress.toLowerCase() === d.ownerAddress.toLowerCase()) {
			return { ok: false, reason: "ally" };
		}
		if (a.mode !== "player" || d.mode !== "player") return { ok: false, reason: "gone" };
		const spec = SHIP_CLASSES[a.shipClass];
		const dist = Math.hypot(d.position.x - a.position.x, d.position.z - a.position.z);
		// A parley is a pistol-shot hail across the water: it only carries as far
		// as your guns do, so you cannot summon a distant ship to terms.
		if (dist > spec.range) return { ok: false, reason: "range" };
		const freeCap = spec.cargoCapacity + this.bonuses(a).cargo - a.cargo;
		if (freeCap <= 0) return { ok: false, reason: "full" };
		const demand = Math.min(d.cargo, Math.floor(freeCap));
		if (demand <= 0) return { ok: false, reason: "empty" };
		const expiresAt = this.weatherTime + PARLEY_TTL_S;
		this.parleys.set(d.id, { attackerId: a.id, defenderId: d.id, demand, expiresAt });
		return {
			ok: true,
			offer: { defenderShipId: d.id, attackerShipId: a.id, attackerName: a.name, demand, ttlSeconds: PARLEY_TTL_S },
		};
	}

	/**
	 * The defender answers a live demand. ACCEPT: the toll (the lesser of the demand
	 * and what the hold actually carries now) moves straight into the attacker's
	 * hold and a truce begins so the spared hull can get clear — quarter for cargo,
	 * a hull kept whole. DECLINE: the demand is withdrawn and the fight continues.
	 * Either way the offer is consumed; re-demanding is the attacker's call.
	 */
	respondParley(
		defenderId: string,
		accept: boolean
	): { ok: true; resolved: ParleyResolved } | { ok: false; reason: ParleyFailReason; attackerId?: string } {
		const p = this.parleys.get(defenderId);
		if (!p) return { ok: false, reason: "stale" };
		this.parleys.delete(defenderId);
		const a = this.ships.get(p.attackerId);
		const d = this.ships.get(defenderId);
		const attackerId = p.attackerId;
		if (!a || !d || a.status !== "active" || d.status !== "active") return { ok: false, reason: "gone", attackerId };
		if (!accept) {
			return { ok: true, resolved: { accepted: false, attackerShipId: a.id, defenderShipId: d.id, moved: 0 } };
		}
		// Re-check range at the answer: the defender cannot accept terms from a hull
		// that has since run out of gun-shot (a fake surrender to lure then flee).
		const spec = SHIP_CLASSES[a.shipClass];
		const dist = Math.hypot(d.position.x - a.position.x, d.position.z - a.position.z);
		if (dist > spec.range) return { ok: false, reason: "range", attackerId };
		const moved = Math.min(p.demand, d.cargo);
		d.cargo -= moved;
		const capacity = spec.cargoCapacity + this.bonuses(a).cargo;
		a.cargo = Math.min(capacity, a.cargo + moved);
		this.truces.set(this.pairKey(a.id, d.id), this.weatherTime + TRUCE_S);
		if (a.ownerAddress) this.queuePlayer(a.ownerAddress);
		if (d.ownerAddress) this.queuePlayer(d.ownerAddress);
		return { ok: true, resolved: { accepted: true, attackerShipId: a.id, defenderShipId: d.id, moved } };
	}

	/** Drop any parley/truce that involves a hull that just sank or left the sea,
	 *  so a dead captain cannot be hailed, answer, or be held by a stale truce. */
	private clearParleyFor(shipId: string): void {
		for (const [defId, p] of this.parleys) {
			if (p.attackerId === shipId || p.defenderId === shipId) this.parleys.delete(defId);
		}
		for (const key of this.truces.keys()) {
			const [x, y] = key.split("|");
			if (x === shipId || y === shipId) this.truces.delete(key);
		}
	}

	/**
	 * Expire stale parleys and truces once a tick. An offer whose window has passed,
	 * or whose hulls sank/left, is dropped; a ceasefire whose clock ran out is
	 * dropped. No lapse signal is sent — both prompts carry the offer's ttl and
	 * self-close on that clock, so a vanished or sunk counterpart can never leave a
	 * stuck dialog on either side.
	 */
	private evolveParley(): void {
		for (const [defId, p] of this.parleys) {
			const a = this.ships.get(p.attackerId);
			const d = this.ships.get(defId);
			if (this.weatherTime >= p.expiresAt || !a || !d || a.status !== "active" || d.status !== "active") {
				this.parleys.delete(defId);
			}
		}
		for (const [key, exp] of this.truces) {
			if (this.weatherTime >= exp) this.truces.delete(key);
		}
	}

	// ---- Salvage debris fields (OFF-chain, ghost-ship wreck diving) ---------

	/** Settle a sunken hull's untaken cargo on the sea floor as a diveable wreck. */
	private spawnWreck(x: number, z: number, cargo: number, cls: ShipClass): void {
		this.wrecks.set(this.nextWreckId, {
			id: this.nextWreckId++,
			x,
			z,
			cargo,
			materials: salvageYieldFor(cls, cargo),
			expiresAt: this.weatherTime + WRECK_TTL_S,
		});
	}

	/** Scatter debris fields whose time on the seabed has run out. */
	private evolveWrecks(): void {
		for (const [id, w] of this.wrecks) {
			if (this.weatherTime >= w.expiresAt) this.wrecks.delete(id);
		}
	}

	/**
	 * The wreck markers THIS viewer can legally sight: their own, culled by the same
	 * weather-visibility range as hulls, so a debris field is only markable once you
	 * are close enough (or the air is clear enough) to have raised the wreckage. A
	 * menu spectator (no hull) sees the whole field.
	 */
	/**
	 * Build the shore forts once, at full strength. Called from step(); a defeated
	 * fort stays in the map (latched) so it is never resurrected mid-session — only a
	 * fresh boot re-arms the battery.
	 */
	private ensureForts(): void {
		if (this.fortsBuilt) return;
		this.fortsBuilt = true;
		for (const def of FORT_DEFS) {
			this.forts.set(def.id, {
				id: def.id,
				def,
				hp: { ...def.max },
				lastFireAt: -Infinity,
				defeated: false,
			});
		}
	}

	/** Snapshot view of every fort, sent whole to all clients (landmarks, not culled). */
	fortStates(): FortState[] {
		this.ensureForts();
		const out: FortState[] = [];
		for (const f of this.forts.values()) out.push({ id: f.id, hp: { ...f.hp }, defeated: f.defeated });
		return out;
	}

	/**
	 * Fort artillery AI. While a fort's mortar tower stands it looses a volley at
	 * the nearest hostile PLAYER hull inside range on its reload timer. Naval-faction
	 * captains are friendly to the battery and are never engaged; ambient NPC traffic
	 * is ignored (a fort contests captains, not scenery). A fort with its tower
	 * knocked out goes silent but is NOT defeated — the magazine is the kill.
	 */
	private stepForts(): void {
		this.ensureForts();
		for (const fort of this.forts.values()) {
			if (fort.defeated || fort.hp.mortarTower <= 0) continue;
			if (this.weatherTime - fort.lastFireAt < fort.def.reloadSeconds) continue;
			let best: ShipState | null = null;
			let bestD = Infinity;
			for (const s of this.ships.values()) {
				if (s.status !== "active" || s.mode !== "player") continue;
				if (s.faction === "naval") continue; // the battery flies the king's colours
				const d = Math.hypot(s.position.x - fort.def.x, s.position.z - fort.def.z);
				if (d > fort.def.range || d >= bestD) continue;
				bestD = d;
				best = s;
			}
			if (!best) continue;
			fort.lastFireAt = this.weatherTime;
			this.fireFortVolley(fort, best);
		}
	}

	/** Resolve a fort's gunnery against a hull, with the same range falloff as a ship
	 *  broadside. Fired from the tower top so the client draws a plunging arc. */
	private fireFortVolley(fort: FortRuntime, target: ShipState): void {
		const origin: Vec3 = { x: fort.def.x, y: 16, z: fort.def.z };
		const impactPoint: Vec3 = { x: target.position.x, y: 1, z: target.position.z };
		const dist = Math.hypot(impactPoint.x - origin.x, impactPoint.z - origin.z);
		const rangeFalloff = clamp(1 - 0.6 * (dist / fort.def.range), 0.4, 1);
		const dmg = Math.max(1, Math.round(fort.def.broadsideDamage * rangeFalloff));
		const flightTime = Math.max(0.2, dist / fort.def.shellSpeed);
		this.pendingEvents.push({ t: "muzzleFlash", shipId: `fort:${fort.id}` });
		this.projectiles.push({
			ownerId: `fort:${fort.id}`,
			targetId: target.id,
			origin,
			impactPoint,
			launchedAt: this.weatherTime,
			flightTime,
			hit: true,
			damage: dmg,
			weapon: "broadside",
			sailShare: 0.4,
			ignites: false,
		});
		this.pendingEvents.push({ t: "shot", shipId: `fort:${fort.id}`, origin, impactPoint, flightTime, hit: true, weapon: "broadside" });
	}

	/**
	 * The three-stage bombardment puzzle. Incoming shot from a hull is absorbed in
	 * a fixed priority so the captain must WORK the fort down, not burst it:
	 *   1. While either bastion wall stands, ALL damage falls on the walls (the
	 *      higher-hp one, so they crumble evenly and neither becomes a free shield).
	 *   2. Once both walls fall, the mortar tower is exposed — killing it silences
	 *      the fort's guns, but the fort still stands.
	 *   3. Only with walls AND tower down is the powder magazine targetable; put it
	 *      at zero and the whole fort DETONATES (see detonateFort).
	 * Each hit emits a `fortImpact` event naming the section so the client crumbles it.
	 */
	private damageFort(fort: FortRuntime, dmg: number, point: Vec3): void {
		if (fort.defeated) return;
		let section: FortSectionKey;
		const wallsUp = fort.hp.northWall > 0 || fort.hp.southWall > 0;
		if (wallsUp) {
			section = fort.hp.northWall >= fort.hp.southWall ? "northWall" : "southWall";
		} else if (fort.hp.mortarTower > 0) {
			section = "mortarTower";
		} else if (fort.hp.powderMagazine > 0) {
			section = "powderMagazine";
		} else {
			return;
		}
		fort.hp[section] = Math.max(0, fort.hp[section] - dmg);
		this.pendingEvents.push({ t: "fortImpact", fortId: fort.id, section, point, damage: dmg });
		if (section === "powderMagazine" && fort.hp.powderMagazine <= 0) this.detonateFort(fort);
	}

	/**
	 * The magazine goes up: a chain detonation that finishes the fort outright and
	 * throws a blast across the beach, damaging (and possibly sinking) any hull that
	 * sailed in too close to the walls. The reward for cracking the fort — and its
	 * punishment for lingering under the guns.
	 */
	private detonateFort(fort: FortRuntime): void {
		fort.defeated = true;
		fort.hp = { northWall: 0, southWall: 0, mortarTower: 0, powderMagazine: 0 };
		const epicentre: Vec3 = { x: fort.def.x, y: 4, z: fort.def.z };
		this.pendingEvents.push({ t: "fortDetonate", fortId: fort.id, point: epicentre });
		for (const s of this.ships.values()) {
			if (s.status !== "active") continue;
			const d = Math.hypot(s.position.x - fort.def.x, s.position.z - fort.def.z);
			if (d > fort.def.blastRadius) continue;
			const blast = Math.round(fort.def.blastDamage * clamp(1 - d / fort.def.blastRadius, 0.25, 1));
			s.hull -= blast;
			if (s.hull <= 0) this.resolveSink(s);
		}
	}

	wrecksFor(viewerShipId: string | undefined): Wreck[] {
		const viewer = viewerShipId ? this.ships.get(viewerShipId) : undefined;
		if (!viewer) return [...this.wrecks.values()].map((w) => ({ id: w.id, x: w.x, z: w.z, cargo: w.cargo, materials: w.materials }));
		const range = this.visibilityRange();
		const out: Wreck[] = [];
		for (const w of this.wrecks.values()) {
			if (Math.hypot(w.x - viewer.position.x, w.z - viewer.position.z) <= range) {
				out.push({ id: w.id, x: w.x, z: w.z, cargo: w.cargo, materials: w.materials });
			}
		}
		return out;
	}

	/**
	 * Dive a wreck: a PLAYER-driven hull that sails over a debris field lifts its
	 * salvage straight into the hold (capped by free capacity), consuming the field.
	 * Runs once per ship per tick from evolveEconomy; first hull over the wreck wins it.
	 */
	private salvageWrecks(ship: ShipState): void {
		if (ship.mode !== "player" || !ship.ownerAddress) return;
		for (const w of this.wrecks.values()) {
			if (Math.hypot(w.x - ship.position.x, w.z - ship.position.z) > SALVAGE_RADIUS) continue;
			const capacity = SHIP_CLASSES[ship.shipClass].cargoCapacity + this.bonuses(ship).cargo;
			const gained = Math.min(capacity - ship.cargo, w.cargo);
			// Only lift the wreck if there is room to bank something; a full hold sails
			// past it and it stays for a roomier captain.
			if (gained <= 0) continue;
			ship.cargo += gained;
			// Bank the wreck's typed scrap on the diver's ledger (task #139) alongside
			// the abstract cargo, then consume the field.
			this.bankMaterials(this.ledger(ship.ownerAddress), w.materials);
			this.wrecks.delete(w.id);
			this.pendingMeta.push({ kind: "salvage", wreckId: w.id, shipId: ship.id, cargo: gained, materials: w.materials });
			this.queuePlayer(ship.ownerAddress);
		}
	}


	/**
	 * Tow-to-port: a sunk PLAYER hull cannot be steered (applyInput gates on
	 * `active`) and repair requires physically being at a harbour — so a hull that
	 * sinks in open water would soft-lock forever. Instead, every tick we drift a
	 * sunk, owned, player-driven hull toward its nearest port under tow at a slow
	 * constant rate; once inside the harbour radius it sits there, ready to repair.
	 * Auto-mode ghost traders are NOT towed — a sunk trader is simply dropped from
	 * the fleet and left as scenery.
	 */
	private evolveTow(dt: number): void {
		for (const ship of this.ships.values()) {
			if (ship.status !== "sunk_needs_repair" || ship.mode !== "player" || !ship.ownerAddress) continue;
			const port = this.nearestPortDef(ship.position.x, ship.position.z);
			if (!port) continue;
			const dx = port.x - ship.position.x;
			const dz = port.z - ship.position.z;
			const d = Math.hypot(dx, dz);
			if (d <= PORT_RADIUS) {
				// Arrived: park it at the dock and stop drifting.
				ship.velocity.x = 0;
				ship.velocity.z = 0;
				continue;
			}
			const tow = Math.min(TOW_SPEED, d / dt); // never overshoot past the dock
			ship.position.x += (dx / d) * tow * dt;
			ship.position.z += (dz / d) * tow * dt;
			ship.velocity.x = (dx / d) * TOW_SPEED;
			ship.velocity.z = (dz / d) * TOW_SPEED;
			// Point the derelict along its tow line so the client hull faces travel.
			ship.heading = Math.atan2(dx, dz);
		}
	}

	/** Cost in cargo units to repair a given hull class (shown in the dock UI). */
	repairCost(shipClass: ShipClass): number {
		return Math.ceil(SHIP_CLASSES[shipClass].hullMax / 2);
	}

	/**
	 * Send one of a player's owned hulls out as an auto-mode ghost trader: it
	 * plies the trade routes on its own, banking cargo into the owner's purse
	 * each time it docks. This is the "own many, sail one" fleet loop.
	 */
	dispatch(address: string, name: string, tokenId?: bigint): ShipState {
		// A DEFINED run: pick two distinct ports so the trader plies a recognisable
		// route rather than free-cruising — the "own many, sail one" ghost-fleet
		// loop, now with an actual origin/destination the owner can picture.
		const start = Math.floor(Math.random() * PORT_DEFS.length);
		let end = Math.floor(Math.random() * PORT_DEFS.length);
		while (end === start) end = Math.floor(Math.random() * PORT_DEFS.length);
		const port = PORT_DEFS[start];
		const ship = this.spawnShip({
			name: name || "Dispatched Trader",
			shipClass: "merchant",
			faction: "merchant",
			mode: "auto",
			ownerAddress: address,
			tokenId,
			position: { x: port.x + (Math.random() * 40 - 20), y: 0, z: port.z + (Math.random() * 40 - 20) },
			heading: Math.random() * Math.PI * 2,
		});
		const sim = this.sim.get(ship.id);
		if (sim) {
			sim.routeA = start;
			sim.routeB = end;
			// Head straight for the far end of the run so the route is live on launch.
			sim.dest = { x: PORT_DEFS[end].x, y: 0, z: PORT_DEFS[end].z };
		}
		this.ledger(address).fleet.push(ship.id);
		this.queuePlayer(address);
		return ship;
	}

	/**
	 * Every tick: uncover treasure under player hulls, and let the auto-mode ghost
	 * fleet bank its trade runs. Both are pure off-chain economy; neither touches
	 * the chain. Runs after movement so positions this tick are final.
	 */
	private evolveEconomy(): void {
		for (const ship of this.ships.values()) {
			if (ship.status !== "active") continue;

			// Treasure: any hull (player or ghost) inside a cache's radius digs it.
			if (!ship.ownerAddress) continue; // only owned hulls build a purse
			for (const poi of POI_DEFS) {
				if (this.claimedPois.has(poi.id)) continue;
				if (Math.hypot(poi.x - ship.position.x, poi.z - ship.position.z) > POI_RADIUS) continue;
				this.claimedPois.add(poi.id);
				const capacity = SHIP_CLASSES[ship.shipClass].cargoCapacity + this.bonuses(ship).cargo;
				const gained = Math.min(capacity - ship.cargo, poi.cargo);
				ship.cargo += gained;
				this.pendingMeta.push({
					kind: "poi",
					poiId: poi.id,
					shipId: ship.id,
					cargo: gained,
					rare: poi.kind === "rare",
					tier: poi.tier,
					ownerAddress: ship.ownerAddress,
				});
				this.queuePlayer(ship.ownerAddress);
			}

			// Salvage: a player hull sailing over a debris field dives it.
			this.salvageWrecks(ship);

			// Ghost-fleet passive income: an owner's AUTO trader banks a trade profit
			// once each time it enters a port radius (edge-detected on atPort).
			const sim = this.sim.get(ship.id);
			if (!sim) continue;
			const atPort = Boolean(this.portAt(ship.position.x, ship.position.z));
			if (atPort && !sim.atPort && ship.mode === "auto" && ship.faction === "merchant") {
				this.ledger(ship.ownerAddress).purse += 8;
				this.queuePlayer(ship.ownerAddress);
			}
			sim.atPort = atPort;
		}
	}

	/**
	 * Weather as a mechanic (design spec): a storm takes a toll on hulls caught
	 * under sail in open water. Every tick an ACTIVE hull that is (a) not sheltered
	 * inside a port radius and (b) carrying way (throttle up) loses hull points
	 * proportional to the live storm envelope. Calm seas do nothing; the crest of a
	 * squall will founder an unwary or battle-damaged captain — sinking them with no
	 * killer, so their cargo is simply lost to the sea (cargo-lost-on-sink).
	 */
	private evolveStormDamage(dt: number): void {
		const storm = this.stormIntensity;
		// Sub-threshold weather is just weather, not a threat — no grinding damage.
		// Only a genuine squall (storm envelope past ~1/3) starts to take a toll.
		if (storm < 0.35) return;
		const rate = STORM_DAMAGE_PER_SEC * (storm - 0.35) / 0.65;
		for (const ship of this.ships.values()) {
			if (ship.status !== "active") continue;
			const sim = this.sim.get(ship.id);
			// Sheltered at anchor in a harbour, or becalmed with sails furled, is safe.
			if (this.portAt(ship.position.x, ship.position.z)) continue;
			if (!sim || sim.throttle <= 0.05) continue;
			// The toll scales with how much sail you carry: run before the storm at
			// full speed and it bites; reef to a cautious crawl and you shrug it off.
			const exposure = Math.min(1, sim.throttle);
			ship.hull -= rate * exposure * dt;
			if (ship.hull <= 0) this.resolveSink(ship);
		}
	}

	/**
	 * Kraken world event (design spec): on a slow timer a lone elite hull rises in
	 * deep water and hunts the nearest ship of ANY faction, then sinks back and the
	 * cycle restarts. It reuses the exact auto-mode pipeline (same helm channels,
	 * same authoritative fire()), so it can never desync from what clients draw —
	 * it just appears as another (very unwelcome) hull in the snapshot.
	 */
	private evolveKraken(dt: number): void {
		// Retire a destroyed Kraken and schedule its next surfacing.
		if (this.krakenId) {
			const k = this.ships.get(this.krakenId);
			if (!k || k.status !== "active") {
				if (k) this.despawnShip(this.krakenId);
				this.krakenId = null;
				this.nextKrakenAt = this.weatherTime + KRAKEN_PERIOD_S;
				return;
			}
			// Drive the hunt: closest active hull regardless of faction, broadside in reach.
			const sim = this.sim.get(k.id);
			if (sim) {
				const prey = this.nearestShip(k, ["pirate", "naval", "merchant"], SHIP_CLASSES[k.shipClass].range + 260, k.id);
				if (prey) {
					this.steer(k, sim, interceptPoint(k, prey), 1);
					const d = dist(k.position, prey.position);
					if (d < SHIP_CLASSES[k.shipClass].range * 0.85 && d > 24) {
						this.fire(k.id, Math.atan2(prey.position.x - k.position.x, prey.position.z - k.position.z));
					}
				} else {
					this.cruise(k, sim);
				}
			}
			return;
		}
		if (this.weatherTime >= this.nextKrakenAt) this.krakenId = this.spawnKraken().id;
	}

	/** Surface the Kraken far from every active hull, in deep water off any port. */
	private spawnKraken(): ShipState {
		let best: Vec3 = { x: 0, y: 0, z: WORLD_SEA_RADIUS * 0.6 };
		let bestScore = -Infinity;
		for (let i = 0; i < 12; i++) {
			const a = Math.random() * Math.PI * 2;
			const r = WORLD_SEA_RADIUS * (0.35 + Math.random() * 0.5);
			const p = { x: Math.cos(a) * r, y: 0, z: Math.sin(a) * r };
			// Score = distance to the nearest other hull; pick the most isolated spot.
			let nearest = Infinity;
			for (const s of this.ships.values()) {
				if (s.status !== "active") continue;
				nearest = Math.min(nearest, dist(p, s.position));
			}
			if (nearest > bestScore) {
				bestScore = nearest;
				best = p;
			}
		}
		return this.spawnShip({
			name: "The Kraken",
			shipClass: "imperial",
			faction: "pirate",
			mode: "auto",
			position: best,
			heading: Math.atan2(-best.x, -best.z),
		});
	}

	/**
	 * Auto-mode hulls are server-driven. They are broadcast to clients exactly
	 * like player ships — the "ghost fleet" the design calls for — so a solo
	 * player still shares a living sea, and an owner's dispatched ships earn
	 * passive income on a trade run that can genuinely be sunk en route.
	 *
	 * Each faction runs one readable behaviour:
	 *  - merchant: ply a fixed trade route, and RUN from the nearest pirate.
	 *  - pirate:   hunt the nearest non-pirate hull; broaden the bow and fire
	 *              when it comes to hand; otherwise cruise the waypoints.
	 *  - naval:    patrol, and chase down the nearest pirate.
	 *
	 * The autopilot only ever writes the same helm channels a human does
	 * (throttle + rudder) and calls the same authoritative fire(); there is no
	 * privileged AI physics, so nothing can desync from what the client draws.
	 */
	private evolveAutopilot(): void {
		for (const ship of this.ships.values()) {
			if (ship.mode !== "auto" || ship.status !== "active") continue;
			const sim = this.sim.get(ship.id);
			if (!sim) continue;

			switch (ship.faction) {
				case "merchant": {
					const threat = this.nearestShip(ship, ["pirate"], 160);
					if (threat) this.steer(ship, sim, awayPoint(ship, threat), 1);
					else if (sim.routeA >= 0) this.plyRoute(ship, sim);
					else this.cruise(ship, sim);
					break;
				}
				case "pirate": {
					const prey = this.nearestShip(ship, ["merchant", "naval", "pirate"], SHIP_CLASSES[ship.shipClass].range + 90, ship.id);
					if (prey) {
						this.steer(ship, sim, interceptPoint(ship, prey), 1);
						// Open the gun decks once the kill is in reach and roughly
						// off the beam, so it plays as a broadside, not a bow chaser.
						const d = dist(ship.position, prey.position);
						if (d < SHIP_CLASSES[ship.shipClass].range * 0.8 && d > 24) {
							this.fire(ship.id, Math.atan2(prey.position.x - ship.position.x, prey.position.z - ship.position.z));
						}
					} else this.cruise(ship, sim);
					break;
				}
				case "naval": {
					// The navy's remit: hunt pirates on sight, AND hunt any captain
					// whose standing with the navy has fallen to outlaw levels —
					// which is what plundering merchants (see REP_ON_SINK) does to
					// you. So preying on trade genuinely draws a naval hunt on the
					// aggressor, not just anyone wearing a black flag.
					const foe = this.nearestNavalTarget(ship, 320);
					if (foe) {
						this.steer(ship, sim, interceptPoint(ship, foe), 1);
						const d = dist(ship.position, foe.position);
						if (d < SHIP_CLASSES[ship.shipClass].range * 0.8 && d > 24) {
							this.fire(ship.id, Math.atan2(foe.position.x - ship.position.x, foe.position.z - ship.position.z));
						}
					} else this.cruise(ship, sim);
					break;
				}
			}
		}
	}

	/** Follow the waypoint loop: aim at the current port, advance when close. */
	private cruise(ship: ShipState, sim: ShipSim): void {
		if (!sim.dest || dist(ship.position, sim.dest) < 90) sim.dest = randomWaypoint();
		this.steer(ship, sim, sim.dest, 1);
	}

	/**
	 * Ply a DEFINED port-to-port run: hold bearing for the active end, and once
	 * the hull is inside that harbour's radius, swap the ends and re-aim for the
	 * other. This is the dispatched ghost-fleet trader's route; the cargo banking
	 * itself happens in evolveEconomy on the port-arrival edge, so the arrival
	 * detection here and the passive income there share one ground truth.
	 */
	private plyRoute(ship: ShipState, sim: ShipSim): void {
		const active = PORT_DEFS[sim.routeB];
		if (Math.hypot(active.x - ship.position.x, active.z - ship.position.z) < PORT_RADIUS * 0.6) {
			// Reached the far end — turn the run around.
			[sim.routeA, sim.routeB] = [sim.routeB, sim.routeA];
			sim.dest = { x: PORT_DEFS[sim.routeB].x, y: 0, z: PORT_DEFS[sim.routeB].z };
		} else if (!sim.dest) {
			sim.dest = { x: active.x, y: 0, z: active.z };
		}
		this.steer(ship, sim, sim.dest ?? active, 1);
	}

	/** Set helm channels so the hull steers toward `target` via the rudder. */
	private steer(ship: ShipState, sim: ShipSim, target: Vec3, throttle: number): void {
		const desired = Math.atan2(target.x - ship.position.x, target.z - ship.position.z);
		const err = shortestAngle(ship.heading, desired);
		// Dead downwind or becalmed, power on and let the physics stall; only
		// ease sheets when clawing to windward so the AI still makes way.
		sim.throttle = Math.abs(err) > 2.4 ? 0.35 : throttle;
		sim.rudder = clamp(err * 1.4, -1, 1);
	}

	/** Nearest active ship whose faction is in `wanted`, within `maxDist`. */
	private nearestShip(from: ShipState, wanted: ShipState["faction"][], maxDist: number, excludeId?: string): ShipState | null {
		let best: ShipState | null = null;
		let bestD = maxDist;
		for (const s of this.ships.values()) {
			if (s.id === from.id || s.id === excludeId || s.status !== "active") continue;
			if (!wanted.includes(s.faction)) continue;
			const d = dist(from.position, s.position);
			if (d < bestD) {
				bestD = d;
				best = s;
			}
		}
		return best;
	}

	/**
	 * A naval hull's prey: any pirate on sight, plus any PLAYER-owned hull whose
	 * owner's standing with the navy has fallen to outlaw levels (see
	 * NAVAL_OUTLAW_REP). The second clause is what makes plundering merchants draw
	 * the navy down on the aggressor — sinking trade shifts REP_ON_SINK.naval
	 * negative for the killer's owner, and once past the threshold a warship will
	 * break off its pirate patrol to chase THEM specifically.
	 */
	private nearestNavalTarget(from: ShipState, maxDist: number): ShipState | null {
		let best: ShipState | null = null;
		let bestD = maxDist;
		for (const s of this.ships.values()) {
			if (s.id === from.id || s.status !== "active") continue;
			const hostile =
				s.faction === "pirate" ||
				(s.ownerAddress !== undefined &&
					(this.players.get(s.ownerAddress.toLowerCase())?.reputation.naval ?? 0) <= NAVAL_OUTLAW_REP);
			if (!hostile) continue;
			const d = dist(from.position, s.position);
			if (d < bestD) {
				bestD = d;
				best = s;
			}
		}
		return best;
	}

	/** Advance one fixed tick. dtSeconds is constant (1 / TICK_RATE_HZ). */
	step(dtSeconds: number): void {
		this.tick++;
		this.evolutionWeather(dtSeconds);
		// Auto-mode hulls choose their helm before movement integrates it.
		this.evolveAutopilot();

		// Normalised wind "blows toward" vector shared by every ship this tick.
		const wlen = Math.hypot(this.weather.wind.x, this.weather.wind.z) || 1;
		const wx = this.weather.wind.x / wlen;
		const wz = this.weather.wind.z / wlen;

		const dt = dtSeconds;

		for (const ship of this.ships.values()) {
			if (ship.status !== "active") continue;
			const sim = this.sim.get(ship.id);
			if (!sim) continue;
			// A hull set alight by fire barrels ticks damage until the burn runs out
			// or it goes under — pressure that forces you to break off and douse, not
			// an auto-kill. Repairing at a dock clears it (see repair()).
			if (sim.burnUntil > 0) {
				if (this.weatherTime < sim.burnUntil) {
					ship.hull -= BURN_DPS * dt;
					if (ship.hull <= 0) {
						sim.burnUntil = 0;
						this.resolveSink(ship);
						continue;
					}
				} else {
					sim.burnUntil = 0;
				}
			}
			// Points-of-sail: bow dot wind. dot=+1 running downwind, 0 beam
			// reach, -1 beating into the wind. Beam is fastest, upwind slowest.
			const bowX = Math.sin(ship.heading);
			const bowZ = Math.cos(ship.heading);
			const dot = bowX * wx + bowZ * wz;
			const base = 1 - Math.abs(dot);
			const downwindBonus = Math.max(0, dot) * 0.4;
			const sailEfficiency = Math.min(1, 0.15 + 0.7 * base + downwindBonus);

			// Owner's equipped sails lift this hull's top speed as a fraction.
			const shipMaxSpeed = MAX_SPEED * (1 + this.bonuses(ship).speed);

			// Rigging damage cripple: torn canvas bleeds drive AND steerage. The
			// penalty ramps from full power at 100% sails to near-becalmed at 0% —
			// a ship with shredded sails can barely hold the wind or answer the
			// helm, which is what makes chasing a crippled prize workable and
			// fleeing a rigging-killed duel dangerous. Never a kill, only a leash.
			const sailRatio = Math.max(0, Math.min(1, ship.sails / SHIP_CLASSES[ship.shipClass].sailsMax));
			const sailPower = 0.25 + 0.75 * sailRatio; // 0 sails -> a quarter drive

			// Target speed is commanded sail x points-of-sail. Ease the actual
			// speed toward it with an exponential (frame-rate independent) ramp,
			// so she accelerates out of a dead stop and coasts down when W is
			// released rather than switching instantly between 0 and full.
			// The reef factor grounds a hull standing in shallow water.
			const reefFactor = this.reefGround(ship, dt);
			// Sail ORDER (gear) is the canonical control (task #138): when a gear is
			// engaged it OVERRIDES the raw analog throttle for both target speed and
			// helm authority (travel = fast but sluggish). When null, the hull is
			// analog-driven (gamepad / touch) and `sim.throttle` stands as-is. We fold
			// the gear's throttle back into `sim.throttle` so every downstream reader
			// (storm exposure, HUD mirror) sees the same effective sail set.
			const gearSpec = sim.gear ? SAIL_GEARS[sim.gear] : null;
			if (gearSpec) sim.throttle = gearSpec.throttle;
			const turnFactor = gearSpec ? gearSpec.turnFactor : 1;
			const targetSpeed = sim.throttle * shipMaxSpeed * sailEfficiency * sailPower * reefFactor;
			const ease = 1 - Math.exp(-dt / SAIL_RESPONSE_S);
			sim.speed += (targetSpeed - sim.speed) * ease;
			if (Math.abs(sim.speed) < 0.001) sim.speed = 0;

			// --- Helm ---------------------------------------------------------
			// The rudder is a hydrofoil, so its authority comes from water flowing
			// past it: force scales roughly with speed squared, but squared is
			// punishing at low speed, so we ramp linearly and gate it hard near
			// zero. A stopped ship therefore has NO steerage way — the wheel turns
			// and nothing happens, which is the single biggest thing that makes
			// steering feel like a ship rather than a car.
			const speedRatio = Math.abs(sim.speed) / shipMaxSpeed;
			const authority = Math.max(
				0,
				Math.min(1, (speedRatio - STEERAGE_MIN_SPEED / MAX_SPEED) / RUDDER_FULL_AUTHORITY)
			);
			// A hull also turns more easily once it has way on, so scale the top
			// rate too — a drifting ship answers the helm sluggishly even when it
			// is moving, which is what "wallowing" feels like. Torn rigging cuts
			// the effective turn rate: she can point, but she will not come about.
			const targetYaw = sim.rudder * RUDDER_MAX_TURN_RATE * authority * (0.4 + 0.6 * sailRatio) * turnFactor;

			// The rudder answers quickly but the HULL does not: momentum means the
			// turn builds and then persists. A slower response when reducing helm
			// than when applying it gives the hull that carried weight.
			const turning = Math.abs(targetYaw) > Math.abs(sim.yawRate);
			const yawResponse = turning ? YAW_RESPONSE_S : YAW_RESPONSE_S * 1.8;
			sim.yawRate += (targetYaw - sim.yawRate) * (1 - Math.exp(-dt / yawResponse));
			if (Math.abs(sim.yawRate) < 1e-4) sim.yawRate = 0;

			ship.angularVelocity = sim.yawRate;
			ship.heading += sim.yawRate * dt;
			// Keep heading in (-pi, pi]. Unwrapped it grows without bound as a hull
			// circles, and a fresh client that lerps its mesh toward a huge value
			// sweeps the extra full turns — the "ship spins after refresh" bug.
			if (ship.heading > Math.PI) ship.heading -= Math.PI * 2;
			else if (ship.heading <= -Math.PI) ship.heading += Math.PI * 2;

			// Heading feeds back into the velocity direction, so a turn curves the
			// track rather than the ship sliding sideways to a new heading.
			const bowXNow = Math.sin(ship.heading);
			const bowZNow = Math.cos(ship.heading);

			// Current: everything drifts gently downwind regardless of heading.
			const drift = this.weather.windSpeed * 0.05;

			// The velocity the sails WOULD produce this instant (bow line + a touch
			// of downwind set). We do NOT assign it directly — see LEEWAY_RESPONSE_S:
			// easing the real velocity toward it is what gives the hull its turning
			// momentum so it carves through a turn instead of snapping to the heading.
			const wantVX = bowXNow * sim.speed + wx * drift;
			const wantVZ = bowZNow * sim.speed + wz * drift;
			const vEase = 1 - Math.exp(-dt / LEEWAY_RESPONSE_S);
			ship.velocity.x += (wantVX - ship.velocity.x) * vEase;
			ship.velocity.z += (wantVZ - ship.velocity.z) * vEase;
			ship.position.x += ship.velocity.x * dt;
			ship.position.z += ship.velocity.z * dt;

			// Keep the world bounded to the open-ocean play area.
			const dist = Math.hypot(ship.position.x, ship.position.z);
			if (dist > WORLD_SEA_RADIUS) {
				const k = WORLD_SEA_RADIUS / dist;
				ship.position.x *= k;
				ship.position.z *= k;
			}
		}

		// Hulls are circles on the water; separate any that overlap this tick so
		// no ship can sail THROUGH another. Runs after movement (positions final)
		// and before combat so a broadside resolves against the corrected hulls.
		this.resolveCollisions();

		// Resolve in-flight broadsides after movement so a hull's position at
		// impact is the authoritative one ships occupy this tick.
		this.stepForts();
		this.stepProjectiles();
		// Expire lapsed parley demands and ceasefire windows AFTER combat, so a hull
		// the guns just finished closes its own pending prompt the same tick.
		this.evolveParley();
		// Weather takes its toll on exposed hulls after combat, so a ship the guns
		// didn't finish can still founder in the squall before the economy pass.
		this.evolveStormDamage(dtSeconds);
		// Kraken world event: a scheduled elite hunt, driven through the same AI
		// pipeline as every other auto hull so it stays authoritative end to end.
		this.evolveKraken(dtSeconds);
		// Off-chain economy pass: treasure uncover + ghost-fleet income.
		this.evolveEconomy();
		// Scatter debris fields whose time on the seabed has run out.
		this.evolveWrecks();
		// Drift any sunk player hull toward a harbour so it can be repaired (this
		// is what stops a sinking in open ocean from soft-locking the player).
		this.evolveTow(dtSeconds);
	}

	/**
	 * Push overlapping hulls apart. Ships are modelled as circles of SHIP_RADIUS
	 * on the XZ plane; any pair closer than the sum of their radii is separated
	 * along the centre line, the correction split evenly so neither hull gets a
	 * free pass. A few relaxation iterations clear chained overlaps (a dense
	 * anchorage) that a single pass would leave pinched.
	 */
	private resolveCollisions(): void {
		const hulls = [...this.ships.values()].filter((s) => s.status === "active");
		for (let iter = 0; iter < 4; iter++) {
			for (let i = 0; i < hulls.length; i++) {
				for (let j = i + 1; j < hulls.length; j++) {
					const a = hulls[i];
					const b = hulls[j];

					// Hull = capsule: a segment of half-length along each heading,
					// rounded by half-beam. Separate along the true closest-approach
					// normal so a bow driven into another's broadside shoves the right
					// way, instead of the fake "invisible wall" a centre circle gives.
					const abx = Math.sin(a.heading), abz = Math.cos(a.heading);
					const bbx = Math.sin(b.heading), bbz = Math.cos(b.heading);
					const hal = HULL_HALF_LENGTH[a.shipClass];
					const hbl = HULL_HALF_BEAM[a.shipClass];
					const hbl2 = HULL_HALF_BEAM[b.shipClass];
					const hal2 = HULL_HALF_LENGTH[b.shipClass];

					const ax = a.position.x, az = a.position.z;
					const bx = b.position.x, bz = b.position.z;
					const res = closestGapXZ(
						ax - abx * hal, az - abz * hal, ax + abx * hal, az + abz * hal,
						bx - bbx * hal2, bz - bbz * hal2, bx + bbx * hal2, bz + bbz * hal2
					);

					const minSep = hbl + hbl2;
					if (res.dist >= minSep) continue;

					// Normal from a's closest point toward b's; if the capsules are
					// fully crossed (dist ~0) fall back to centre-to-centre.
					let nx: number, nz: number;
					if (res.dist > 1e-4) {
						nx = res.dx / res.dist;
						nz = res.dz / res.dist;
					} else {
						nx = Math.sin(a.heading);
						nz = Math.cos(a.heading);
					}
					const push = minSep - res.dist;
					a.position.x -= nx * push * 0.5;
					a.position.z -= nz * push * 0.5;
					b.position.x += nx * push * 0.5;
					b.position.z += nz * push * 0.5;
				}
			}
		}
		// Separation can shove a hull past the world edge — re-clamp the bounds.
		for (const s of hulls) {
			const r = Math.hypot(s.position.x, s.position.z);
			if (r > WORLD_SEA_RADIUS) {
				const k = WORLD_SEA_RADIUS / r;
				s.position.x *= k;
				s.position.z *= k;
			}
		}
	}

	/**
	 * Deterministic weather cycle. Everything the client VFX reads (rain,
	 * lightning, cloud, swell, fog) is a pure function of accumulated sim time,
	 * so all clients agree without extra wire traffic. A storm cell builds and
	 * passes roughly every STORM_PERIOD seconds; clear skies dominate so a demo
	 * only occasionally drops into drama — and when it does, it is dramatic.
	 */
	private evolutionWeather(dt: number): void {
		this.weatherTime += dt;
		const t = this.weatherTime;
		const w = this.weather;

		// Slow prevailing veer of the wind direction. Very gentle — the breeze
		// swings a few degrees a minute, never snapping between quarters.
		const ang = t * 0.004;
		w.wind.x = Math.sin(ang);
		w.wind.z = Math.cos(ang);

		// Storm envelope 0..1 from a raised sine, sharpened so CALM IS THE NORM.
		// The period is long (25 min) and the smoothstep floor is high (0.80), so a
		// cell is rare and short: the sky stays clear most of the session and only
		// the crest of a storm banks in rain and fog. The sine still carries the
		// 0.80->0.99 band over ~3 minutes, and the client eases on top of that, so a
		// storm visibly builds and drains rather than snapping on.
		const STORM_PERIOD_S = 1500;
		const raw = 0.5 + 0.5 * Math.sin((t / STORM_PERIOD_S) * Math.PI * 2);
		const storm = smoothstep(0.8, 0.99, raw);
		this.stormIntensity = storm;

		// Every scalar's own wobble runs on a slow clock (periods ~6–12 min) and the
		// storm term is scaled so it lifts the whole field together over minutes.
		w.windSpeed = 5 + 2 * Math.sin(t * 0.011) + storm * 14;
		w.waveAmplitude = clamp(0.55 + 0.12 * Math.sin(t * 0.008) + storm * 1.5, 0.2, 2.2);
		w.cloudCoverage = clamp(0.28 + 0.15 * Math.sin(t * 0.006) + storm * 0.6, 0, 1);
		// Fog is WEATHER, not a permanent veil: it is zero in calm air and only
		// builds with a storm, so clear days are genuinely clear on the horizon.
		w.fogDensity = storm * 0.006;
		// Rain rides the storm crest (storm is already 0 outside the rare cell), so
		// it is present for only a fraction of the session.
		w.rainIntensity = clamp(storm * 1.15, 0, 1);
		w.lightningFrequency = storm > 0.55 ? (storm - 0.55) * 1.4 : 0;
	}

	snapshot(): ShipState[] {
		return [...this.ships.values()].map((s) => structuredClone(s));
	}

	/**
	 * Effective sight range (world units) for THIS weather — the heart of
	 * "weather as cover." Clear air lets you raise a sail and spot a rival hull
	 * far down the horizon; a blowing squall shrinks that to a short leash, so a
	 * raider can lie up in the rain and a merchant can lose a pursuer in the
	 * fog. This drives which hulls actually appear in each player's snapshot.
	 */
	visibilityRange(): number {
		const CLEAR_VIS = 950;
		const STORM_VIS = 300;
		const k = Math.max(0, Math.min(1, this.stormIntensity));
		return CLEAR_VIS + (STORM_VIS - CLEAR_VIS) * k;
	}

	/**
	 * The snapshot AS ONE VIEWER sees it: their own hull always, plus any hull
	 * within the current visibility range of them. Everything else is masked out
	 * by the weather, so a client never receives a position it could not legally
	 * have sighted — the cull is authoritative, not a client-side render trick.
	 * A viewer with no hull yet (spectating the menu) sees the whole field.
	 */
	snapshotFor(viewerShipId: string | undefined): ShipState[] {
		const all = this.snapshot();
		const viewer = viewerShipId ? this.ships.get(viewerShipId) : undefined;
		if (!viewer) return all;
		const range = this.visibilityRange();
		return all.filter((s) => {
			if (s.id === viewer.id) return true;
			// A hull the player OWNS is always known to them (their own ghost
			// fleet, a sunk hull drifting off), regardless of distance.
			if (viewer.ownerAddress && s.ownerAddress === viewer.ownerAddress) return true;
			const d = Math.hypot(s.position.x - viewer.position.x, s.position.z - viewer.position.z);
			return d <= range;
		});
	}

	/**
	 * Persist the OFF-chain world: every player ledger (purse, reputation, ghost
	 * fleet, owned/equipped goods), which treasure caches are spent, the weather
	 * clock, and the id counter. Ships themselves are transient — NPCs reseed and
	 * player hulls re-join on their socket — so only durable state is written. A
	 * version tag lets a future schema migration ignore an incompatible file rather
	 * than crash on boot.
	 */
	serialize(): string {
		const players: Record<string, PlayerRecord> = {};
		for (const [addr, rec] of this.players) players[addr] = rec;
		const kills: Record<string, number> = {};
		for (const [tid, n] of this.killCounts) kills[tid] = n;
		return JSON.stringify({
			v: 1,
			weatherTime: this.weatherTime,
			nextId: this.nextId,
			claimedPois: [...this.claimedPois],
			players,
			kills,
		});
	}

	/** Load a prior serialize() payload; silently ignores a missing/bad/vmismatch file. */
	restore(raw: string | null): void {
		if (!raw) return;
		let data: {
			v?: number;
			weatherTime?: number;
			nextId?: number;
			claimedPois?: number[];
			players?: Record<string, PlayerRecord>;
			kills?: Record<string, number>;
		};
		try {
			data = JSON.parse(raw);
		} catch {
			console.warn("[world] persistence file unreadable; starting fresh");
			return;
		}
		if (data.v !== 1) {
			console.warn(`[world] persistence version ${data.v} not supported; starting fresh`);
			return;
		}
		if (typeof data.weatherTime === "number") this.weatherTime = data.weatherTime;
		if (typeof data.nextId === "number") this.nextId = data.nextId;
		if (Array.isArray(data.claimedPois)) this.claimedPois = new Set(data.claimedPois);
		if (data.players) {
			for (const [addr, rec] of Object.entries(data.players)) {
				this.players.set(addr.toLowerCase(), {
					purse: rec.purse ?? 0,
					reputation: rec.reputation ?? { pirate: 0, naval: 0, merchant: 0 },
					fleet: Array.isArray(rec.fleet) ? rec.fleet : [],
					items: rec.items ?? {},
					equipped: rec.equipped ?? {},
					materials: rec.materials ?? { wood: 0, iron: 0, cloth: 0 },
					repairDebt: Array.isArray(rec.repairDebt) ? rec.repairDebt : [],
				});
			}
		}
		if (data.kills) {
			for (const [tid, n] of Object.entries(data.kills)) {
				if (typeof n === "number") this.killCounts.set(tid, n);
			}
		}
		// Keep the Kraken cycle coherent with the restored clock.
		this.nextKrakenAt = this.weatherTime + KRAKEN_PERIOD_S;
		console.log(
			`[world] restored ${this.players.size} ledger(s), ${this.claimedPois.size} dug cache(s) @ t=${Math.round(this.weatherTime)}s`
		);
	}
}

function clamp(v: number, lo: number, hi: number): number {
	return Math.max(lo, Math.min(hi, v));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
	const t = clamp((x - edge0) / (edge1 - edge0), 0, 1);
	return t * t * (3 - 2 * t);
}

/** Fixed trade anchors NPC hulls ply between. A living, legible sea needs goals
 *  that are the same for every observer, so these are constants, not per-ship. */
const PORT_WAYPOINTS: Vec3[] = [
	{ x: 900, y: 0, z: 300 },
	{ x: -700, y: 0, z: 600 },
	{ x: -1100, y: 0, z: -800 },
	{ x: 800, y: 0, z: -900 },
	{ x: 1500, y: 0, z: -200 },
	{ x: 300, y: 0, z: 1400 },
	{ x: -1500, y: 0, z: 200 },
	{ x: 0, y: 0, z: -1500 },
];

function randomWaypoint(): Vec3 {
	return PORT_WAYPOINTS[Math.floor(Math.random() * PORT_WAYPOINTS.length)];
}

function dist(a: Vec3, b: Vec3): number {
	return Math.hypot(a.x - b.x, a.z - b.z);
}

/**
 * Shortest gap between two 2D (XZ) segments, Ericson's closest-point-of-two-
 * segments from "Real-Time Collision Detection". Returns the separation vector
 * from the closest point on segment 1 to the closest point on segment 2 and its
 * length — the collision normal and penetration depth for capsule hulls.
 */
function closestGapXZ(
	ax: number, az: number, bx: number, bz: number,
	cx: number, cz: number, dx: number, dz: number
): { dist: number; dx: number; dz: number } {
	// Segment 1 = A→B, segment 2 = C→D, all in XZ.
	const d1x = bx - ax, d1z = bz - az;
	const d2x = dx - cx, d2z = dz - cz;
	const rx = ax - cx, rz = az - cz;
	const a = d1x * d1x + d1z * d1z;
	const e = d2x * d2x + d2z * d2z;
	const f = d2x * rx + d2z * rz;

	let s = 0, t = 0;
	if (a <= 1e-9 && e <= 1e-9) {
		s = t = 0; // both degenerate points
	} else if (a <= 1e-9) {
		s = 0;
		t = clamp(f / e, 0, 1);
	} else {
		const c = d1x * rx + d1z * rz;
		if (e <= 1e-9) {
			t = 0;
			s = clamp(-c / a, 0, 1);
		} else {
			const b = d1x * d2x + d1z * d2z;
			const denom = a * e - b * b;
			s = denom > 1e-9 ? clamp((b * f - c * e) / denom, 0, 1) : 0;
			t = (b * s + f) / e;
			if (t < 0) {
				t = 0;
				s = clamp(-c / a, 0, 1);
			} else if (t > 1) {
				t = 1;
				s = clamp((b - c) / a, 0, 1);
			}
		}
	}

	const p1x = ax + d1x * s, p1z = az + d1z * s;
	const p2x = cx + d2x * t, p2z = cz + d2z * t;
	const gx = p2x - p1x, gz = p2z - p1z;
	return { dist: Math.hypot(gx, gz), dx: gx, dz: gz };
}

/** Shortest signed angle from `from` to `to`, wrapped to (-pi, pi]. */
function shortestAngle(from: number, to: number): number {
	let d = (to - from) % (Math.PI * 2);
	if (d > Math.PI) d -= Math.PI * 2;
	if (d < -Math.PI) d += Math.PI * 2;
	return d;
}

/** A point directly opposite the threat, far enough to make distance. */
function awayPoint(ship: ShipState, threat: ShipState): Vec3 {
	let dx = ship.position.x - threat.position.x;
	let dz = ship.position.z - threat.position.z;
	const len = Math.hypot(dx, dz) || 1;
	dx /= len;
	dz /= len;
	return { x: ship.position.x + dx * 400, y: 0, z: ship.position.z + dz * 400 };
}

/** Lead the target along its velocity so a chase closes ahead of it. */
function interceptPoint(ship: ShipState, target: ShipState): Vec3 {
	const t = Math.min(6, dist(ship.position, target.position) / 40);
	return {
		x: target.position.x + target.velocity.x * t,
		y: 0,
		z: target.position.z + target.velocity.z * t,
	};
}
