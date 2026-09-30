import type { ShipState, HelmInput, Heading, SecurityEvent, SecurityReason } from "../../shared-types/index.js";

/**
 * Server-authoritative anti-cheat.
 *
 * The server integrates every hull's physics; a client only ever sends *intent*
 * (helm + aim). That means the classic FPS cheats are structurally impossible
 * here — there is no position packet to forge, so no teleport or wallhack. What
 * a malicious client CAN do is feed the physics illegal inputs: a throttle above
 * 1.0 is a speed hack, a NaN helm corrupts the integration, and firing a shipId
 * it does not own commandeers someone else's broadside.
 *
 * The Guard's policy is "clamp + rollback": every illegal value is corrected back
 * to the nearest legal one before it reaches the World, and the offending hull
 * accrues a suspicion score. A hull that keeps offending is `flagged` so the HUD
 * can name it. Nothing here ever disconnects a player — it only neutralises the
 * advantage and makes it visible.
 */

/** Suspicion points added per offence, by kind. */
const COST: Record<SecurityReason, number> = {
	helm_clamp: 6,
	helm_nan: 10,
	aim_nan: 8,
	ownership: 25,
	rate_limit: 4,
};

/** Score at/above which a hull is publicly flagged as cheating. */
const FLAG_THRESHOLD = 40;
/** Ceiling so a long-cheating hull can't run away to infinity. */
const SCORE_CAP = 100;
/** Suspicion points shed per second of clean play. */
const DECAY_PER_S = 3;
/** Max input packets accepted per hull per second before rate-limiting. The
 *  client legitimately sends one per tick (~20/s); allow generous headroom. */
const MAX_INPUTS_PER_S = 60;

interface Watch {
	score: number;
	/** Wall-clock ms of the last decay pass, so score only drops over time. */
	lastDecayMs: number;
	/** Rolling input-arrival timestamps for the rate limiter. */
	inputAt: number[];
	/** Whether we've already emitted a `flagged` for the current strike. */
	flagged: boolean;
}

export class Guard {
	private watches = new Map<string, Watch>();

	private watch(id: string, now: number): Watch {
		let w = this.watches.get(id);
		if (!w) {
			w = { score: 0, lastDecayMs: now, inputAt: [], flagged: false };
			this.watches.set(id, w);
		}
		return w;
	}

	/** Shed suspicion for elapsed clean time, and clear the flag latch once the
	 *  hull drops back under the threshold so a future relapse can re-flag. */
	private decay(w: Watch, now: number): void {
		if (w.score <= 0) return;
		const dt = (now - w.lastDecayMs) / 1000;
		if (dt <= 0) return;
		w.score = Math.max(0, w.score - dt * DECAY_PER_S);
		if (w.score < FLAG_THRESHOLD) w.flagged = false;
	}

	/** Apply one offence's cost and return any events it triggers (a `blocked`
	 *  for the correction, and a one-shot `flagged` when the score crosses). */
	private bump(ship: ShipState, reason: SecurityReason, now: number): SecurityEvent[] {
		const w = this.watch(ship.id, now);
		this.decay(w, now);
		w.lastDecayMs = now;
		w.score = Math.min(SCORE_CAP, w.score + COST[reason]);
		const events: SecurityEvent[] = [
			{ t: "blocked", shipId: ship.id, shipName: ship.name, reason, score: Math.round(w.score) },
		];
		if (w.score >= FLAG_THRESHOLD && !w.flagged) {
			w.flagged = true;
			events.push({ t: "flagged", shipId: ship.id, shipName: ship.name, score: Math.round(w.score) });
		}
		return events;
	}

	/**
	 * Clamp a client's helm to the legal -1..1 range and reject non-finite
	 * channels. Returns the safe helm to hand the World plus any events.
	 */
	sanitizeHelm(ship: ShipState, helm: HelmInput, now = Date.now()): { helm: HelmInput; events: SecurityEvent[] } {
		const events: SecurityEvent[] = [];
		const t = helm?.throttle, r = helm?.rudder;
		if (!Number.isFinite(t) || !Number.isFinite(r)) {
			// A NaN would poison position forever — roll back to a dead helm.
			events.push(...this.bump(ship, "helm_nan", now));
			return { helm: { throttle: 0, rudder: 0 }, events };
		}
		const ct = Math.max(-1, Math.min(1, t));
		const cr = Math.max(-1, Math.min(1, r));
		if (ct !== t || cr !== r) events.push(...this.bump(ship, "helm_clamp", now));
		return { helm: { throttle: ct, rudder: cr }, events };
	}

	/** Drop a non-finite aim (a NaN heading would corrupt the hull). */
	sanitizeAim(ship: ShipState, aim: Heading | undefined, now = Date.now()): { aim?: Heading; events: SecurityEvent[] } {
		if (aim === undefined) return { aim: undefined, events: [] };
		if (!Number.isFinite(aim)) return { aim: undefined, events: this.bump(ship, "aim_nan", now) };
		return { aim, events: [] };
	}

	/**
	 * Record a deliberate offence against a hull (used for an ownership breach,
	 * where the offending party is the socket's OWN hull, not the hull it tried
	 * to command). Returns the events so the caller can broadcast them.
	 */
	penalize(ship: ShipState, reason: SecurityReason, now = Date.now()): SecurityEvent[] {
		return this.bump(ship, reason, now);
	}

	/** Rate-limit a hull's input packets; returns events if it's over budget. */
	rateLimit(ship: ShipState, now = Date.now()): SecurityEvent[] {
		const w = this.watch(ship.id, now);
		this.decay(w, now);
		w.lastDecayMs = now;
		// Keep only arrivals within the last second.
		const cutoff = now - 1000;
		while (w.inputAt.length && w.inputAt[0] < cutoff) w.inputAt.shift();
		w.inputAt.push(now);
		if (w.inputAt.length > MAX_INPUTS_PER_S) return this.bump(ship, "rate_limit", now);
		return [];
	}

	/** Forget a despawned hull so the map can't grow unbounded. */
	forget(shipId: string): void {
		this.watches.delete(shipId);
	}
}
