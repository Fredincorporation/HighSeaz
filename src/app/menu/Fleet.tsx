"use client";

import { type PlayerPublicState } from "@shared/index";
import { SHOP_ITEMS, type ShopSlot } from "@shared/shop";
import { type GameHandle } from "@/game";
import { effectLabel, hullTile } from "@/game/shop/catalog";
import { asset } from "@/game/core/assets";

/**
 * Fleet & Ledger — the player's holdings on one page, distinct from the Shop
 * (which is where you BUY). Everything here is read-only and drawn from the two
 * ledgers the game keeps:
 *
 *  - Off-chain (the live `ledger` from the server): cargo purse, faction
 *    reputation, the ghost-fleet hulls currently auto-sailing, and every outfitting
 *    good owned + which one is equipped per slot.
 *  - On-chain: the count of hulls this wallet owns (a live ShipStore read), shown
 *    alongside so the player sees the full picture of what's theirs.
 *
 * The purse, reputation, and items only exist while connected to the live sea, so
 * on the title (before Set Sail) they render as "—" / empty with an explanatory note.
 */

const GOLD = "#e6c079";

// Display order for the goods inventory, mirroring the shop tabs.
const SLOT_ORDER: { id: ShopSlot; title: string }[] = [
	{ id: "cannons", title: "Cannons" },
	{ id: "sails", title: "Sails" },
	{ id: "ammo", title: "Ammunition" },
	{ id: "cargo", title: "Cargo" },
	{ id: "gear", title: "Deck Gear" },
	{ id: "hull", title: "Hull Upgrades" },
	{ id: "nav", title: "Navigation" },
	{ id: "repair", title: "Repair Stores" },
	{ id: "special", title: "Curios" },
];

function Stat({ label, value }: { label: string; value: string }) {
	return (
		<div className="rounded-lg border border-white/10 bg-white/5 px-3 py-2">
			<div className="text-[11px] uppercase tracking-[0.15em] text-[#8aa3bd]">{label}</div>
			<div className="mt-0.5 font-mono text-lg font-bold" style={{ color: GOLD }}>
				{value}
			</div>
		</div>
	);
}

export function FleetPanel({
	handle,
	ledger,
	wallet,
	onClose,
}: {
	handle: GameHandle | null;
	/** Live off-chain ledger — null until the player is connected to the sea. */
	ledger: PlayerPublicState | null;
	wallet: string | null;
	onClose: () => void;
}) {
	const hulls = handle ? handle.ownedHullCount() : 0;
	const ownedHulls = handle ? handle.getOwnedHulls() : [];

	// Hulls only carry a class (and thus a picture) while they're live on the sea,
	// so before Set Sail we know the wallet owns N but can't draw them yet.
	const hullsAwaitingSail = ownedHulls.length === 0 && hulls > 0;

	return (
		<div className="absolute inset-0 z-50 flex flex-col bg-[rgba(4,9,16,0.94)] backdrop-blur-[2px]">
			{/* Header */}
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
				<h1 className="text-2xl font-black tracking-[0.12em] text-[#eaf3ff]">⚔ FLEET & LEDGER</h1>
				<button
					type="button"
					onClick={onClose}
					autoFocus
					className="rounded-lg border border-white/15 bg-[rgba(30,60,90,0.9)] px-3 py-1.5 text-sm font-bold text-[#eaf3ff] hover:bg-[rgba(40,75,110,0.95)]"
				>
					← Back
				</button>
			</div>

			<div className="flex-1 overflow-y-auto px-5 py-4">
				{/* Holdings */}
				<div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
					<Stat label="Hulls owned" value={wallet ? String(hulls) : "—"} />
					<Stat label="Cargo purse" value={ledger ? String(ledger.purse) : "—"} />
					<Stat label="Ghost fleet" value={ledger ? String(ledger.fleet.length) : "—"} />
					<Stat label="Wallet" value={wallet ? `${wallet.slice(0, 4)}…${wallet.slice(-4)}` : "None"} />
				</div>

				{ownedHulls.length > 0 && (
					<section className="mt-6">
						<h2 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[#8aa3bd]">Your hulls</h2>
						<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
							{ownedHulls.map((h) => {
								const tile = hullTile(h.shipClass);
								return (
									<div
										key={h.shipId}
										className={`flex items-center gap-2 overflow-hidden rounded-xl border bg-[rgba(10,20,34,0.85)] p-2 ${
											h.isSelf ? "border-[#38bdf8]" : "border-white/10"
										}`}
									>
										{tile && (
											<img src={asset(tile.image)} alt={tile.label} className="h-14 w-14 shrink-0 object-contain" draggable={false} />
										)}
										<div className="min-w-0">
											<div className="truncate text-sm font-bold text-[#eaf3ff]" title={h.name}>
												{h.name}
											</div>
											<div className="truncate text-[11px] text-[#c9d6e6]">{tile?.label ?? h.shipClass}</div>
											<div className="text-[11px]" style={{ color: h.isSelf ? "#38bdf8" : "#8aa3bd" }}>
												{h.isSelf ? "at the helm" : "auto-sailing"}
											</div>
										</div>
									</div>
								);
							})}
						</div>
					</section>
				)}

				{hullsAwaitingSail && (
					<p className="mt-4 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-[#8aa3bd]">
						You own {hulls} hull{hulls === 1 ? "" : "s"} — set sail to bring them onto the sea and see each one here.
					</p>
				)}

				{!ledger && (
					<p className="mt-4 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-[#8aa3bd]">
						Purse, reputation and equipped goods show up once you set sail and connect to the open sea.
					</p>
				)}

				{ledger && (
					<>
						{/* Banked salvage — the materials every outfitting good consumes */}
						<section className="mt-6">
							<h2 className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-[#8aa3bd]">Salvage materials</h2>
							<div className="flex flex-wrap gap-3">
								{([
									{ key: "wood", glyph: "🪵", name: "Timber" },
									{ key: "iron", glyph: "⛓", name: "Iron" },
									{ key: "cloth", glyph: "🧵", name: "Canvas" },
								] as const).map((m) => (
									<Stat key={m.key} label={`${m.glyph} ${m.name}`} value={String(ledger.materials[m.key])} />
								))}
							</div>
							<p className="mt-2 text-xs text-[#8aa3bd]">
								Outfitting goods burn these on top of their cargo price — anything you lack is auto-bought from the purse. Dive wrecks and take prizes to bank more.
							</p>
						</section>

						{/* Faction reputation */}
						<section className="mt-6">
							<h2 className="mb-2 text-xs font-bold uppercase tracking-[0.2em] text-[#8aa3bd]">Standing</h2>
							<div className="flex flex-wrap gap-3">
								{(Object.keys(ledger.reputation) as (keyof typeof ledger.reputation)[]).map((faction) => (
									<div key={faction} className="min-w-[140px] flex-1 rounded-lg border border-white/10 bg-[rgba(10,20,34,0.85)] px-3 py-2">
										<div className="flex items-center justify-between">
											<span className="text-sm font-bold capitalize text-[#eaf3ff]">{faction}</span>
											<span className="font-mono text-sm" style={{ color: ledger.reputation[faction] >= 0 ? "#9be8a0" : "#ff9b9b" }}>
												{ledger.reputation[faction] > 0 ? `+${ledger.reputation[faction]}` : ledger.reputation[faction]}
											</span>
										</div>
										<div className="mt-1.5 h-1.5 overflow-hidden rounded-full bg-white/10">
											<div
												className="h-full rounded-full"
												style={{
													width: `${Math.max(0, Math.min(100, ledger.reputation[faction] + 50))}%`,
													background: GOLD,
												}}
											/>
										</div>
									</div>
								))}
							</div>
						</section>

						{/* Owned goods, grouped by slot, showing what's equipped */}
						<section className="mt-6">
							<h2 className="mb-3 text-xs font-bold uppercase tracking-[0.2em] text-[#8aa3bd]">Owned goods</h2>
							<div className="flex flex-col gap-4">
								{SLOT_ORDER.map((slot) => {
									const owned = SHOP_ITEMS.filter((it) => it.slot === slot.id && (ledger.items[it.id] ?? 0) > 0);
									if (owned.length === 0) return null;
									return (
										<div key={slot.id}>
											<h3 className="mb-1.5 text-sm font-bold text-[#c9d6e6]">{slot.title}</h3>
											<div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-4">
												{owned.map((it) => {
													const equipped = ledger.equipped[slot.id] === it.id;
													return (
														<div
															key={it.id}
															className={`flex items-center gap-2 overflow-hidden rounded-xl border bg-[rgba(10,20,34,0.85)] p-2 ${
																equipped ? "border-[#38bdf8]" : "border-white/10"
															}`}
														>
															<img src={asset(it.image)} alt={it.name} className="h-12 w-12 shrink-0 object-contain" draggable={false} />
															<div className="min-w-0">
																<div className="truncate text-xs font-bold text-[#eaf3ff]" title={it.name}>
																	{it.name}
																</div>
																<div className="text-[11px] text-[#9be8a0]">{effectLabel(it.stat, it.amount)}</div>
																<div className="text-[11px] text-[#8aa3bd]">
																	x{ledger.items[it.id]} · {equipped ? <span style={{ color: "#38bdf8" }}>equipped</span> : "stowed"}
																</div>
															</div>
														</div>
													);
												})}
											</div>
										</div>
									);
								})}
							</div>
						</section>
					</>
				)}
			</div>
		</div>
	);
}
