import { HULL_PRICES } from "@shared/onchain";
import { type ShipClass } from "@shared/index";
import {
	SHOP_CATEGORIES,
	shopItemsBySlot,
	MATERIAL_UNIT_PRICE,
	type MaterialBill,
	type ShopSlot,
	type ShopStat,
} from "@shared/shop";

/**
 * The Shop catalog — the single source of truth for what the merchant page
 * displays. Hulls are the real, buyable on-chain inventory (priced in USDG via
 * HULL_PRICES, minted through ShipStore). The outfitting goods are the off-chain
 * economy: they cost cargo-purse units and, once equipped, bend one ship stat.
 * The good definitions live in the shared `@shared/shop` table so the server can
 * price + apply them authoritatively and this page renders the SAME numbers.
 */

/** One purchasable hull, in display order (cheapest first). */
export interface HullTile {
	cls: ShipClass;
	label: string;
	image: string;
	/** One-line role, shown under the name. */
	role: string;
}

/** A catalogued outfitting good (cannon, sail, …), bought with the cargo purse. */
export interface ShopItem {
	id: string;
	name: string;
	image: string;
	/** Cost in off-chain cargo-purse units. */
	cost: number;
	stat: ShopStat;
	/** The stat delta applied while equipped (flat, or a fraction for maxSpeed). */
	amount: number;
	/**
	 * Salvage bill of materials the good ALSO consumes on purchase. The server
	 * spends what you hold and auto-buys any shortfall off the purse at
	 * MATERIAL_UNIT_PRICE, so this adds to the effective cargo price rather than
	 * hard-blocking the buy.
	 */
	materials: MaterialBill;
}

export interface ShopCategory {
	id: ShopSlot;
	title: string;
	items: ShopItem[];
}

const img = (n: string) => `/store/${n}.png`;

export const HULL_TILES: HullTile[] = [
	{ cls: "starter_sloop", label: "Starter Sloop", image: img("ship_starter_sloop"), role: "Two guns, quick to learn on." },
	{ cls: "raider_sloop", label: "Raider Sloop", image: img("ship_raider_sloop"), role: "Fast hunter for lone prizes." },
	{ cls: "raider_brig", label: "Raider Brig", image: img("ship_raider_brig"), role: "Heavy broadside, strong hull." },
	{ cls: "brigantine", label: "Brigantine", image: img("ship_brigantine"), role: "Balanced raider's workhorse." },
	{ cls: "merchant", label: "Merchant", image: img("ship_merchant"), role: "Deep hold — carry, don't fight." },
	{ cls: "galleon", label: "Galleon", image: img("ship_galleon"), role: "Fortress hull, long range." },
	{ cls: "war_galleon", label: "War Galleon", image: img("ship_war_galleon"), role: "Line-of-battle gun platform." },
	{ cls: "imperial", label: "Imperial Man-o'-War", image: img("ship_imperial"), role: "The apex ship of the line." },
];

/** The shop tile for a hull class (image + label), or undefined if unknown. */
export function hullTile(cls: ShipClass): HullTile | undefined {
	return HULL_TILES.find((h) => h.cls === cls);
}

/** The 6-decimal base-unit price of a hull class (shared with the store). */
export function hullPrice(cls: ShipClass): bigint {
	return HULL_PRICES[cls] ?? 0n;
}

/** Build the browsable goods straight from the shared table (no second source). */
export const ITEM_CATEGORIES: ShopCategory[] = SHOP_CATEGORIES.map((c) => ({
	id: c.id,
	title: c.title,
	items: shopItemsBySlot(c.id).map((it) => ({
		id: it.id,
		name: it.name,
		image: it.image,
		cost: it.cost,
		stat: it.stat,
		amount: it.amount,
		materials: it.materials,
	})),
}));

/** A player's banked salvage counts, keyed the same way as a MaterialBill. */
export interface MaterialHoldings {
	wood: number;
	iron: number;
	cloth: number;
}

/**
 * The cargo-purse price a good ACTUALLY charges right now: its base cargo cost
 * plus the auto-buy cost of any salvage shortfall (the server spends held
 * materials first, then buys what's missing at MATERIAL_UNIT_PRICE). Mirrors
 * `world.buyItem` so the shop never advertises a price the server won't charge.
 */
export function effectivePrice(bill: MaterialBill, held: MaterialHoldings, baseCost: number): number {
	const short =
		Math.max(0, bill.wood - held.wood) +
		Math.max(0, bill.iron - held.iron) +
		Math.max(0, bill.cloth - held.cloth);
	return baseCost + short * MATERIAL_UNIT_PRICE;
}

/** A short human label for an equipped good's effect, e.g. "+6 broadside". */
export function effectLabel(stat: ShopStat, amount: number): string {
	switch (stat) {
		case "broadsideDamage":
			return `+${amount} broadside damage`;
		case "maxSpeed":
			return `+${Math.round(amount * 100)}% top speed`;
		case "range":
			return `+${amount} range`;
		case "reloadSeconds":
			return `−${amount}s reload`;
		case "hullMax":
			return `+${amount} hull`;
		case "cargoCapacity":
			return `+${amount} cargo hold`;
	}
}
