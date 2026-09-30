import { Scene } from "@babylonjs/core";
import { AdvancedDynamicTexture, Button, Control, Rectangle, ScrollViewer, StackPanel, TextBlock, InputText } from "@babylonjs/gui";
import { formatUsdg, HULL_PRICES, USDG_DECIMALS } from "@shared/onchain";
import { type PlayerPublicState, type AuctionListing, type TradeListing, type ShipClass } from "@shared/index";
import type { Wallet } from "../wallet/Wallet";
import type { NetworkClient } from "../net/NetworkClient";

/**
 * The port-side trading menu — the docking UI the design spec promises (no
 * leaving the boat; a proximity panel). This is the human-facing surface for the
 * on-chain economy: it connects the player's wallet, shows their USDG balance,
 * buys hulls from the buy-only NPC store, and escrows a real USDG bounty against
 * a hull they own. That last action is the demo's live on-chain moment; the
 * server relayer settles the matching claim when the targeted hull is sunk.
 *
 * It owns a SEPARATE fullscreen GUI texture from the HUD so opening/closing it
 * never disturbs the in-world markers. All chain calls are awaited with the
 * result reported back into the panel — but nothing here blocks gameplay: the
 * scene keeps rendering and sailing behind the panel, and the socket/tick are
 * untouched (the relayer is what talks to the chain for settlement).
 */

const BUYABLE: Array<{ cls: string; label: string }> = [
	{ cls: "starter_sloop", label: "Starter Sloop" },
	{ cls: "raider_brig", label: "Raider Brig" },
	{ cls: "galleon", label: "Galleon" },
	{ cls: "war_galleon", label: "War Galleon" },
];

const BOUNTY_USDG = "25"; // 25 USDG escrowed per bounty (demo-sized)
const AUCTION_SECONDS = 300; // 5 minute listing

export class DockingMenu {
	private ui: AdvancedDynamicTexture;
	private root: Rectangle;
	private statusText: TextBlock;
	private balanceText: TextBlock;
	private bountyButton: Button;
	private auctionInfo: TextBlock;
	private listButton: Button;
	private bidButton: Button;
	private settleButton: Button;
	private busy = false;
	private tokenId: bigint | null = null;
	private lastAuctionId: bigint | null = null;
	/** The lot currently highlighted in the browser — bid/settle act on this. */
	private selectedAuctionId: bigint | null = null;
	/** Latest server-pushed roster of live player→player auctions. */
	private auctions: AuctionListing[] = [];
	/** The class of the hull we last bought — used to label a listing. */
	private listShipClass: ShipClass = "starter_sloop";
	/** The vertical StackPanel that holds the browsable rows (rebuilt per push). */
	private auctionRows: StackPanel | null = null;
	private player: PlayerPublicState | null = null;
	private purseText: TextBlock;
	private repairButton: Button;
	private dispatchButton: Button;
	/** On-chain alliance (the trustless backing for bounty alt-ring exclusion). */
	private allianceText: TextBlock;
	private joinIdInput: InputText;
	private createAllianceButton: Button;
	private joinAllianceButton: Button;
	private leaveAllianceButton: Button;
	/** The alliance id we currently read as belonging to the connected account (0=none). */
	private myAllianceId = 0;
	/** Trading post state: the browsable open sell orders + the selected one. */
	private tradeRows: StackPanel | null = null;
	private tradeInfo: TextBlock;
	private buyOrderButton: Button;
	private orders: TradeListing[] = [];
	private selectedOrderId: string | null = null;
	/** Persistent focusable rows for gamepad/keyboard nav, in on-screen order.
	 *  (The dynamic auction lots stay pointer-selectable.) */
	private nav: { btn: Button; run: () => void; base: string }[] = [];
	private sel = -1;
	/** Called after a successful on-chain buy so the shell can refresh the
	 *  buy-to-play entitlement. Set by createGame. */
	public onPurchased: (() => void) | null = null;

	constructor(
		scene: Scene,
		private wallet: Wallet,
		private net: NetworkClient
	) {
		this.ui = AdvancedDynamicTexture.CreateFullscreenUI("hs-dock", true, scene);

		this.root = new Rectangle("dockRoot");
		this.root.width = "360px";
		// Explicit height: a Rectangle sized "auto" around a vertical StackPanel
		// measures to NaN, which cascades through the ADT root layout and blanks the
		// WHOLE panel (same trap as the HUD/pause menu). Sized to fit the fixed set
		// of rows below, including the 132px auction scroll.
		this.root.height = "1300px";
		this.root.cornerRadius = 12;
		this.root.background = "rgba(8,14,24,0.92)";
		this.root.color = "rgba(150,190,225,0.5)";
		this.root.thickness = 1;
		this.root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		this.root.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
		this.root.isVisible = false;
		this.ui.addControl(this.root);

		const stack = new StackPanel("dockStack");
		stack.isVertical = true;
		stack.width = "100%";
		stack.height = "100%";
		stack.spacing = 8;
		stack.paddingTop = "16px";
		stack.paddingBottom = "16px";
		stack.paddingLeft = "18px";
		stack.paddingRight = "18px";
		this.root.addControl(stack);

		stack.addControl(this.label("⚓  PORT — MARKET & DOCKS", 20, "#cfe6ff", "left"));

		this.balanceText = this.label("USDG: —", 15, "#9be8a0", "left");
		stack.addControl(this.balanceText);
		this.purseText = this.label("Purse: — cargo", 13, "#ffe6a8", "left");
		stack.addControl(this.purseText);
		this.statusText = this.label("Not connected.", 13, "#ff9b9b", "left");
		stack.addControl(this.statusText);

		stack.addControl(this.label("Merchant — buy a hull (USDG)", 13, "#8aa3bd", "left"));
		// Buy-to-play: no hull is granted for free — you connect a wallet and buy
		// your first ship here, then the sea is yours.
		stack.addControl(this.label("Buy a hull to set sail — no free ship.", 11, "#7f97ad", "left"));
		for (const b of BUYABLE) {
			stack.addControl(this.button(`Buy ${b.label}  ·  ${formatUsdg(HULL_PRICES[b.cls])} USDG`, () => this.onBuy(b.cls, b.label)));
		}

		this.bountyButton = this.button(`Post ${BOUNTY_USDG} USDG bounty on my hull`, () => this.onPostBounty());
		this.bountyButton.isEnabled = false;
		stack.addControl(this.bountyButton);

		// On-chain alliance: players who form/join one alliance are mutually
		// excluded from claiming each other's bounties. The exclusion is resolved
		// trustlessly on-chain at claim time (BountyEscrow reads allianceOf), so this
		// panel only needs the WRITE side — create / join / leave. No server message.
		stack.addControl(this.label("Alliance (on-chain) — co-op rings can't farm each other's bounties", 13, "#8aa3bd", "left"));
		this.allianceText = this.label("Alliance: —", 12, "#9fb6cc", "left");
		stack.addControl(this.allianceText);
		this.createAllianceButton = this.button("Create alliance (become leader)", () => this.onCreateAlliance());
		stack.addControl(this.createAllianceButton);
		this.joinIdInput = new InputText("joinIdInput", "");
		this.joinIdInput.width = "100%";
		this.joinIdInput.height = "30px";
		this.joinIdInput.fontSize = 14;
		this.joinIdInput.color = "#eaf3ff";
		this.joinIdInput.background = "rgba(4,10,18,0.7)";
		this.joinIdInput.placeholderText = "alliance id to join (e.g. 1)";
		this.joinIdInput.thickness = 1;
		this.joinIdInput.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		stack.addControl(this.joinIdInput);
		this.joinAllianceButton = this.button("Join alliance by id", () => this.onJoinAlliance());
		stack.addControl(this.joinAllianceButton);
		this.leaveAllianceButton = this.button("Leave my alliance", () => this.onLeaveAlliance());
		this.leaveAllianceButton.isEnabled = false;
		stack.addControl(this.leaveAllianceButton);

		stack.addControl(this.label("Auction house — live lots (player→player)", 13, "#8aa3bd", "left"));
		// Browsable list. A ScrollViewer of FIXED height wraps a growable StackPanel
		// so an arbitrary number of rival listings scrolls instead of exploding the
		// outer panel's measured height (the NaN-layout trap the root already works
		// around). Each row is a lot; tap it to select, then bid/settle below.
		const scroll = new ScrollViewer("auctionScroll");
		scroll.width = "100%";
		scroll.height = "132px";
		scroll.barColor = "rgba(150,190,225,0.35)";
		scroll.background = "rgba(4,10,18,0.55)";
		this.auctionRows = new StackPanel("auctionRows");
		this.auctionRows.isVertical = true;
		this.auctionRows.width = "100%";
		this.auctionRows.spacing = 4;
		this.auctionRows.paddingLeft = "6px";
		this.auctionRows.paddingRight = "6px";
		this.auctionRows.paddingTop = "4px";
		this.auctionRows.paddingBottom = "4px";
		scroll.addControl(this.auctionRows);
		stack.addControl(scroll);
		this.renderAuctionRows();

		this.auctionInfo = this.label("No lot selected.", 12, "#9fb6cc", "left");
		stack.addControl(this.auctionInfo);
		this.listButton = this.button(`List my hull for ${AUCTION_SECONDS / 60} min`, () => this.onListAuction());
		this.listButton.isEnabled = false;
		stack.addControl(this.listButton);
		this.bidButton = this.button("Bid on selected lot", () => this.onBid());
		this.bidButton.isEnabled = false;
		stack.addControl(this.bidButton);
		this.settleButton = this.button("Settle selected lot", () => this.onSettle());
		this.settleButton.isEnabled = false;
		stack.addControl(this.settleButton);
		stack.addControl(this.button("Withdraw proceeds", () => this.onWithdraw()));

		stack.addControl(this.label("Trading post — sell to players (off-chain, priced in cargo)", 13, "#8aa3bd", "left"));
		// A browsable roster of rival sell orders. Same fixed-height scroll pattern
		// as the auction house so an arbitrary number of orders never explodes the
		// root's measured height. Tap to select, then buy/cancel below.
		const tradeScroll = new ScrollViewer("tradeScroll");
		tradeScroll.width = "100%";
		tradeScroll.height = "104px";
		tradeScroll.barColor = "rgba(150,190,225,0.35)";
		tradeScroll.background = "rgba(4,10,18,0.55)";
		this.tradeRows = new StackPanel("tradeRows");
		this.tradeRows.isVertical = true;
		this.tradeRows.width = "100%";
		this.tradeRows.spacing = 4;
		this.tradeRows.paddingLeft = "6px";
		this.tradeRows.paddingRight = "6px";
		this.tradeRows.paddingTop = "4px";
		this.tradeRows.paddingBottom = "4px";
		tradeScroll.addControl(this.tradeRows);
		stack.addControl(tradeScroll);
		this.renderTradeRows();

		this.tradeInfo = this.label("No order selected.", 12, "#9fb6cc", "left");
		stack.addControl(this.tradeInfo);
		stack.addControl(this.button("List 10 cargo for 12", () => this.onListCargo(10, 12)));
		stack.addControl(this.button("List 25 cargo for 30", () => this.onListCargo(25, 30)));
		this.buyOrderButton = this.button("Buy selected order", () => this.onBuyOrder());
		this.buyOrderButton.isEnabled = false;
		stack.addControl(this.buyOrderButton);
		stack.addControl(this.button("Cancel my order (selected)", () => this.onCancelOrder()));

		stack.addControl(this.label("Dockside (off-chain)", 13, "#8aa3bd", "left"));
		stack.addControl(this.button("Unload hold → purse", () => this.onUnload()));
		this.repairButton = this.button("Repair sunk hull", () => this.onRepair());
		stack.addControl(this.repairButton);
		this.dispatchButton = this.button("Dispatch ghost-fleet trader", () => this.onDispatch());
		this.dispatchButton.isEnabled = false;
		stack.addControl(this.dispatchButton);

		stack.addControl(this.button("Close", () => this.hide()));
	}

	private label(text: string, size: number, color: string, align: "left" | "center"): TextBlock {
		const t = new TextBlock("lbl", text);
		t.fontSize = `${size}px`;
		t.color = color;
		// Explicit height: a vertical StackPanel can't lay out a child whose height
		// is undefined/percentage — it overlaps its siblings.
		t.height = `${size + 8}px`;
		t.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		t.width = "100%";
		t.shadowBlur = 4;
		t.shadowColor = "#000";
		return t;
	}

	private button(text: string, onClick: () => void): Button {
		const btn = Button.CreateSimpleButton("btn", text);
		btn.width = "100%";
		btn.height = "34px";
		btn.cornerRadius = 6;
		btn.background = "rgba(30,60,90,0.9)";
		btn.color = "#eaf3ff";
		btn.fontSize = "14px";
		btn.thickness = 1;
		btn.onPointerClickObservable.add(() => onClick());
		// Register as a focusable nav row in build order (the on-screen order).
		this.nav.push({ btn, run: onClick, base: btn.background });
		return btn;
	}

	/** Paint the gold focus ring onto the current nav row, clearing the rest. */
	private paint(): void {
		for (let i = 0; i < this.nav.length; i++) {
			const e = this.nav[i];
			if (i === this.sel) {
				e.btn.background = "#e6c079";
				e.btn.color = "#0a1526";
			} else {
				e.btn.background = e.base;
				e.btn.color = "#eaf3ff";
			}
		}
	}

	/** Move the nav focus by `delta` rows, skipping disabled buttons, wrapping. */
	move(delta: number): void {
		const n = this.nav.length;
		if (n === 0) return;
		let i = this.sel < 0 ? (delta > 0 ? -1 : 0) : this.sel;
		for (let step = 0; step < n; step++) {
			i = (i + delta + n) % n;
			if (this.nav[i].btn.isEnabled) break;
		}
		this.sel = i;
		this.paint();
	}

	/** Fire the currently focused nav row (gamepad A / Enter). */
	confirm(): void {
		if (this.sel >= 0 && this.sel < this.nav.length) {
			const e = this.nav[this.sel];
			if (e.btn.isEnabled) e.run();
		}
	}

	isVisible(): boolean {
		return this.root.isVisible;
	}

	toggle(): void {
		if (this.root.isVisible) this.hide();
		else this.show();
	}

	show(): void {
		this.root.isVisible = true;
		const connected = this.wallet.address !== null;
		this.bountyButton.isEnabled = this.tokenId !== null && connected;
		this.listButton.isEnabled = this.tokenId !== null && connected && this.wallet.isAuctionConfigured;
		// Re-draw the lot rows so their countdowns are fresh on open.
		this.renderAuctionRows();
		this.renderTradeRows();
		// Drop focus onto the first actionable row for gamepad/keyboard nav.
		this.sel = -1;
		this.move(1);
		void this.refreshBalance();
		void this.refreshAlliance();
	}

	hide(): void {
		this.root.isVisible = false;
		this.sel = -1;
		this.paint();
	}

	private setBusy(msg: string): void {
		this.busy = true;
		this.statusText.text = msg;
		this.statusText.color = "#ffd98a";
	}

	private setInfo(msg: string, ok: boolean): void {
		this.busy = false;
		this.statusText.text = msg;
		this.statusText.color = ok ? "#9be8a0" : "#ff9b9b";
	}

	private async refreshBalance(): Promise<void> {
		if (!this.wallet.address || !this.wallet.isConfigured) {
			this.balanceText.text = "USDG: —";
			return;
		}
		try {
			const bal = await this.wallet.usdgBalanceOf(this.wallet.address);
			this.balanceText.text = `USDG: ${formatUsdg(bal)}`;
		} catch {
			this.balanceText.text = "USDG: (read failed)";
		}
	}

	/** Connect + bind the wallet to the runtime ship (server needs the binding to
	 *  settle any bounty we post or that targets us). */
	private async ensureConnected(): Promise<boolean> {
		if (this.wallet.address) return true;
		if (!this.wallet.isConfigured) {
			this.setInfo("On-chain not configured (missing contract env).", false);
			return false;
		}
		try {
			this.setBusy("Opening wallet…");
			const addr = await this.wallet.connect();
			if (!addr) {
				this.setInfo("No account chosen.", false);
				return false;
			}
			this.net.bindAddress(addr);
			this.dispatchButton.isEnabled = true;
			this.setInfo(`Linked ${addr.slice(0, 6)}…${addr.slice(-4)}`, true);
			await this.refreshBalance();
			return true;
		} catch (err) {
			this.setInfo(`Wallet error: ${err instanceof Error ? err.message : String(err)}`, false);
			return false;
		}
	}

	private async onBuy(shipClass: string, label: string): Promise<void> {
		if (this.busy) return;
		if (!(await this.ensureConnected())) return;
		try {
			this.setBusy(`Buying ${label} — confirm in wallet…`);
			const { tokenId } = await this.wallet.buyShip(shipClass);
			this.tokenId = tokenId;
			// Bind the freshly-bought hull to the runtime ship we are sailing so the
			// server settles bounties and provenance against THIS tokenId.
			this.net.bindHull(tokenId.toString());
			this.listShipClass = shipClass as ShipClass;
			this.bountyButton.isEnabled = true;
			this.listButton.isEnabled = this.wallet.address !== null && this.wallet.isAuctionConfigured;
			this.setInfo(`Bought ${label} (hull #${tokenId.toString()}).`, true);
			await this.refreshBalance();
			// Let the shell re-check the buy-to-play entitlement now that we own one.
			this.onPurchased?.();
		} catch (err) {
			this.setInfo(`Buy failed: ${err instanceof Error ? err.message : String(err)}`, false);
		}
	}

	private async onPostBounty(): Promise<void> {
		if (this.busy) return;
		if (!(await this.ensureConnected())) return;
		const tokenId = this.tokenId;
		if (tokenId === null) {
			this.setInfo("Buy a hull first to place a bounty on it.", false);
			return;
		}
		try {
			this.setBusy(`Escrowing ${BOUNTY_USDG} USDG — confirm in wallet…`);
			const r = await this.wallet.postBounty(tokenId, BOUNTY_USDG);
			// Hand the live bounty to the server so it settles the claim on-chain
			// the moment a hull owned by us (this declarer) is sunk.
			this.net.notifyBountyPosted(r.bountyId, r.tokenId, this.wallet.address as string, r.amount);
			this.setInfo(`Bounty #${r.bountyId} live on hull #${tokenId.toString()}.`, true);
			await this.refreshBalance();
		} catch (err) {
			this.setInfo(`Bounty failed: ${err instanceof Error ? err.message : String(err)}`, false);
		}
	}

	// ---- Auction house handlers --------------------------------------------

	private async onListAuction(): Promise<void> {
		if (this.busy) return;
		if (!(await this.ensureConnected())) return;
		const tokenId = this.tokenId;
		if (tokenId === null) {
			this.setInfo("Buy a hull first to list it.", false);
			return;
		}
		if (!this.wallet.isAuctionConfigured) {
			this.setInfo("Auction house not configured.", false);
			return;
		}
		try {
			this.setBusy("Listing hull — confirm in wallet…");
			const { auctionId } = await this.wallet.createShipAuction(tokenId, AUCTION_SECONDS);
			this.lastAuctionId = auctionId;
			this.selectedAuctionId = auctionId;
			// Tell the server so OTHER players can browse + bid on this lot. The bid
			// itself is wallet→chain; the server only maintains the roster.
			const endsAt = Math.floor(Date.now() / 1000) + AUCTION_SECONDS;
			this.net.notifyAuctionListed(auctionId.toString(), tokenId.toString(), this.listShipClass, endsAt);
			// Hull is now custodied by the house; the bounty/list buttons wait for a re-buy.
			this.tokenId = null;
			this.bountyButton.isEnabled = false;
			this.listButton.isEnabled = false;
			this.bidButton.isEnabled = true;
			this.settleButton.isEnabled = true;
			this.setInfo(`Listed hull #${tokenId.toString()} as lot #${auctionId.toString()}.`, true);
			await this.refreshAuctionInfo();
		} catch (err) {
			this.setInfo(`List failed: ${err instanceof Error ? err.message : String(err)}`, false);
		}
	}

	/** Rebuild the browsable lot list from the latest server roster. */
	setAuctions(list: AuctionListing[]): void {
		this.auctions = list;
		this.renderAuctionRows();
	}

	/** Draw one compact selectable row per live lot. Empty list -> a note. */
	private renderAuctionRows(): void {
		const host = this.auctionRows;
		if (!host) return;
		host.children.slice().forEach((c) => c.dispose());
		if (this.auctions.length === 0) {
			const empty = this.label("No live lots. List a hull to open the block.", 12, "#6f879e", "left");
			host.addControl(empty);
			return;
		}
		const now = Math.floor(Date.now() / 1000);
		for (const a of this.auctions) {
			const secsLeft = Math.max(0, a.endsAt - now);
			const label = `${a.shipClass} · lot #${a.auctionId} · ${a.seller.slice(0, 6)}… · ${secsLeft}s`;
			const row = Button.CreateSimpleButton("lot", label);
			row.width = "100%";
			row.height = "28px";
			row.cornerRadius = 5;
			row.fontSize = "12px";
			row.thickness = 1;
			const sel = this.selectedAuctionId !== null && this.selectedAuctionId.toString() === a.auctionId;
			row.background = sel ? "rgba(70,120,170,0.95)" : "rgba(24,44,66,0.9)";
			row.color = "#eaf3ff";
			row.onPointerClickObservable.add(() => this.selectAuction(a.auctionId));
			host.addControl(row);
		}
	}

	/** Highlight a lot and show its live on-chain bid state. */
	private selectAuction(auctionIdStr: string): void {
		this.selectedAuctionId = BigInt(auctionIdStr);
		this.renderAuctionRows();
		this.bidButton.isEnabled = true;
		this.settleButton.isEnabled = true;
		void this.refreshAuctionInfo();
	}

	// ---- Trading post (off-chain player→player sell orders) ----------------

	/** Replace the browsable order list from the latest server push. */
	setOrders(list: TradeListing[]): void {
		this.orders = list;
		// If the previously-selected order was bought/cancelled away, drop the
		// selection so Buy can't target a stale id.
		if (this.selectedOrderId && !list.some((o) => o.id === this.selectedOrderId)) {
			this.selectedOrderId = null;
			this.buyOrderButton.isEnabled = false;
			this.tradeInfo.text = "No order selected.";
		}
		this.renderTradeRows();
	}

	/** Draw one compact selectable row per open order. Empty -> a note. */
	private renderTradeRows(): void {
		const host = this.tradeRows;
		if (!host) return;
		host.children.slice().forEach((c) => c.dispose());
		if (this.orders.length === 0) {
			const empty = this.label("No open orders. List cargo to stock the post.", 12, "#6f879e", "left");
			host.addControl(empty);
			return;
		}
		for (const o of this.orders) {
			const what = o.kind === "cargo" ? `${o.qty} cargo` : `${o.qty}× ${o.itemId}`;
			const mine = o.seller === this.wallet.address?.toLowerCase();
			const label = `${what} · ${o.price} cargo${mine ? " (you)" : ""} · ${o.seller.slice(0, 6)}…`;
			const row = Button.CreateSimpleButton("order", label);
			row.width = "100%";
			row.height = "26px";
			row.cornerRadius = 5;
			row.fontSize = "12px";
			row.thickness = 1;
			const sel = this.selectedOrderId === o.id;
			row.background = sel ? "rgba(70,120,170,0.95)" : "rgba(24,44,66,0.9)";
			row.color = "#eaf3ff";
			row.onPointerClickObservable.add(() => this.selectOrder(o.id));
			host.addControl(row);
		}
	}

	/** Highlight an order; enable Buy unless it is the player's own. */
	private selectOrder(orderId: string): void {
		this.selectedOrderId = orderId;
		this.renderTradeRows();
		const o = this.orders.find((x) => x.id === orderId);
		if (!o) return;
		const mine = o.seller === this.wallet.address?.toLowerCase();
		this.buyOrderButton.isEnabled = !mine;
		const what = o.kind === "cargo" ? `${o.qty} cargo` : `${o.qty}× ${o.itemId}`;
		this.tradeInfo.text = `Order #${o.id}: ${what} for ${o.price} cargo${mine ? " (yours — cancel to withdraw)" : ""}.`;
	}

	private onListCargo(qty: number, price: number): void {
		// Off-chain: no wallet needed, only a docked hull with cargo in the purse.
		this.net.tradeList("cargo", undefined, qty, price);
		this.setInfo(`Listing ${qty} cargo for ${price}…`, true);
	}

	private onBuyOrder(): void {
		if (!this.selectedOrderId) {
			this.setInfo("Select an order to buy.", false);
			return;
		}
		this.net.tradeBuy(this.selectedOrderId);
		this.setInfo("Buying order…", true);
	}

	private onCancelOrder(): void {
		if (!this.selectedOrderId) {
			this.setInfo("Select your order to cancel.", false);
			return;
		}
		this.net.tradeCancel(this.selectedOrderId);
		this.setInfo("Cancelling order…", true);
	}

	private async onBid(): Promise<void> {
		if (this.busy) return;
		if (!(await this.ensureConnected())) return;
		const id = this.selectedAuctionId;
		if (id === null) {
			this.setInfo("Select a lot to bid on.", false);
			return;
		}
		try {
			this.setBusy("Reading auction…");
			const state = await this.wallet.auctionState(id);
			if (!state.open || state.settled) {
				this.setInfo("Auction already closed.", false);
				await this.refreshAuctionInfo();
				return;
			}
			// Contract demands >= +5% over the leader; round up to a whole USDG so the
			// approval/bid stays on clean figures and always clears the increment.
			const minNext = state.highestBid + (state.highestBid * 500n) / 10000n + 1n;
			const whole = (minNext + 999999n) / 1000000n;
			this.setBusy(`Bidding ${whole.toString()} USDG — confirm in wallet…`);
			await this.wallet.placeBid(id, whole.toString());
			this.setInfo(`Bid ${whole.toString()} USDG on lot #${id.toString()}.`, true);
			await this.refreshBalance();
			await this.refreshAuctionInfo();
		} catch (err) {
			this.setInfo(`Bid failed: ${err instanceof Error ? err.message : String(err)}`, false);
		}
	}

	private async onSettle(): Promise<void> {
		if (this.busy) return;
		if (!(await this.ensureConnected())) return;
		const id = this.selectedAuctionId;
		if (id === null) {
			this.setInfo("Select a lot to settle.", false);
			return;
		}
		try {
			this.setBusy("Settling auction — confirm in wallet…");
			await this.wallet.settleAuction(id);
			this.setInfo(`Settled lot #${id.toString()}. Withdraw any proceeds.`, true);
			// Re-render so the time-left / winner line updates from the chain read.
			await this.refreshAuctionInfo();
		} catch (err) {
			this.setInfo(`Settle failed: ${err instanceof Error ? err.message : String(err)}`, false);
		}
	}

	private async onWithdraw(): Promise<void> {
		if (this.busy) return;
		if (!(await this.ensureConnected())) return;
		try {
			this.setBusy("Withdrawing proceeds — confirm in wallet…");
			const { amount } = await this.wallet.withdrawProceeds();
			this.setInfo(`Withdrew ${formatUsdg(amount)} USDG.`, true);
			await this.refreshBalance();
		} catch (err) {
			this.setInfo(`Withdraw failed: ${err instanceof Error ? err.message : String(err)}`, false);
		}
	}

	private async refreshAuctionInfo(): Promise<void> {
		const id = this.selectedAuctionId;
		if (id === null || !this.wallet.isAuctionConfigured) return;
		try {
			const s = await this.wallet.auctionState(id);
			const secsLeft = Number(s.endsAt) - Math.floor(Date.now() / 1000);
			if (!s.open || s.settled) {
				const who = s.highestBidder && s.highestBidder !== ("0x" + "0".repeat(40)) ? s.highestBidder.slice(0, 6) : "—";
				this.auctionInfo.text = `Lot #${id.toString()}: settled · winner ${who} · ${formatUsdg(s.highestBid)} USDG`;
			} else {
				this.auctionInfo.text = `Lot #${id.toString()}: bid ${formatUsdg(s.highestBid)} USDG · ${Math.max(0, secsLeft)}s left`;
			}
		} catch {
			this.auctionInfo.text = `Lot #${id.toString()}: (read failed)`;
		}
	}

	dispose(): void {
		this.ui.dispose();
	}

	// ---- On-chain alliance handlers -----------------------------------------
	// The WRITE side only. Bounty alt-ring exclusion is resolved trustlessly on
	// chain at claim time (BountyEscrow reads AllianceRegistry.allianceOf), so no
	// server message is needed — forming/joining an alliance just works once the
	// members are on-chain.

	/** Read the connected account's current alliance and repaint the section. */
	private async refreshAlliance(): Promise<void> {
		if (!this.wallet.isAllianceConfigured || !this.wallet.address) {
			this.myAllianceId = 0;
			this.allianceText.text = "Alliance: —";
			this.createAllianceButton.isEnabled = false;
			this.joinAllianceButton.isEnabled = false;
			this.leaveAllianceButton.isEnabled = false;
			return;
		}
		try {
			const id = await this.wallet.myAlliance();
			this.myAllianceId = id;
			if (id > 0) {
				const size = await this.wallet.allianceSize(id);
				this.allianceText.text = `Alliance #${id} · ${size} member${size === 1 ? "" : "s"}`;
				this.createAllianceButton.isEnabled = false;
				this.joinAllianceButton.isEnabled = false;
				this.leaveAllianceButton.isEnabled = true;
			} else {
				this.allianceText.text = "Alliance: none";
				this.createAllianceButton.isEnabled = true;
				this.joinAllianceButton.isEnabled = true;
				this.leaveAllianceButton.isEnabled = false;
			}
		} catch {
			this.allianceText.text = "Alliance: (read failed)";
		}
	}

	private async onCreateAlliance(): Promise<void> {
		if (this.busy) return;
		if (!(await this.ensureConnected())) return;
		if (!this.wallet.isAllianceConfigured) {
			this.setInfo("Alliance registry not configured.", false);
			return;
		}
		try {
			this.setBusy("Creating alliance — confirm in wallet…");
			const { allianceId } = await this.wallet.createAlliance();
			this.setInfo(`Created alliance #${allianceId} (you lead it).`, true);
			await this.refreshAlliance();
		} catch (err) {
			this.setInfo(`Create failed: ${err instanceof Error ? err.message : String(err)}`, false);
		}
	}

	private async onJoinAlliance(): Promise<void> {
		if (this.busy) return;
		if (!(await this.ensureConnected())) return;
		if (!this.wallet.isAllianceConfigured) {
			this.setInfo("Alliance registry not configured.", false);
			return;
		}
		const id = parseInt(this.joinIdInput.text, 10);
		if (!Number.isFinite(id) || id <= 0) {
			this.setInfo("Enter a valid alliance id to join.", false);
			return;
		}
		if (this.myAllianceId !== 0) {
			this.setInfo("Leave your current alliance first.", false);
			return;
		}
		try {
			this.setBusy(`Joining alliance #${id} — confirm in wallet…`);
			await this.wallet.joinAlliance(id);
			this.setInfo(`Joined alliance #${id}.`, true);
			await this.refreshAlliance();
		} catch (err) {
			this.setInfo(`Join failed: ${err instanceof Error ? err.message : String(err)}`, false);
		}
	}

	private async onLeaveAlliance(): Promise<void> {
		if (this.busy) return;
		if (!(await this.ensureConnected())) return;
		if (this.myAllianceId === 0) {
			this.setInfo("You are not in an alliance.", false);
			return;
		}
		const id = this.myAllianceId;
		try {
			this.setBusy(`Leaving alliance #${id} — confirm in wallet…`);
			await this.wallet.leaveAlliance(id);
			this.setInfo(`Left alliance #${id}.`, true);
			await this.refreshAlliance();
		} catch (err) {
			this.setInfo(`Leave failed: ${err instanceof Error ? err.message : String(err)}`, false);
		}
	}

	/** Reflect the player's off-chain ledger: purse + whether repairs/fleet are
	 *  actionable. Drives the dockside section (all server-resolved, off-chain). */
	setPlayer(state: PlayerPublicState): void {
		this.player = state;
		this.purseText.text = `Purse: ${state.purse} cargo`;
		this.dispatchButton.isEnabled = this.wallet.address !== null;
	}

	// ---- Dockside (off-chain economy) handlers ------------------------------
	// All fire-and-forget: the server applies the rule against authoritative
	// state and pushes an updated player:state back, which re-renders the purse.

	private onUnload(): void {
		this.net.unload();
		this.setInfo("Unloading hold…", true);
	}

	private onRepair(): void {
		this.net.repair();
		this.setInfo("Repairing hull…", true);
	}

	private async onDispatch(): Promise<void> {
		if (!(await this.ensureConnected())) return;
		this.net.dispatch(this.tokenId?.toString() ?? "0", "Dispatched Trader");
		this.setInfo("Trader dispatched on a trade run.", true);
	}
}
