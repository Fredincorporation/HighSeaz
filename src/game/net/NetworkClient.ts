import type { ClientToServer, ServerToClient, HelmInput, Heading, SailGear, SalvageLedger, SecurityEvent, AuctionListing, WantedEntry, TradeListing, ShipClass, ParleyOffer, ParleyResolved, ParleyFailReason, AmmoType } from "@shared/index";

/**
 * Thin WebSocket client for the authoritative server. It sends player intent
 * (helm / fire) and emits received snapshots + events for the render layer to
 * reconcile against. No prediction/interpolation yet — that lands with the
 * netcode build; this establishes the transport contract end to end.
 */
export class NetworkClient {
	private ws: WebSocket | null = null;
	private url: string;
	/** Stable per-tab id so a reconnect resumes the SAME ship instead of minting a
	 *  new player (and thus a fresh hull) on every (re)connect. */
	private clientId: string;
	/** Set before a deliberate close so onclose does not schedule a reconnect. */
	private intentionalClose = false;
	private reconnectTimer: ReturnType<typeof setTimeout> | null = null;

	public selfShipId: string | null = null;
	/** Connected wallet address, sent with join and on bind so the server can
	 *  settle on-chain bounties to/from this player's hull. */
	public address: string | null = null;
	/** ERC-721 tokenId of the on-chain hull this session sails, once bought/selected.
	 *  Sent with join and on bind so the server keys bounty claims + provenance on
	 *  the exact hull instead of the owner wallet. */
	public hullTokenId: string | null = null;
	public onSnapshot: ((msg: Extract<ServerToClient, { t: "snapshot" }>["payload"]) => void) | null = null;
	public onWelcome: ((msg: Extract<ServerToClient, { t: "welcome" }>["payload"]) => void) | null = null;
	/** The helm moved to another of our owned hulls (fleet take-the-helm). */
	public onHelmSwitched: ((msg: Extract<ServerToClient, { t: "helm:switched" }>["payload"]) => void) | null = null;
	public onCombat: ((msg: Extract<ServerToClient, { t: "combat" }>["payload"]) => void) | null = null;
	public onBountyClaimed: ((msg: Extract<ServerToClient, { t: "chain:bountyClaimed" }>["payload"]) => void) | null = null;
	public onPlayerState: ((msg: Extract<ServerToClient, { t: "player:state" }>["payload"]) => void) | null = null;
	public onPoiClaimed: ((msg: Extract<ServerToClient, { t: "poi:claimed" }>["payload"]) => void) | null = null;
	/** A rival (or we) dove a debris field: pop that wreck marker for everyone. */
	public onSalvageClaimed: ((msg: Extract<ServerToClient, { t: "salvage:claimed" }>["payload"]) => void) | null = null;
	public onSecurity: ((evt: SecurityEvent) => void) | null = null;
	/** Latest roster of live player→player auctions (the browsable auction house). */
	public onAuctionList: ((auctions: AuctionListing[]) => void) | null = null;
	/** Latest live Most-Wanted bounty board (head-hunting marquee). */
	public onBountyBoard: ((wanted: WantedEntry[]) => void) | null = null;
	/** Latest live player→player trading-post sell orders. */
	public onTradeOrders: ((orders: TradeListing[]) => void) | null = null;
	/** A rival is demanding terms of MY hull — show the strike-your-colors prompt. */
	public onParleyIncoming: ((offer: ParleyOffer) => void) | null = null;
	/** MY demand was put to the target and awaits their answer. */
	public onParleyAsked: ((msg: { defenderShipId: string; defenderName: string; demand: number; ttlSeconds: number }) => void) | null = null;
	/** A parley resolved (both hulls get this): accept pays the toll, else fight on. */
	public onParleyResolved: ((r: ParleyResolved) => void) | null = null;
	/** A parley action I attempted was refused. */
	public onParleyFailed: ((reason: ParleyFailReason) => void) | null = null;

	/** Whether the socket is currently open — drives the HUD connection dot. */
	get connected(): boolean {
		return this.ws?.readyState === WebSocket.OPEN;
	}

	constructor(url: string) {
		this.url = url;
		// Reuse the id across page refreshes in the same tab (client-only here —
		// createGame runs from a useEffect, so sessionStorage is available).
		let id: string | null = null;
		try {
			id = sessionStorage.getItem("highseaz:client");
		} catch {
			id = null;
		}
		if (!id) {
			id = crypto.randomUUID();
			try {
				sessionStorage.setItem("highseaz:client", id);
			} catch {
				/* storage disabled — fall back to a per-session id */
			}
		}
		this.clientId = id;
	}

	connect(): void {
		this.intentionalClose = false;
		this.ws = new WebSocket(this.url);
		this.ws.onopen = () =>
			this.send({
				t: "join",
				payload: {
					clientPlayerId: this.clientId,
					displayName: "Player",
					address: this.address ?? undefined,
					tokenId: this.hullTokenId ?? undefined,
				},
			});
		this.ws.onmessage = (ev) => {
			let msg: ServerToClient;
			try {
				msg = JSON.parse(ev.data);
			} catch {
				return;
			}
			switch (msg.t) {
				case "welcome":
					this.selfShipId = msg.payload.selfShipId;
					this.onWelcome?.(msg.payload);
					break;
				case "helm:switched":
					// Server moved our control to another owned hull; camera/input
					// read selfShipId live each frame, so this alone retargets.
					this.selfShipId = msg.payload.shipId;
					this.onHelmSwitched?.(msg.payload);
					break;
				case "snapshot":
					this.onSnapshot?.(msg.payload);
					break;
				case "combat":
					this.onCombat?.(msg.payload);
					break;
				case "chain:bountyClaimed":
					this.onBountyClaimed?.(msg.payload);
					break;
				case "player:state":
					this.onPlayerState?.(msg.payload);
					break;
				case "poi:claimed":
					this.onPoiClaimed?.(msg.payload);
					break;
				case "salvage:claimed":
					this.onSalvageClaimed?.(msg.payload);
					break;
				case "security":
					this.onSecurity?.(msg.payload);
					break;
				case "auction:list":
					this.onAuctionList?.(msg.payload.auctions);
					break;
				case "bounty:board":
					this.onBountyBoard?.(msg.payload.wanted);
					break;
				case "trade:orders":
					this.onTradeOrders?.(msg.payload.orders);
					break;
				case "parley:incoming":
					this.onParleyIncoming?.(msg.payload);
					break;
				case "parley:asked":
					this.onParleyAsked?.(msg.payload);
					break;
				case "parley:resolved":
					this.onParleyResolved?.(msg.payload);
					break;
				case "parley:failed":
					this.onParleyFailed?.(msg.payload.reason);
					break;
				default:
					break;
			}
		};
		this.ws.onclose = () => {
			// Never respawn a connection we closed on purpose (unmount / dispose) —
			// that was the source of ghost ships piling up on every refresh.
			if (this.intentionalClose) return;
			if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
			this.reconnectTimer = setTimeout(() => this.connect(), 1000);
		};
	}

	private send(msg: ClientToServer): void {
		if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
	}

	sendInput(helm: HelmInput, aim?: Heading): void {
		if (this.selfShipId) this.send({ t: "input", payload: { shipId: this.selfShipId, helm, aim } });
	}

	/** Order a sail gear (task #138) for our own hull. The server echoes the chosen
	 *  gear back on every snapshot as `ShipState.gear`, so the HUD reads the truth. */
	sendGear(gear: SailGear): void {
		if (this.selfShipId) this.send({ t: "helm:gear", payload: { shipId: this.selfShipId, gear } });
	}

	/** Convert purse cargo into salvage materials (task #139) at the server's unit
	 *  price. Fire-and-forget; the updated ledger rides the next player:state. */
	autoBuyMaterials(materials: Partial<SalvageLedger>): void {
		this.send({ t: "salvage:autoBuy", payload: { materials } });
	}

	/** Loose a broadside down `turretHeading` with the loaded shot `ammo` (the
	 *  server composes the arc's gun with the payload's effect; default round). */
	fire(turretHeading: Heading, ammo?: AmmoType): void {
		if (this.selfShipId) this.send({ t: "fire", payload: { shipId: this.selfShipId, turretHeading, ammo } });
	}

	/** Record the connected wallet and bind it to this client's runtime ship. */
	bindAddress(address: string): void {
		this.address = address;
		this.send({ t: "chain:bind", payload: { address, tokenId: this.hullTokenId ?? undefined } });
	}

	/** Bind the on-chain hull tokenId this session sails to the runtime ship, so the
	 *  server keys bounty claims and ship provenance on the exact hull rather than
	 *  the owner wallet. Called after a hull is bought/selected at a dock. */
	bindHull(tokenId: string): void {
		this.hullTokenId = tokenId;
		if (!this.address) return;
		this.send({ t: "chain:bind", payload: { address: this.address, tokenId } });
	}

	/** Tell the server a bounty is live on-chain against our hull so it can settle
	 *  the claim when (if) we are sunk. */
	notifyBountyPosted(bountyId: number, tokenId: string, declarer: string, amount: string): void {
		this.send({ t: "chain:bountyPosted", payload: { bountyId, tokenId, declarer, amount } });
	}

	/** Offload our docked hull's cargo into the off-chain purse. */
	unload(): void {
		if (this.selfShipId) this.send({ t: "dock:unload", payload: { shipId: this.selfShipId } });
	}

	/** Pay cargo from the purse to bring our sunk hull back at this dock. */
	repair(): void {
		if (this.selfShipId) this.send({ t: "dock:repair", payload: { shipId: this.selfShipId } });
	}

	/** Send an owned hull out as an auto-mode ghost-fleet trader. */
	dispatch(tokenId: string, name: string): void {
		this.send({ t: "fleet:dispatch", payload: { tokenId, name } });
	}

	/** Take the helm of another owned, active hull: the ship we sail now drops to
	 *  auto mode and this one becomes player-driven (server replies helm:switched). */
	switchHull(shipId: string): void {
		this.send({ t: "helm:switch", payload: { shipId } });
	}

	/** Buy one outfitting good with the off-chain cargo purse (server prices it). */
	buyItem(itemId: string): void {
		this.send({ t: "shop:buyItem", payload: { itemId } });
	}

	/** Equip / unequip an owned good in its slot, applying or clearing its bonus. */
	equipItem(itemId: string, equipped: boolean): void {
		this.send({ t: "shop:equip", payload: { itemId, equipped } });
	}

	/** Post a player→player sell order on the off-chain trading post. */
	tradeList(kind: "cargo" | "item", itemId: string | undefined, qty: number, price: number): void {
		this.send({ t: "trade:list", payload: { kind, itemId, qty, price } });
	}

	/** Buy an open sell order (server swaps purse + escrowed goods atomically). */
	tradeBuy(orderId: string): void {
		this.send({ t: "trade:buy", payload: { orderId } });
	}

	/** Cancel one of your own open orders; the escrowed goods come back. */
	tradeCancel(orderId: string): void {
		this.send({ t: "trade:cancel", payload: { orderId } });
	}

	/** Demand surrender terms of a rival player hull within cannon range. */
	parleyDemand(targetShipId: string): void {
		this.send({ t: "parley:demand", payload: { targetShipId } });
	}

	/** Accept an incoming demand: pay the cargo toll and open a brief truce. */
	parleyAccept(): void {
		this.send({ t: "parley:accept", payload: {} });
	}

	/** Refuse an incoming demand: the fight continues. */
	parleyDecline(): void {
		this.send({ t: "parley:decline", payload: {} });
	}

	/** Announce a live on-chain auction (already created wallet→chain) so the
	 *  server lists it for other players to browse and bid on. */
	notifyAuctionListed(auctionId: string, tokenId: string, shipClass: ShipClass, endsAt: number): void {
		this.send({ t: "auction:listed", payload: { auctionId, tokenId, shipClass, endsAt } });
	}

	disconnect(): void {
		this.intentionalClose = true;
		if (this.reconnectTimer) {
			clearTimeout(this.reconnectTimer);
			this.reconnectTimer = null;
		}
		if (this.ws) {
			this.ws.onclose = null;
			this.ws.close();
			this.ws = null;
		}
	}
}
