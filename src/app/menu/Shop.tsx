"use client";

import { useCallback, useEffect, useState } from "react";
import { formatUsdg, parseUsdg } from "@shared/onchain";
import { type ShipClass } from "@shared/index";
import { type PlayerPublicState } from "@shared/index";
import { type GameHandle } from "@/game";
import { HULL_TILES, ITEM_CATEGORIES, hullPrice, effectLabel, effectivePrice, type ShopItem } from "@/game/shop/catalog";
import { asset } from "@/game/core/assets";

/**
 * The Shop — a dedicated, image-driven merchant page (a DOM overlay, not the
 * in-world Babylon dock panel, so it can show real artwork for every hull and
 * good). It has two economies on one page:
 *
 *  - Ships: the live ON-CHAIN inventory. Buying mints a real hull through
 *    ShipStore from the player's wallet and costs USDG.
 *  - Outfitting goods: the OFF-CHAIN economy. They cost cargo-purse units (the
 *    same currency repairs are paid in) and, once equipped, bend one ship stat.
 *    Pricing + the stat effect are authoritative on the server, which reads the
 *    SAME `@shared/shop` table this page renders from — the client never sets a
 *    price. Because the purse only exists while you're connected to the live
 *    sea, goods are buyable only once the world is running (a non-null ledger).
 */

const GOLD = "#e6c079";

/** Salvage materials: display glyph + short name, in a fixed read order. */
const MATERIAL_META: { key: "wood" | "iron" | "cloth"; glyph: string; name: string }[] = [
	{ key: "wood", glyph: "🪵", name: "timber" },
	{ key: "iron", glyph: "⛓", name: "iron" },
	{ key: "cloth", glyph: "🧵", name: "canvas" },
];

type Tab = { id: string; title: string; items: ShopItem[]; kind: "hulls" | "goods" };

const TABS: Tab[] = [
	{ id: "hulls", title: "Ships", items: [], kind: "hulls" },
	...ITEM_CATEGORIES.map<Tab>((c) => ({ id: c.id, title: c.title, items: c.items, kind: "goods" })),
];

export function ShopPage({
	handle,
	wallet,
	ledger,
	onClose,
	onOpenFleet,
	onConnected,
	onPurchased,
}: {
	handle: GameHandle | null;
	wallet: string | null;
	/** Live off-chain ledger (null until the world is running) — gates goods purchases. */
	ledger: PlayerPublicState | null;
	onClose: () => void;
	onOpenFleet: () => void;
	onConnected: (addr: string | null) => void;
	onPurchased: () => void;
}) {
	const [tab, setTab] = useState("hulls");
	const [balance, setBalance] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [status, setStatus] = useState<{ msg: string; ok: boolean }>({ msg: "Welcome aboard — spend USDG, take to sea.", ok: true });

	const loadBalance = useCallback(async () => {
		if (!handle) return;
		try {
			setBalance(await handle.usdgBalance());
		} catch {
			setBalance(null);
		}
	}, [handle]);

	useEffect(() => {
		void loadBalance();
	}, [loadBalance, wallet]);

	async function connect(): Promise<void> {
		if (!handle) return;
		setBusy("connect");
		try {
			const addr = await handle.connectWallet();
			onConnected(addr);
			setStatus(addr ? { msg: `Linked ${addr.slice(0, 6)}…${addr.slice(-4)}`, ok: true } : { msg: "No account chosen.", ok: false });
			await loadBalance();
		} catch (err) {
			setStatus({ msg: `Wallet error: ${err instanceof Error ? err.message : String(err)}`, ok: false });
		} finally {
			setBusy(null);
		}
	}

	async function buy(cls: ShipClass, label: string): Promise<void> {
		if (!handle || busy) return;
		setBusy(cls);
		setStatus({ msg: `Buying ${label} — confirm in wallet…`, ok: true });
		try {
			const { tokenId } = await handle.buyHull(cls);
			setStatus({ msg: `Bought ${label} — hull #${tokenId}.`, ok: true });
			await loadBalance();
			onPurchased();
		} catch (err) {
			setStatus({ msg: `Buy failed: ${err instanceof Error ? err.message : String(err)}`, ok: false });
		} finally {
			setBusy(null);
		}
	}

	/** Spend the cargo purse on a good. The server re-prices it (cargo price plus
	 *  any salvage shortfall auto-bought off the purse) and echoes the new ledger
	 *  back, so the purse/materials display updates without a round-trip here. */
	function buyGood(it: ShopItem): void {
		if (!handle || !ledger || busy) return;
		const held = ledger.materials;
		const total = effectivePrice(it.materials, held, it.cost);
		if (ledger.purse < total) {
			setStatus({ msg: `Not enough cargo — need ${total} (incl. materials), you have ${ledger.purse}.`, ok: false });
			return;
		}
		handle.buyItem(it.id);
		const short = total - it.cost;
		setStatus({
			msg: short > 0 ? `Bought ${it.name} for ${it.cost} cargo + ${short} for missing materials.` : `Bought ${it.name} for ${it.cost} cargo.`,
			ok: true,
		});
	}

	/** Equip / unequip an owned good. Only one item per slot can be active. */
	function toggleEquip(it: ShopItem, slot: string, currentlyEquipped: boolean): void {
		if (!handle || !ledger || busy) return;
		handle.equipItem(it.id, !currentlyEquipped);
		setStatus({ msg: currentlyEquipped ? `Stowed ${it.name}.` : `Equipped ${it.name} — ${effectLabel(it.stat, it.amount)}.`, ok: true });
	}

	const active = TABS.find((t) => t.id === tab) ?? TABS[0];

	return (
		<div className="absolute inset-0 z-40 flex flex-col bg-[rgba(4,9,16,0.94)] backdrop-blur-[2px]">
			{/* Header: title, wallet/balance, close */}
			<div className="flex flex-wrap items-center justify-between gap-3 border-b border-white/10 px-5 py-4">
				<h1 className="text-2xl font-black tracking-[0.12em] text-[#eaf3ff]">⚓ THE SHOP</h1>
				<div className="flex items-center gap-3">
					<div className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm">
						<span className="text-[#8aa3bd]">USDG </span>
						<span className="font-mono font-bold" style={{ color: GOLD }}>
							{balance ?? "—"}
						</span>
					</div>
					<div className="rounded-lg border border-white/10 bg-white/5 px-3 py-1.5 text-sm">
						<span className="text-[#8aa3bd]">Cargo </span>
						<span className="font-mono font-bold" style={{ color: GOLD }}>
							{ledger ? ledger.purse : "—"}
						</span>
					</div>
					<button
						type="button"
						onClick={connect}
						disabled={busy !== null || wallet !== null}
						className="rounded-lg border px-3 py-1.5 text-sm font-bold text-[#0a1526] disabled:opacity-40"
						style={{ background: GOLD, borderColor: GOLD }}
					>
						{wallet ? `${wallet.slice(0, 6)}…${wallet.slice(-4)}` : "Connect Wallet"}
					</button>
					<button
						type="button"
						onClick={onOpenFleet}
						className="rounded-lg border border-white/15 bg-white/5 px-3 py-1.5 text-sm font-bold text-[#eaf3ff] hover:bg-white/10"
					>
						My Fleet
					</button>
					<button
						type="button"
						onClick={onClose}
						className="rounded-lg border border-white/15 bg-[rgba(30,60,90,0.9)] px-3 py-1.5 text-sm font-bold text-[#eaf3ff] hover:bg-[rgba(40,75,110,0.95)]"
					>
						← Back
					</button>
				</div>
			</div>

			{/* Category tabs */}
			<div className="flex flex-wrap gap-2 px-5 py-3">
				{TABS.map((t) => (
					<button
						key={t.id}
						type="button"
						onClick={() => setTab(t.id)}
						className={`rounded-lg border px-3 py-1.5 text-sm font-bold transition-colors ${
							t.id === tab ? "border-[#e6c079] bg-[#e6c079] text-[#0a1526]" : "border-white/15 bg-white/5 text-[#c9d6e6] hover:bg-white/10"
						}`}
					>
						{t.title}
					</button>
				))}
			</div>

			{/* Status line */}
			<p className="px-5 pb-2 text-sm" style={{ color: status.ok ? "#9be8a0" : "#ff9b9b" }}>
				{status.msg}
			</p>

			{/* Grid */}
			<div className="flex-1 overflow-y-auto px-5 pb-8">
				{active.kind === "hulls" ? (
					<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
						{HULL_TILES.map((h) => {
							const price = hullPrice(h.cls);
							const afford = balance === null ? true : parseUsdg(balance) >= price;
							return (
								<div key={h.cls} className="flex flex-col overflow-hidden rounded-xl border border-white/12 bg-[rgba(10,20,34,0.9)]">
									<img src={asset(h.image)} alt={h.label} className="aspect-square w-full object-contain bg-[rgba(4,10,18,0.6)]" draggable={false} />
									<div className="flex flex-1 flex-col gap-1 p-3">
										<span className="text-sm font-bold text-[#eaf3ff]">{h.label}</span>
										<span className="text-xs text-[#8aa3bd]">{h.role}</span>
										<span className="mt-1 font-mono text-sm" style={{ color: GOLD }}>
											{formatUsdg(price)} USDG
										</span>
										<button
											type="button"
											onClick={() => buy(h.cls, h.label)}
											disabled={busy !== null || !wallet}
											title={wallet ? (afford ? "" : "Insufficient USDG") : "Connect your wallet first"}
											className="mt-2 w-full rounded-lg border px-3 py-1.5 text-sm font-bold text-[#0a1526] disabled:opacity-40"
											style={{ background: GOLD, borderColor: GOLD }}
										>
											{busy === h.cls ? "Buying…" : "Buy"}
										</button>
									</div>
								</div>
							);
						})}
					</div>
				) : (
					<>
						{!ledger && (
							<p className="mb-3 rounded-lg border border-white/10 bg-white/5 px-3 py-2 text-sm text-[#8aa3bd]">
								Goods trade in cargo from your hold. Set sail and take prizes — the purse shows up here once you're at sea.
							</p>
						)}
						<div className="grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4">
							{active.items.map((it) => {
								const owned = ledger?.items[it.id] ?? 0;
								const equipped = ledger?.equipped[active.id] === it.id;
								const held = ledger?.materials ?? { wood: 0, iron: 0, cloth: 0 };
								const total = effectivePrice(it.materials, held, it.cost);
								const autoCost = total - it.cost;
								const canAfford = !!ledger && ledger.purse >= total;
								return (
									<div key={it.id} className="flex flex-col overflow-hidden rounded-xl border border-white/10 bg-[rgba(10,20,34,0.85)]">
										<img src={asset(it.image)} alt={it.name} className="aspect-square w-full object-contain bg-[rgba(4,10,18,0.6)]" draggable={false} />
										<div className="flex flex-1 flex-col gap-1 p-3">
											<span className="text-sm font-bold text-[#eaf3ff]">{it.name}</span>
											<span className="text-xs text-[#9be8a0]">{effectLabel(it.stat, it.amount)}</span>
											{/* Salvage bill: required per material, held count shown, red when short. */}
											<div className="mt-1 flex flex-wrap gap-x-2 gap-y-0.5 text-[11px]">
												{MATERIAL_META.filter((m) => it.materials[m.key] > 0).map((m) => {
													const short = it.materials[m.key] > held[m.key];
													return (
														<span
															key={m.key}
															className="font-mono"
															title={`${m.name}: needs ${it.materials[m.key]}, you hold ${held[m.key]}`}
															style={{ color: short ? "#ff9b9b" : "#8aa3bd" }}
														>
															{m.glyph} {held[m.key]}/{it.materials[m.key]}
														</span>
													);
												})}
											</div>
											<span className="mt-1 font-mono text-sm" style={{ color: GOLD }}>
												{total} cargo
												{autoCost > 0 ? <span className="text-[11px] text-[#ff9b9b]"> (+{autoCost} materials)</span> : null}
												{owned > 0 ? ` · owned ${owned}` : ""}
											</span>
											<div className="mt-2 flex gap-2">
												<button
													type="button"
													onClick={() => buyGood(it)}
													disabled={!ledger || !canAfford || busy !== null}
													title={ledger ? (canAfford ? "" : "Not enough cargo (incl. missing materials)") : "Set sail to trade for cargo"}
													className="flex-1 rounded-lg border px-2 py-1.5 text-sm font-bold text-[#0a1526] disabled:opacity-40"
													style={{ background: GOLD, borderColor: GOLD }}
												>
													Buy
												</button>
												<button
													type="button"
													onClick={() => toggleEquip(it, active.id, equipped)}
													disabled={!ledger || owned < 1}
													title={owned < 1 ? "Buy one first" : equipped ? "Stow this good" : "Equip this good"}
													className={`flex-1 rounded-lg border px-2 py-1.5 text-sm font-bold ${
														equipped
															? "border-[#38bdf8] bg-[#38bdf8] text-[#0a1526]"
															: "border-white/15 bg-[rgba(30,60,90,0.9)] text-[#eaf3ff] hover:bg-[rgba(40,75,110,0.95)]"
													} disabled:opacity-40`}
												>
													{equipped ? "Equipped" : "Equip"}
												</button>
											</div>
										</div>
									</div>
								);
							})}
						</div>
					</>
				)}
			</div>
		</div>
	);
}
