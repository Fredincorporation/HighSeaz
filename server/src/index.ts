import "./env.js";
import { readFileSync, writeFileSync, renameSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { WebSocketServer, WebSocket } from "ws";
import {
	type ClientToServer,
	type ServerToClient,
	type ShipClass,
	type Faction,
	type SecurityEvent,
	type AuctionListing,
	TICK_RATE_HZ,
	TICK_INTERVAL_MS,
} from "../../shared-types/index.js";
import { World } from "./world.js";
import { Relayer } from "./relayer.js";
import { Guard } from "./guard.js";
import { supabaseEnabled, loadSnapshot, saveSnapshot } from "./persist.js";

/**
 * HighSeaz authoritative game server (scaffold).
 *
 * Fixed-timestep loop: read client intent -> step the World -> broadcast a
 * snapshot to every connected client. Combat resolution, bounty/auction hooks
 * and DB persistence are added on the build green-light; the transport + tick
 * skeleton is what this file establishes.
 */

const PORT = Number(process.env.PORT ?? 9000);

const world = new World();
const relayer = Relayer.fromEnv();
const guard = new Guard();

// Authoritative buy-to-play gate (#100): when "1", a socket must present a wallet
// that owns at least one on-chain hull before a runtime ship spawns. Only actually
// enforced while the relayer is live (env keys present); off by default so local
// dev and the relayer-less demo path are never locked out.
const BUY_TO_PLAY_SERVER = process.env.BUY_TO_PLAY_SERVER === "1";

// Server world persistence (#104): the OFF-chain durable state (player ledgers,
// dug caches, clock) survives a restart via an atomic JSON write-behind. Ships
// are transient; only the economy is written. File path is env-overridable so a
// deployment can point it at a mounted volume.
const WORLD_FILE = process.env.WORLD_PERSIST_FILE ?? join(process.cwd(), "world-state.json");

// The local JSON write-behind stays as an always-fresh fallback/cache; Supabase
// (when configured) is the durable NETWORK store the snapshot mirrors to. With no
// Supabase env, behavior is exactly the prior file-only persistence.
function writeWorldFile(json: string): void {
	const tmp = `${WORLD_FILE}.tmp`;
	try {
		mkdirSync(dirname(WORLD_FILE), { recursive: true });
		// Write-then-rename so a crash mid-write can never leave a half-saved file.
		writeFileSync(tmp, json, "utf8");
		renameSync(tmp, WORLD_FILE);
	} catch (err) {
		console.error("[world] file persist failed:", err instanceof Error ? err.message : err);
	}
}

function loadWorld(): void {
	try {
		world.restore(readFileSync(WORLD_FILE, "utf8"));
	} catch {
		// No file yet — a fresh sea. Not an error.
	}
}

// Async write-behind: refresh the local file synchronously, then mirror the same
// snapshot to Supabase when configured. Resolves once the network write settles
// so a clean shutdown can await the final flush.
async function saveWorld(): Promise<void> {
	const json = world.serialize();
	writeWorldFile(json);
	if (supabaseEnabled) await saveSnapshot(json);
}

loadWorld();

// Upgrade the file-seeded state to the (newer) Supabase snapshot at boot. Guarded:
// if a client already connected during the fetch window we keep the in-memory file
// seed and just start mirroring writes forward, so live ledgers are never clobbered.
async function pullRemote(): Promise<void> {
	if (!supabaseEnabled) return;
	const snap = await loadSnapshot();
	if (!snap) return;
	if (clients.size > 0) {
		console.warn("[persist] clients connected during boot pull; keeping file seed, mirroring forward");
		return;
	}
	world.restore(snap);
	console.log("[persist] world state loaded from Supabase");
}
void pullRemote();

// Seed a little horizon traffic so a solo session is not an empty sea and the
// broadside has targets. These idle (no helm) until the auto-mode AI build
// dispatches them on trade routes and chases (P2). Cargo is loaded so sinking
// one actually pays.
function seedNpcTraffic(): void {
	const roster: Array<{ cls: ShipClass; faction: Faction; x: number; z: number; cargo: number; name: string }> = [
		{ cls: "merchant", faction: "merchant", x: 180, z: 60, cargo: 40, name: "Blessed Trade" },
		{ cls: "merchant", faction: "merchant", x: -220, z: 300, cargo: 55, name: "Sugar Runner" },
		{ cls: "raider_sloop", faction: "pirate", x: 320, z: -180, cargo: 22, name: "Black Tern" },
		{ cls: "raider_brig", faction: "pirate", x: -150, z: -260, cargo: 34, name: "Gallows Wind" },
		{ cls: "brigantine", faction: "pirate", x: 60, z: 420, cargo: 48, name: "Salt Widow" },
		{ cls: "imperial", faction: "naval", x: -420, z: -120, cargo: 60, name: "HMS Provience" },
	];
	for (const r of roster) {
		world.spawnShip({
			name: r.name,
			shipClass: r.cls,
			faction: r.faction,
			mode: "auto",
			position: { x: r.x, y: 0, z: r.z },
			heading: Math.atan2(-r.x, -r.z),
			cargo: r.cargo,
		});
	}
}
seedNpcTraffic();

const wss = new WebSocketServer({ port: PORT });

type Client = { ws: WebSocket; shipId?: string; address?: string; alive: boolean };
const clients = new Map<WebSocket, Client>();

/**
 * OFF-chain roster of live player→player auctions, keyed by auctionId. The chain
 * is the source of truth for bid state; this registry only exists so players can
 * BROWSE what rivals have listed. Rows are dropped once past their `endsAt`
 * (settlement on-chain is what actually transfers the hull).
 */
const auctions = new Map<string, AuctionListing>();

function pruneAuctions(): void {
	const now = Math.floor(Date.now() / 1000);
	for (const [id, a] of auctions) if (a.endsAt <= now) auctions.delete(id);
}

function currentAuctionList(): AuctionListing[] {
	pruneAuctions();
	return [...auctions.values()].sort((x, y) => x.endsAt - y.endsAt);
}

/** Push the full live roster to one socket. */
function sendAuctionList(client: Client): void {
	send(client, { t: "auction:list", payload: { auctions: currentAuctionList() } });
}

/** Re-broadcast the full roster to everyone (cheap; listings are rare). */
function broadcastAuctionList(): void {
	broadcast({ t: "auction:list", payload: { auctions: currentAuctionList() } });
}

function send(client: Client, msg: ServerToClient): void {
	if (client.ws.readyState === WebSocket.OPEN) {
		client.ws.send(JSON.stringify(msg));
	}
}

function broadcast(msg: ServerToClient): void {
	const data = JSON.stringify(msg);
	for (const client of clients.values()) {
		if (client.ws.readyState === WebSocket.OPEN) client.ws.send(data);
	}
}

/** The socket currently sailing a given runtime ship, or undefined. Parley traffic
 *  is point-to-point (only the two captains in a duel should see it), so we route
 *  by finding each party's client from its hull id rather than broadcasting. */
function clientByShip(shipId: string): Client | undefined {
	for (const client of clients.values()) {
		if (client.shipId === shipId) return client;
	}
	return undefined;
}

/** Push any anti-cheat notices to every client so each HUD can react. */
function emitSecurity(events: SecurityEvent[]): void {
	for (const evt of events) broadcast({ t: "security", payload: evt });
}

wss.on("connection", (ws) => {
	const client: Client = { ws, alive: true };
	clients.set(ws, client);

	ws.on("pong", () => (client.alive = true));

	ws.on("message", async (raw) => {
		let msg: ClientToServer;
		try {
			msg = JSON.parse(raw.toString());
		} catch {
			return send(client, { t: "error", payload: { code: "bad_json", message: "Malformed message" } });
		}

		switch (msg.t) {
			case "join": {
				const address = msg.payload.address;
				const tokenId = /^\d+$/.test(msg.payload.tokenId ?? "") ? BigInt(msg.payload.tokenId as string) : undefined;
				// Buy-to-play server gate (#100): only enforced when explicitly enabled
				// AND the relayer is live (env keys present). A wallet that owns no
				// on-chain hull is refused admission, so the free starter-sloop exploit
				// is closed at the authoritative layer, not just the menu. When the
				// gate is off (local dev / relayer disabled) play is unrestricted.
				if (BUY_TO_PLAY_SERVER && relayer.enabled) {
					if (!address) {
						send(client, { t: "error", payload: { code: "buy_to_play", message: "Connect a wallet to sail." } });
						break;
					}
					const owns = await relayer.ownsAnyShip(address);
					if (!owns) {
						send(client, { t: "error", payload: { code: "buy_to_play", message: "Buy a hull to set sail." } });
						break;
					}
				}
				const { ship, isNew } = world.acquireJoinHull(address, tokenId?.toString(), msg.payload.displayName);
				client.shipId = ship.id;
				client.address = msg.payload.address;
				send(client, {
					t: "welcome",
					payload: { selfShipId: ship.id, tickRateHz: TICK_RATE_HZ, worldSeed: 1337 },
				});
				// Only announce a brand-new hull; a re-adopted one is already known to
				// every client, and re-broadcasting it would duplicate the ship.
				if (isNew) broadcast({ t: "spawn", payload: { ship } });
				// Bring the newcomer up to date on what's already on the block.
				sendAuctionList(client);
				send(client, { t: "bounty:board", payload: { wanted: world.wantedBoard() } });
				send(client, { t: "trade:orders", payload: { orders: world.currentTrades() } });
				break;
			}
			case "input": {
				// Drive ONLY the hull this socket owns (never the client-supplied id).
				const ship = client.shipId ? world.getShip(client.shipId) : undefined;
				if (!ship) break;
				const rl = guard.rateLimit(ship);
				if (rl.length) {
					emitSecurity(rl);
					break; // drop the packet while a hull floods the input channel
				}
				const safeHelm = guard.sanitizeHelm(ship, msg.payload.helm);
				const safeAim = guard.sanitizeAim(ship, msg.payload.aim);
				emitSecurity(safeHelm.events);
				emitSecurity(safeAim.events);
				world.applyInput(ship.id, safeHelm.helm, safeAim.aim);
				break;
			}
			case "fire": {
				// Ownership gate: a client may only fire its OWN hull. Commanding
				// someone else's broadside is the one genuinely damaging cheat here,
				// so it is rejected outright and scored heavily.
				if (!client.shipId || client.shipId !== msg.payload.shipId) {
					const own = client.shipId ? world.getShip(client.shipId) : undefined;
					if (own) emitSecurity(guard.penalize(own, "ownership"));
					break;
				}
				const ship = world.getShip(client.shipId);
				if (!ship) break;
				// A non-finite turret heading would corrupt the shot; fall back to
				// the hull's own heading rather than penalising (likely a bug, not a
				// cheat).
				const th = Number.isFinite(msg.payload.turretHeading) ? msg.payload.turretHeading : ship.heading;
				world.fire(ship.id, th, msg.payload.ammo);
				break;
			}
			case "chain:bind": {
				if (client.shipId) world.setOwner(client.shipId, msg.payload.address, msg.payload.tokenId);
				client.address = msg.payload.address;
				break;
			}
			case "chain:bountyPosted": {
				relayer.registerBounty(
					msg.payload.bountyId,
					msg.payload.tokenId,
					msg.payload.declarer,
					msg.payload.amount
				);
				// Mirror onto the OFF-chain Most-Wanted board so every player sees the
				// live head-hunting marquee (independent of the relayer being live).
				broadcast({ t: "bounty:board", payload: { wanted: world.postBounty(msg.payload.tokenId, msg.payload.amount) } });
				break;
			}
			case "dock:unload": {
				if (client.shipId) world.unload(msg.payload.shipId ?? client.shipId);
				break;
			}
			case "dock:repair": {
				const id = client.shipId ?? msg.payload.shipId;
				if (id && world.repair(id)) {
					const tokenId = world.getShip(id)?.tokenId?.toString();
					// Provenance (design spec: on-chain ship history) — this hull came
					// back from the dead once. Fire-and-forget; tokenId is optional and
					// the relayer is a no-op when disabled.
					void relayer.onHullRepaired(tokenId);
				}
				break;
			}
			case "fleet:dispatch": {
				const address = client.address;
				if (!address) break;
				const tokenId = /^\d+$/.test(msg.payload.tokenId) ? BigInt(msg.payload.tokenId) : undefined;
				const ship = world.dispatch(address, msg.payload.name, tokenId);
				broadcast({ t: "spawn", payload: { ship } });
				break;
			}
			case "helm:switch": {
				const address = client.address;
				if (!address) break;
				const res = world.switchHull(address, msg.payload.shipId);
				// Only repoint the socket on a valid handover; the old hull auto-cruises,
				// the client retargets camera/input to the returned shipId.
				if (res.ok && res.shipId) {
					client.shipId = res.shipId;
					send(client, { t: "helm:switched", payload: { shipId: res.shipId } });
				}
				break;
			}
			case "helm:gear": {
					// Sail-order change drives ONLY the hull this socket owns; the client
					// may not order another captain's sails. Validated against the shared
					// gear set inside world.setGear.
					if (!client.shipId || client.shipId !== msg.payload.shipId) break;
					world.setGear(client.shipId, msg.payload.gear);
					break;
				}
				case "salvage:autoBuy": {
					if (!client.address) break;
					world.autoBuyMaterials(client.address, msg.payload.materials);
					const state = world.playerState(client.address);
					if (state) send(client, { t: "player:state", payload: { state } });
					break;
				}
				case "auction:listed": {
				const seller = (client.address ?? "").toLowerCase();
				if (!seller) break;
				auctions.set(msg.payload.auctionId, {
					auctionId: msg.payload.auctionId,
					tokenId: msg.payload.tokenId,
					seller,
					shipClass: msg.payload.shipClass,
					endsAt: msg.payload.endsAt,
				});
				broadcastAuctionList();
				break;
			}
			case "shop:buyItem": {
				if (!client.address) break;
				world.buyItem(client.address, msg.payload.itemId);
				// Echo the fresh ledger straight back so the shop updates instantly
				// (the tick loop would also push it, but that can lag a few frames).
				const state = world.playerState(client.address);
				if (state) send(client, { t: "player:state", payload: { state } });
				break;
			}
			case "shop:equip": {
				if (!client.address) break;
				world.equip(client.address, msg.payload.itemId, msg.payload.equipped);
				const state = world.playerState(client.address);
				if (state) send(client, { t: "player:state", payload: { state } });
				break;
			}
			case "trade:list": {
				if (!client.address || !client.shipId) break;
				const order = world.tradeList(
					client.address,
					client.shipId,
					msg.payload.kind,
					msg.payload.itemId,
					msg.payload.qty,
					msg.payload.price
				);
				// Only re-broadcast the roster when an order actually posted.
				if (order) broadcast({ t: "trade:orders", payload: { orders: world.currentTrades() } });
				break;
			}
			case "trade:buy": {
				if (!client.address || !client.shipId) break;
				if (world.tradeBuy(client.address, client.shipId, msg.payload.orderId)) {
					broadcast({ t: "trade:orders", payload: { orders: world.currentTrades() } });
				}
				break;
			}
			case "trade:cancel": {
				if (!client.address) break;
				if (world.tradeCancel(client.address, msg.payload.orderId)) {
					broadcast({ t: "trade:orders", payload: { orders: world.currentTrades() } });
				}
				break;
			}
			case "parley:demand": {
				if (!client.shipId) break;
				const r = world.demandParley(client.shipId, msg.payload.targetShipId);
				if (!r.ok) {
					send(client, { t: "parley:failed", payload: { reason: r.reason } });
					break;
				}
				// Put the demand to the defender (the strike-your-colors prompt) and ack
				// the attacker that terms are pending, both point-to-point.
				const defender = clientByShip(r.offer.defenderShipId);
				if (defender) send(defender, { t: "parley:incoming", payload: r.offer });
				const dShip = world.getShip(r.offer.defenderShipId);
				send(client, {
					t: "parley:asked",
					payload: {
						defenderShipId: r.offer.defenderShipId,
						defenderName: dShip?.name ?? "the prize",
						demand: r.offer.demand,
						ttlSeconds: r.offer.ttlSeconds,
					},
				});
				break;
			}
			case "parley:accept": {
				if (!client.shipId) break;
				const r = world.respondParley(client.shipId, true);
				if (!r.ok) {
					// Tell the defender it came to nothing, and the attacker their demand
					// fizzled (target sank / outran the guns).
					send(client, { t: "parley:failed", payload: { reason: r.reason } });
					if (r.attackerId) {
						const ac = clientByShip(r.attackerId);
						if (ac) send(ac, { t: "parley:failed", payload: { reason: r.reason } });
					}
					break;
				}
				const ac = clientByShip(r.resolved.attackerShipId);
				if (ac) send(ac, { t: "parley:resolved", payload: r.resolved });
				send(client, { t: "parley:resolved", payload: r.resolved });
				break;
			}
			case "parley:decline": {
				if (!client.shipId) break;
				const r = world.respondParley(client.shipId, false);
				if (!r.ok) {
					send(client, { t: "parley:failed", payload: { reason: r.reason } });
					break;
				}
				// The attacker learns they were refused and can reload and finish the job.
				const ac = clientByShip(r.resolved.attackerShipId);
				if (ac) send(ac, { t: "parley:resolved", payload: r.resolved });
				send(client, { t: "parley:resolved", payload: r.resolved });
				break;
			}
			case "ping": {
				send(client, { t: "welcome", payload: { selfShipId: client.shipId ?? "", tickRateHz: TICK_RATE_HZ, worldSeed: 1337 } });
				break;
			}
		}
	});

	ws.on("close", () => {
		if (client.shipId) {
			const id = client.shipId;
			guard.forget(id);
			world.despawnShip(id);
			broadcast({ t: "despawn", payload: { shipId: id } });
		}
		clients.delete(ws);
	});
});

// Fixed-timestep authoritative loop.
setInterval(() => {
	world.step(1 / TICK_RATE_HZ);
	const weather = world.weather;
	const tick = world.tick;
	const serverTimeMs = Date.now();
	// Send each socket the field AS ITS OWN HULL can see it — the weather culls
	// distant hulls out of the snapshot entirely (weather-as-cover), so a client
	// never receives a position it could not legally have sighted.
	for (const client of clients.values()) {
		if (client.ws.readyState !== WebSocket.OPEN) continue;
		send(client, {
			t: "snapshot",
			payload: { tick, serverTimeMs, ships: world.snapshotFor(client.shipId), weather, wrecks: world.wrecksFor(client.shipId), forts: world.fortStates() },
		});
	}
	// Flush any combat events this tick resolved (muzzle / shot / impact / sunk).
	for (const evt of world.drainEvents()) {
		broadcast({ t: "combat", payload: evt });
		// A hull sank: if it carried an open bounty, settle that USDG claim on-chain.
		// Fire-and-forget so a slow RPC never stalls the authoritative tick.
		if (evt.t === "sunk") {
			const victim = world.getShip(evt.shipId);
			const killer = evt.killerShipId ? world.getShip(evt.killerShipId) : undefined;
			// The wanted hull is gone: pull its bounty off the board and re-post the
			// marquee so the head-hunting list reflects the settlement.
			if (victim?.tokenId) {
				broadcast({ t: "bounty:board", payload: { wanted: world.clearWanted(victim.tokenId.toString()) } });
			}
			// Key the claim + provenance on the EXACT hull tokenIds, not the owner
			// wallets. Fire-and-forget so a slow RPC never stalls the tick.
			void relayer
				.onShipSunk(victim?.tokenId?.toString(), killer?.tokenId?.toString(), killer?.ownerAddress)
				.then((s) => {
					if (s) {
						broadcast({
							t: "chain:bountyClaimed",
							payload: { bountyId: s.bountyId, claimant: s.claimant, txHash: s.txHash, amount: s.amount },
						});
					}
				});
		}
	}
	// Flush off-chain economy updates: a player's ledger changed (send it only to
	// that player's socket) or a cache was dug (broadcast so every marker pops).
	for (const meta of world.drainMeta()) {
		if (meta.kind === "poi") {
			broadcast({ t: "poi:claimed", payload: { poiId: meta.poiId, shipId: meta.shipId, cargo: meta.cargo } });
			// A rare cache is the one POI that touches the chain: mint a loot NFT to
			// the digger's wallet, fire-and-forget so the RPC never stalls the tick.
			if (meta.rare && meta.ownerAddress) {
				void relayer.mintRareLoot(meta.ownerAddress, meta.tier);
			}
		} else if (meta.kind === "salvage") {
			// A wreck was dove: broadcast so every client drops that marker; the
			// salver's own toast rides the ledger update that follows.
			broadcast({ t: "salvage:claimed", payload: { wreckId: meta.wreckId, shipId: meta.shipId, cargo: meta.cargo, materials: meta.materials } });
		} else {
			const state = world.playerState(meta.address);
			if (!state) continue;
			for (const client of clients.values()) {
				if (client.address?.toLowerCase() === meta.address) send(client, { t: "player:state", payload: { state } });
			}
		}
	}
}, TICK_INTERVAL_MS);

// Liveness sweep: drop dead sockets.
setInterval(() => {
	for (const [ws, client] of clients) {
		if (!client.alive) {
			ws.terminate();
			clients.delete(ws);
			continue;
		}
		client.alive = false;
		ws.ping();
	}
}, 15000);

// Write-behind: flush durable state every 20s so a crash costs at most that much
// economy progress, and once more on a clean shutdown.
const PERSIST_INTERVAL_MS = 20_000;
setInterval(() => {
	void saveWorld();
}, PERSIST_INTERVAL_MS);
for (const sig of ["SIGINT", "SIGTERM"] as const) {
	process.on(sig, () => {
		// Flush once more, and on a clean exit wait for the Supabase mirror so the
		// last economy delta isn't lost to an in-flight network write.
		void saveWorld().finally(() => process.exit(0));
	});
}

console.log(`[highseaz-server] authoritative tick ${TICK_RATE_HZ}Hz on :${PORT}`);
