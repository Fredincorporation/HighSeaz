/**
 * The outfitting-goods table — the single source of truth shared by BOTH sides.
 *
 * Currency note: HULLS are the on-chain inventory (real USDG, minted via
 * ShipStore). These GOODS are the OFF-CHAIN economy: they cost cargo-purse units
 * (the same purse repairs are paid from) and, when equipped, bend one ship stat.
 * Keeping the definitions here means the server can price + apply them
 * authoritatively and the React shop renders the exact same numbers — no drift.
 */

/** The six stats a piece of gear can move. */
export type ShopStat =
	| "broadsideDamage"
	| "maxSpeed"
	| "range"
	| "reloadSeconds"
	| "cargoCapacity"
	| "hullMax";

/**
 * Salvage material keys (task #139). Declared locally (NOT imported from the
 * wire protocol) because this module is consumed by BOTH the Node server, which
 * compiles it under `moduleResolution: NodeNext` (relative imports MUST carry a
 * `.js` extension), and the Turbopack-bundled browser (which will not rewrite a
 * `.js` specifier back to its `.ts` source) — a cross-import would satisfy one
 * side and break the other. The three literal keys are byte-identical to the
 * `SalvageMaterial` union in `./index.ts`, and the server treats the field as
 * `Partial<SalvageLedger>` (which is exactly `Partial<Record<SalvageMaterial,
 * number>>`), so there is no drift on the wire — only a duplication of the
 * smallest possible string union here.
 */
export type ShopMaterial = "wood" | "iron" | "cloth";

/** A bill of materials: how many of each salvage material one good consumes. */
export type MaterialBill = Record<ShopMaterial, number>;

/** Equip slots — one item may be equipped per slot, and each slot feeds one stat. */
export type ShopSlot =
	| "cannons"
	| "sails"
	| "ammo"
	| "cargo"
	| "gear"
	| "hull"
	| "nav"
	| "repair"
	| "special";

export interface ShopItemDef {
	id: string;
	name: string;
	/** Display artwork path (unused by the server). */
	image: string;
	slot: ShopSlot;
	/** Cost in off-chain cargo-purse units. */
	cost: number;
	stat: ShopStat;
	/**
	 * Bonus applied while equipped. Flat for damage/range/hull/cargo; a FRACTION
	 * for maxSpeed (0.1 = +10% top speed); a SECONDS REDUCTION for reloadSeconds.
	 */
	amount: number;
	/**
	 * Salvage materials this good ALSO consumes on purchase (task #139) — a
	 * parallel resource track layered on top of the `cost` purse price. Derived
	 * from the good's `cost` via `materialBill` (not hand-authored), so the shop's
	 * displayed BOM and the server's charged BOM are the same function. The server
	 * treats it as `Partial<SalvageLedger>`: it spends it if the captain HAS it,
	 * else auto-buys the shortfall off the purse, so a purchase NEVER hard-fails.
	 */
	materials: MaterialBill;
}

export interface ShopCategoryDef {
	id: ShopSlot;
	title: string;
}

/** Every slot maps to exactly one stat the server already reads in one place. */
export const SLOT_STAT: Record<ShopSlot, ShopStat> = {
	cannons: "broadsideDamage",
	ammo: "broadsideDamage",
	special: "broadsideDamage",
	sails: "maxSpeed",
	nav: "range",
	gear: "reloadSeconds",
	hull: "hullMax",
	repair: "hullMax",
	cargo: "cargoCapacity",
};

/** Derive a balanced bonus from the price so pricier gear is stronger, by stat. */
function bonusFor(stat: ShopStat, cost: number): number {
	switch (stat) {
		case "broadsideDamage":
			return Math.max(1, Math.round(cost * 0.5));
		case "maxSpeed":
			// Fraction of top speed, 2 decimal places.
			return Math.round(cost * 0.01 * 100) / 100;
		case "range":
			return Math.round(cost * 3);
		case "reloadSeconds":
			// Seconds shaved off the reload, 1 decimal place.
			return Math.round(cost * 0.15 * 10) / 10;
		case "hullMax":
			return Math.round(cost * 2);
		case "cargoCapacity":
			return Math.round(cost * 1.5);
	}
}

const img = (n: string) => `/store/${n}.png`;

/**
 * The salvage bill of materials a good consumes, derived from its `cost` so the
 * shop display and the server charge never drift (mirrors how `bonusFor` derives
 * the stat from the price). Materials lean into the good's nature:
 *   - hull / repair  -> timber-dominant (planking, frames, stores).
 *   - cannons / ammo -> iron-dominant (shot, gunmetal, bracing).
 *   - sails          -> canvas-dominant (bolt after bolt of cloth).
 *   - cargo / gear / nav / special -> a light, mixed skim.
 * Everything scales roughly with the square root of price so a 2-cost kit asks a
 * couple units while a 40-cost curio asks a modest hoard — a nudge, not a wall.
 */
export function materialBill(stat: ShopStat, cost: number): MaterialBill {
	const s = Math.max(1, Math.round(Math.sqrt(cost)));
	switch (stat) {
		case "hullMax":
			return { wood: 2 * s, iron: Math.ceil(s / 2), cloth: 0 };
		case "broadsideDamage":
			return { wood: Math.ceil(s / 2), iron: 2 * s, cloth: Math.ceil(s / 2) };
		case "maxSpeed":
			return { wood: Math.ceil(s / 2), iron: 0, cloth: 2 * s };
		case "cargoCapacity":
			return { wood: s, iron: 0, cloth: s };
		case "reloadSeconds":
			return { wood: s, iron: s, cloth: 0 };
		case "range":
			return { wood: Math.ceil(s / 2), iron: Math.ceil(s / 2), cloth: Math.ceil(s / 2) };
	}
}

/** Cargo-purse price of ONE unit of a salvage material bought when short. */
export const MATERIAL_UNIT_PRICE = 1;

/** Pure cargo cost of auto-buying a materials bill the buyer is entirely short on. */
export function materialBuyPrice(bill: MaterialBill): number {
	return (bill.wood + bill.iron + bill.cloth) * MATERIAL_UNIT_PRICE;
}

/** Raw goods data grouped by slot, in the order the shop browses them. */
const RAW: Array<{ slot: ShopSlot; title: string; items: Array<{ id: string; name: string; image: string; cost: number }> }> = [
	{
		slot: "cannons",
		title: "Cannons",
		items: [
			{ id: "cannon_light", name: "Light Nine-pounder", image: img("cannon_light"), cost: 2 },
			{ id: "cannon_medium", name: "Medium Twelve-pounder", image: img("cannon_medium"), cost: 4 },
			{ id: "cannon_heavy", name: "Heavy Twenty-four", image: img("cannon_heavy"), cost: 8 },
			{ id: "cannon_longrange", name: "Long-range Culverin", image: img("cannon_longrange"), cost: 12 },
			{ id: "cannon_reinforced", name: "Reinforced Carronade", image: img("cannon_reinforced"), cost: 15 },
			{ id: "cannon_ornate", name: "Ornate Brass Gun", image: img("cannon_ornate"), cost: 20 },
			{ id: "cannon_legendary", name: "Legendary Smasher", image: img("cannon_legendary"), cost: 30 },
		],
	},
	{
		slot: "sails",
		title: "Sails",
		items: [
			{ id: "sail_linen", name: "Linen Course", image: img("sail_linen"), cost: 1 },
			{ id: "sail_canvas", name: "Canvas Rig", image: img("sail_canvas"), cost: 2 },
			{ id: "sail_silk", name: "Silk Kite", image: img("sail_silk"), cost: 5 },
			{ id: "sail_crimson", name: "Crimson Ensign Set", image: img("sail_crimson"), cost: 6 },
			{ id: "sail_reinforced", name: "Reinforced Storm Sails", image: img("sail_reinforced"), cost: 8 },
			{ id: "sail_storm", name: "Storm Triset", image: img("sail_storm"), cost: 10 },
			{ id: "sail_war", name: "War Canvas", image: img("sail_war"), cost: 12 },
			{ id: "sail_imperial", name: "Imperial Grand Sail", image: img("sail_imperial"), cost: 18 },
			{ id: "sail_legendary", name: "Legendary Skyweave", image: img("sail_legendary"), cost: 25 },
		],
	},
	{
		slot: "ammo",
		title: "Ammunition",
		items: [
			{ id: "ammo_roundshot", name: "Round Shot", image: img("ammo_roundshot"), cost: 1 },
			{ id: "ammo_barshot", name: "Bar Shot", image: img("ammo_barshot"), cost: 2 },
			{ id: "ammo_canister", name: "Canister", image: img("ammo_canister"), cost: 3 },
			{ id: "ammo_grapeshot", name: "Grapeshot", image: img("ammo_grapeshot"), cost: 3 },
			{ id: "ammo_chainshot", name: "Chain Shot", image: img("ammo_chainshot"), cost: 4 },
			{ id: "ammo_heatedshot", name: "Heated Shot", image: img("ammo_heatedshot"), cost: 5 },
			{ id: "ammo_explosive", name: "Explosive Shell", image: img("ammo_explosive"), cost: 7 },
			{ id: "ammo_cursed", name: "Cursed Shot", image: img("ammo_cursed"), cost: 12 },
			{ id: "ammo_silver", name: "Silver Shot", image: img("ammo_silver"), cost: 15 },
		],
	},
	{
		slot: "cargo",
		title: "Cargo",
		items: [
			{ id: "cargo_crate", name: "Trade Crate", image: img("cargo_crate"), cost: 1 },
			{ id: "cargo_spice", name: "Spice Bale", image: img("cargo_spice"), cost: 3 },
			{ id: "cargo_rum", name: "Rum Barrel", image: img("cargo_rum"), cost: 4 },
			{ id: "cargo_treasure", name: "Treasure Chest", image: img("cargo_treasure"), cost: 20 },
		],
	},
	{
		slot: "gear",
		title: "Deck Gear",
		items: [
			{ id: "gear_anchor", name: "Bent Iron Anchor", image: img("gear_anchor"), cost: 2 },
			{ id: "gear_rope", name: "Hemp Rope Coil", image: img("gear_rope"), cost: 1 },
			{ id: "gear_wheel", name: "Helm Wheel", image: img("gear_wheel"), cost: 3 },
			{ id: "gear_figurehead", name: "Carved Figurehead", image: img("gear_figurehead"), cost: 8 },
		],
	},
	{
		slot: "hull",
		title: "Hull Upgrades",
		items: [
			{ id: "hull_timber", name: "Seasoned Oak Timber", image: img("hull_timber"), cost: 3 },
			{ id: "hull_copper", name: "Copper Sheathing", image: img("hull_copper"), cost: 6 },
			{ id: "hull_ironbrace", name: "Iron Bracing", image: img("hull_ironbrace"), cost: 5 },
			{ id: "hull_bulwark", name: "Reinforced Bulwark", image: img("hull_bulwark"), cost: 9 },
		],
	},
	{
		slot: "nav",
		title: "Navigation",
		items: [
			{ id: "nav_chart", name: "Coastal Chart", image: img("nav_chart"), cost: 2 },
			{ id: "nav_compass", name: "Binnacle Compass", image: img("nav_compass"), cost: 3 },
			{ id: "nav_lantern", name: "Signal Lantern", image: img("nav_lantern"), cost: 1 },
			{ id: "nav_spyglass", name: "Brass Spyglass", image: img("nav_spyglass"), cost: 5 },
		],
	},
	{
		slot: "repair",
		title: "Repair Stores",
		items: [
			{ id: "repair_kit", name: "Carpenter's Kit", image: img("repair_kit"), cost: 2 },
			{ id: "repair_timber", name: "Repair Timber", image: img("repair_timber"), cost: 1 },
			{ id: "repair_tar", name: "Barrel of Tar", image: img("repair_tar"), cost: 1 },
			{ id: "repair_sailneedle", name: "Sail & Needle", image: img("repair_sailneedle"), cost: 2 },
		],
	},
	{
		slot: "special",
		title: "Curios",
		items: [
			{ id: "special_horseshoe", name: "Lucky Horseshoe", image: img("special_horseshoe"), cost: 10 },
			{ id: "special_ghostlantern", name: "Ghost Lantern", image: img("special_ghostlantern"), cost: 18 },
			{ id: "special_krakeneeye", name: "Kraken's Eye", image: img("special_krakeneeye"), cost: 40 },
		],
	},
];

export const SHOP_CATEGORIES: ShopCategoryDef[] = RAW.map((c) => ({ id: c.slot, title: c.title }));

export const SHOP_ITEMS: ShopItemDef[] = RAW.flatMap((c) => {
	const stat = SLOT_STAT[c.slot];
	return c.items.map((it) => ({
		...it,
		slot: c.slot,
		stat,
		amount: bonusFor(stat, it.cost),
		materials: materialBill(stat, it.cost),
	}));
});

const BY_ID = new Map(SHOP_ITEMS.map((i) => [i.id, i]));

export function shopItemById(id: string): ShopItemDef | undefined {
	return BY_ID.get(id);
}

/** Items belonging to a slot, for the shop's per-category browse. */
export function shopItemsBySlot(slot: ShopSlot): ShopItemDef[] {
	return SHOP_ITEMS.filter((i) => i.slot === slot);
}
