import { Guard } from "./src/guard.js";
import type { ShipState } from "../shared-types/index.js";

const ship = {
	id: "s1", name: "Speedy", shipClass: "starter_sloop", faction: "pirate", mode: "player",
	position: { x: 0, y: 0, z: 0 }, heading: 0, velocity: { x: 0, y: 0, z: 0 },
	angularVelocity: 0, hull: 100, cargo: 0, status: "active",
} as unknown as ShipState;

const g = new Guard();

const r1 = g.sanitizeHelm(ship, { throttle: 5, rudder: -3 });
console.log("1 clamp ->", JSON.stringify(r1.helm), "reasons:", r1.events.map((e) => e.reason));

const r2 = g.sanitizeHelm(ship, { throttle: NaN, rudder: 0.5 });
console.log("2 nan  ->", JSON.stringify(r2.helm), "reasons:", r2.events.map((e) => e.reason));

const a1 = g.sanitizeAim(ship, Number.NaN);
console.log("3 aim  ->", a1.aim, "reasons:", a1.events.map((e) => e.reason));

let flagged = false;
for (let i = 0; i < 10; i++) {
	const r = g.sanitizeHelm(ship, { throttle: 9, rudder: 9 });
	if (r.events.some((e) => e.t === "flagged")) flagged = true;
}
console.log("4 flagged after repeats:", flagged, "score:", (g as any).watches.get("s1").score);

const own = g.penalize(ship, "ownership");
console.log("5 ownership ->", own.map((e) => `${e.t}:${e.reason ?? ""}:${e.score}`));

const g2 = new Guard();
let fired = false;
for (let i = 0; i < 65; i++) if (g2.rateLimit(ship).length) fired = true;
console.log("6 rate_limit fired within 65 same-ms inputs:", fired);

const g3 = new Guard();
console.log("7 clean inputs stay silent:", g3.sanitizeHelm(ship, { throttle: 1, rudder: 0 }).events.length === 0 && g3.sanitizeAim(ship, 1.2).events.length === 0);
