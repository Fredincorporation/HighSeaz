import { TransformNode, Vector3, Scene, Scalar } from "@babylonjs/core";
import type { ShipState, WeatherState } from "@shared/index";
import { ShipModels } from "./ShipModels";
import { WakeSystem } from "./WakeSystem";
import { renderWaveAmp } from "../ocean/waveAmp";

/** How far behind the live feed remote ships are drawn (ms). Smooths jitter. */
const INTERP_DELAY_MS = 120;
/** Max snapshots held for interpolation. */
const BUFFER_LEN = 20;

interface Snap {
	/** Local arrival time (performance.now) — avoids client/server clock skew. */
	t: number;
	ships: Map<string, ShipState>;
}

interface Visual {
	root: TransformNode;
	cls: string;
	/** last applied transform, used for smoothing toward the interpolated target. */
	pos: Vector3;
	heading: number;
	spawning: boolean;
	/** Smoothed wave response, so the hull has mass instead of snapping to the sea. */
	heave: number;
	pitch: number;
	roll: number;
	/** Smoothed wind-driven heel (radians, + = starboard/leeward). The steady lean
	 *  a sailing hull makes under sail — the sail-load cue on top of wave roll. */
	heel: number;
	/** Sinking progress, 0 (afloat) .. 1 (settled under). Driven purely by the
	 *  server status so a sunk hull visibly lists and slides below the surface
	 *  instead of freezing upright in place; resets when the hull is repaired. */
	sink: number;
}

/**
 * Reconciles authoritative snapshots onto rendered GLB hulls.
 * - Remote ships: interpolated between the two snapshots bracketing
 *   (now - INTERP_DELAY) for smooth motion at render framerate.
 * - Own ship: extrapolated forward from the latest snapshot using its velocity
 *   so local controls feel immediate (full rollback/prediction is a later pass).
 * - Wave bob/roll is applied from the shared WeatherState so hulls ride the sea.
 */
export class ShipManager {
	private visuals = new Map<string, Visual>();
	private buffer: Snap[] = [];
	private models: ShipModels;
	private wake: WakeSystem;
	private time = 0;

	constructor(private scene: Scene) {
		this.models = new ShipModels(scene);
		this.wake = new WakeSystem(scene);
	}

	/** Called for every snapshot received from the server. */
	ingest(ships: ShipState[]): void {
		const map = new Map<string, ShipState>();
		for (const s of ships) map.set(s.id, s);
		this.buffer.push({ t: performance.now(), ships: map });
		if (this.buffer.length > BUFFER_LEN) this.buffer.shift();
	}

	/** Per-frame: build interpolated/extrapolated targets and drive meshes. */
	update(dt: number, weather: WeatherState, selfId: string | null): void {
		if (this.buffer.length === 0) return;
		this.time += dt;
		const now = performance.now();
		const renderTime = now - INTERP_DELAY_MS;

		// Find the two snapshots bracketing renderTime.
		let a = this.buffer[0];
		let b = this.buffer[this.buffer.length - 1];
		for (let i = 0; i < this.buffer.length - 1; i++) {
			if (this.buffer[i].t <= renderTime && this.buffer[i + 1].t >= renderTime) {
				a = this.buffer[i];
				b = this.buffer[i + 1];
				break;
			}
		}
		const span = b.t - a.t || 1;
		const alpha = Scalar.Clamp((renderTime - a.t) / span);

		const latest = this.buffer[this.buffer.length - 1];
		const elapsed = (now - latest.t) / 1000;

		const seen = new Set<string>();

		for (const [id, target] of latest.ships) {
			seen.add(id);
			let v = this.visuals.get(id);
			if (!v) {
				v = this.createVisual(id, target);
				this.visuals.set(id, v);
			}
			if (v.spawning) continue;

			let desiredPos: Vector3;
			let desiredHeading: number;

			if (id === selfId) {
				// Own ship: extrapolate from latest authoritative state.
				desiredPos = new Vector3(
					target.position.x + target.velocity.x * elapsed,
					0,
					target.position.z + target.velocity.z * elapsed
				);
				desiredHeading = target.heading + target.angularVelocity * elapsed;
			} else {
				const sa = a.ships.get(id);
				const sb = b.ships.get(id);
				if (sa && sb) {
					desiredPos = new Vector3(
						Scalar.Lerp(sa.position.x, sb.position.x, alpha),
						0,
						Scalar.Lerp(sa.position.z, sb.position.z, alpha)
					);
					desiredHeading = lerpAngle(sa.heading, sb.heading, alpha);
				} else {
					desiredPos = new Vector3(target.position.x, 0, target.position.z);
					desiredHeading = target.heading;
				}
			}

			// Smooth toward the target (frame-rate independent).
			const k = 1 - Math.pow(0.0001, dt);
			v.pos = Vector3.Lerp(v.pos, desiredPos, k);
			v.heading = lerpAngle(v.heading, desiredHeading, k);

			// Wave response. The hull rides the SAME spectrum the shader draws —
			// see gerstnerHeight() for why an approximate mirror is not good enough
			// (it was the cause of the ship floating above the water). Amplitude is
			// scaled by the sea-state mask below the hull, exactly as the vertex
			// shader does, so the hull follows the calm/choppy patches too.
			const amp = renderWaveAmp(weather.waveAmplitude) * seaState(v.pos.x, v.pos.z);
			const wlen = Math.hypot(weather.wind.x, weather.wind.z) || 1;
			const wx = weather.wind.x / wlen;
			const wz = weather.wind.z / wlen;
			const terms = waveTerms(wx, wz);

			// Sample fore, aft and amidships so heave and pitch both come from the
			// real slope of the sea under the hull.
			const HULL_LEN = 11;
			const bowX = Math.sin(v.heading) * HULL_LEN;
			const bowZ = Math.cos(v.heading) * HULL_LEN;
			const hFwd = gerstnerHeight(v.pos.x + bowX, v.pos.z + bowZ, terms, this.time, amp);
			const hAft = gerstnerHeight(v.pos.x - bowX, v.pos.z - bowZ, terms, this.time, amp);
			const hMid = gerstnerHeight(v.pos.x, v.pos.z, terms, this.time, amp);

			// Heave from the surface at the hull's own station, plus the draft so
			// the waterline sits ON the hull rather than below it.
			const heave = hMid;
			// Pitch from the fore/aft height difference — a measured slope, not a
			// guessed sine. No extra gain: the slope is already the real thing.
			const pitch = Math.atan2(hFwd - hAft, HULL_LEN * 2);
			// Roll across the BEAM, so a beam sea genuinely heels her over. A hull
			// resists roll more than pitch in roll inertia, but the wave slope
			// across the beam is what drives it, so keep this physical too.
			const beamX = Math.cos(v.heading) * 4;
			const beamZ = -Math.sin(v.heading) * 4;
			const hStbd = gerstnerHeight(v.pos.x + beamX, v.pos.z + beamZ, terms, this.time, amp);
			const hPort = gerstnerHeight(v.pos.x - beamX, v.pos.z - beamZ, terms, this.time, amp);
			const roll = Math.atan2(hStbd - hPort, 8);

			// Wind-driven heel (sail-load lean). The apparent wind's starboard lateral
			// push heels her to starboard (leeward): strongest on a beam reach, gone
			// running dead-downwind or pointing into the wind, softened by speed
			// (hydrodynamic righting). The cue that she is a hull under sail load.
			const spd = Math.hypot(target.velocity.x, target.velocity.z);
			const alongR = wx * Math.cos(v.heading) - wz * Math.sin(v.heading);
			const windPower = Math.min(1, wlen / 14);
			const K_HEEL = 0.3; // max steady heel (rad) at a full beam reach
			let heelTarget = K_HEEL * alongR * windPower * (1 - 0.35 * Math.min(1, spd / 14));
			// A light rig shiver when there is breeze but she is close to the wind
			// (little steady heel), so the canvas still reads alive, not frozen.
			if (windPower > 0.15) {
				heelTarget += Math.sin(this.time * 3.1 + hashPhase(id)) * 0.012 * windPower * (1 - Math.abs(alongR));
			}

			// Slower, heavier motion than the old fixed sines: a loaded hull
			// answers the sea lazily, and that lag is most of what reads as mass.
			const smooth = 1 - Math.pow(0.02, dt);
			v.heave += (heave - v.heave) * smooth;
			v.pitch += (pitch - v.pitch) * smooth;
			v.roll += (roll - v.roll) * smooth;
			// Heel is the steady sailing load — eases slower than the wave roll so she
			// leans into a tack and recovers gradually, with weight.
			v.heel += (heelTarget - v.heel) * (1 - Math.pow(0.05, dt));

			// Sink response: the server flags a hull `sunk_needs_repair`. Rather than a
			// uniform tilt-and-slide (which read as floaty), she holds near the surface
			// while she floods, then accelerates into a roll-over-and-plunge, easing off
			// the wave bob as she loses buoyancy. Repair flips her back to `active` and
			// she re-floats quickly. Purely cosmetic — the authoritative sim already
			// stopped her.
			const sunk = target.status === "sunk_needs_repair";
			// Slower flood (0.5) so the death plays out in stages; fast re-float on repair.
			v.sink += ((sunk ? 1 : 0) - v.sink) * (sunk ? 1 - Math.pow(0.5, dt) : 1 - Math.pow(0.0005, dt));
			if (v.sink < 0.001) v.sink = sunk ? v.sink : 0;
			const p = v.sink;
			// Ease-IN: linger high while flooding, then plunge — the opposite of the old
			// ease-out dip, which was brisk at the start and stalled just before going under.
			const plunge = p * p;
			const bob = 1 - p; // wave motion fades as the hull loses buoyancy
			// Deterministic personality so each hull dies its own way.
			const seed = hashId(id);
			const rollDir = (seed & 1) === 0 ? 1 : -1; // over which beam she goes
			const bowDown = (seed & 2) === 0 ? 1 : -1; // settles bow- or stern-first
			// A mid-sink lurch, strongest halfway down, sells the struggle before the end.
			const wobble = Math.sin(this.time * 2.6 + (seed & 7)) * 0.16 * Math.sin(Math.PI * p);
			const CAPSIZE = 1.5; // ~86deg: she rolls right over, not a gentle list
			const END_DIVE = 0.75; // rad settling one end down
			const SUBMERGE = 16; // deep enough that mast and rigging clear the surface

			v.root.position.set(v.pos.x, v.heave * bob - SUBMERGE * plunge, v.pos.z);
			v.root.rotation.set(
				v.pitch * bob + bowDown * END_DIVE * plunge,
				v.heading,
				v.roll * bob + v.heel * bob + rollDir * (CAPSIZE * plunge + wobble)
			);

			const speed = Math.hypot(target.velocity.x, target.velocity.z);
			// A sinking/derelict hull throws no wake.
			this.wake.update(id, v.root.position, v.heading, speed * bob, dt);
		}

		// Remove ships that despawned.
		for (const [id, v] of this.visuals) {
			if (!seen.has(id)) {
				v.root.dispose();
				this.wake.remove(id);
				this.visuals.delete(id);
			}
		}
	}

	private createVisual(id: string, s: ShipState): Visual {
		const root = new TransformNode(`ship_${id}_pending`, this.scene);
		// Seat the placeholder at the real transform immediately: the loaded model
		// copies this on swap-in, so a stale (0,0,0) here would flash the hull at
		// the world origin (and facing 0) for a frame.
		root.position.set(s.position.x, 0, s.position.z);
		root.rotation.y = s.heading;
		const v: Visual = {
			root,
			cls: s.shipClass,
			pos: new Vector3(s.position.x, 0, s.position.z),
			heading: s.heading,
			spawning: true,
			heave: 0,
			pitch: 0,
			roll: 0,
			heel: 0,
			sink: 0,
		};
		this.models
			.spawn(s.shipClass, id)
			.then((loaded) => {
				// Swap the pending placeholder root for the loaded model root.
				loaded.position.copyFrom(root.position);
				loaded.rotation.copyFrom(root.rotation);
				root.dispose();
				v.root = loaded;
				v.spawning = false;
			})
			.catch((err: unknown) => {
				// A rejected GLB here used to surface as an unhandled rejection and a
				// permanently invisible hull — no console clue the model failed. Say so,
				// and drop the pending placeholder so we do not leak it every snapshot.
				console.error(`[ShipModels] failed to load hull "${s.shipClass}" for ${id}`, err);
				root.dispose();
				this.visuals.delete(id);
			});
		return v;
	}

	getSelfPosition(selfId: string | null): Vector3 | null {
		const v = selfId ? this.visuals.get(selfId) : undefined;
		return v && !v.spawning ? v.root.position : null;
	}

	/** World position of ANY hull by id (own or remote) — used to land combat FX. */
	getPosition(id: string): Vector3 | null {
		const v = this.visuals.get(id);
		return v && !v.spawning ? v.root.position : null;
	}

	/**
	 * The hull root TransformNode of a rendered ship (own or remote), or null while
	 * it is still spawning / not present. Used by the hull-decal pass (task #141) to
	 * parent a scorch quad onto the victim's own transform so it rides the hull's
	 * roll/pitch/sink for free — the ship is a GPU-only mesh with no CPU vertices, so
	 * a real projected surface decal is not possible; a child quad is the cheap stand-in.
	 */
	getHullRoot(id: string): TransformNode | null {
		const v = this.visuals.get(id);
		return v && !v.spawning ? v.root : null;
	}

	/** Latest authoritative states (for HUD + identification markers). */
	getLatestStates(): ShipState[] {
		if (this.buffer.length === 0) return [];
		return [...this.buffer[this.buffer.length - 1].ships.values()];
	}

	getState(id: string): ShipState | null {
		if (this.buffer.length === 0) return null;
		return this.buffer[this.buffer.length - 1].ships.get(id) ?? null;
	}

	getSelfHeading(selfId: string | null): number | null {
		const v = selfId ? this.visuals.get(selfId) : undefined;
		return v && !v.spawning ? v.heading : null;
	}

	/**
	 * Anchor the far-field scenery ring on the player. Safe to call every frame:
	 * the scatter is built once and only wrapped thereafter.
	 */
	followClutter(x: number, z: number, vx: number, vz: number, dt: number): void {
		this.wake.follow(x, z, vx, vz, dt);
	}

	/** QA: did the sea clutter actually load? Surfaced on the dev handle. */
	clutterStats(): { spawned: number; expected: number; failed: string[] } {
		return this.wake.clutterStats();
	}

	dispose(): void {
		for (const v of this.visuals.values()) v.root.dispose();
		this.visuals.clear();
		this.wake.dispose();
		this.models.dispose();
	}
}

function lerpAngle(a: number, b: number, t: number): number {
	return a + shortAngle(a, b) * t;
}

/**
 * The sea surface is displaced entirely on the GPU, so nothing on the CPU knows
 * where the water actually is. To seat a hull on the sea we must reproduce the
 * shader's own spectrum — and reproduce it EXACTLY, because any drift shows up
 * as a ship hovering above or buried in a crest.
 *
 * Two properties of the shader make the naive version wrong, and both were bugs
 * in the first attempt at this function:
 *
 * 1. `addWave` accumulates horizontal displacement into `pos`, and each
 *    subsequent wave samples `dot(d, pos.xz)` from that ALREADY-DISPLACED
 *    point. So the waves are not independent — they are applied in sequence to
 *    a point that keeps moving. Sampling the original (x, z) for every wave, as
 *    the naive version did, desynchronises the sum by metres on steep crests.
 *
 * 2. `f = k * (dot(d, pos.xz) - c * iTime)` has no per-ship phase term. Adding
 *    one (to de-sync a fleet) shifts every wave by up to a full period, which
 *    lifts the whole hull off the surface. Individual hulls are de-synced by
 *    where they are, not by a phase offset.
 *
 * Those two errors are why the ship appeared to float: the CPU was solving a
 * different sea than the one being drawn.
 *
 * Height is then resolved by inverting the horizontal displacement with
 * fixed-point steps. Gerstner waves move points sideways by several metres, so
 * reading `y` at the raw query point lands on the wrong part of the wave. The
 * reference measures this at 0.15 m average and 1.17 m worst-case on steep
 * crests; four steps bring the worst horizontal miss under 0.2 m.
 */

/**
 * Large-scale sea-state mask — MUST stay byte-for-byte in sync with `seaState()`
 * in ocean/shaders.ts. The GPU scales every hull's local wave amplitude by it,
 * so if the CPU mirror that seats the hull on the water did not apply the same
 * factor, the ship would ride too high over calm patches and sink into choppy
 * ones. Pure function of world position; Math.sin/cos match GLSL exactly.
 */
function seaState(x: number, z: number): number {
	const m = Math.sin(x * 0.0016 + Math.sin(z * 0.0013)) * Math.cos(z * 0.0011);
	return Math.max(0.35, Math.min(1.25, 0.55 + 0.45 * m));
}

/** FNV-1a over a ship id — cheap, stable, used to give each sinking hull its own
 *  personality (which beam it rolls over, which end it settles by) so a multi-ship
 *  wreck doesn't capsize in lockstep. */
function hashId(id: string): number {
	let h = 2166136261;
	for (let i = 0; i < id.length; i++) {
		h ^= id.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return h >>> 0;
}

/** Wave terms, in the same order and with the same constants as OCEAN_VERTEX. */
interface WaveTerm {
	dx: number;
	dz: number;
	steep: number;
	k: number;
	c: number;
}

function waveTerms(wx: number, wz: number): WaveTerm[] {
	// Mirrors the four addWave() calls in ocean/shaders.ts, including the
	// normalisation each one performs on its own direction vector.
	const raw: [number, number, number, number][] = [
		[wx, wz, 0.22, 120],
		[wx + 0.6, wz - 0.2, 0.18, 70],
		[wx - 0.5, wz + 0.5, 0.14, 42],
		[-wz, wx, 0.1, 26],
	];
	return raw.map(([dx, dz, steep, wavelength]) => {
		const len = Math.hypot(dx, dz) || 1;
		const k = 6.2831853 / wavelength;
		return { dx: dx / len, dz: dz / len, steep, k, c: Math.sqrt(9.8 / k) };
	});
}

/**
 * Displacement of a surface point, matching `addWave` exactly: the horizontal
 * offset accumulates across waves and feeds the next wave's phase. `outY` is
 * the vertical displacement at that point.
 */
function gerstnerDisplace(
	x: number,
	z: number,
	terms: WaveTerm[],
	time: number,
	waveAmp: number,
	out: { x: number; z: number; y: number }
): void {
	let px = x;
	let pz = z;
	let py = 0;
	for (const t of terms) {
		const f = t.k * (t.dx * px + t.dz * pz - t.c * time);
		const a = (t.steep / t.k) * waveAmp;
		const wcos = Math.cos(f);
		const wsin = Math.sin(f);
		px += t.dx * a * wcos;
		pz += t.dz * a * wcos;
		py += a * wsin;
	}
	out.x = px;
	out.z = pz;
	out.y = py;
}

/** Scratch objects — this runs per hull per frame and must not allocate. */
const _disp = { x: 0, z: 0, y: 0 };

/**
 * Surface height at a world point, i.e. "where is the water at (x, z)?".
 *
 * The shader answers the inverse question (given a grid point, where does it
 * end up), so we solve it with fixed-point iteration: guess the undisplaced
 * point, push it through the displacement, measure how far it landed from the
 * query, and subtract that error. Four steps converge to well under a metre.
 */
function gerstnerHeight(
	x: number,
	z: number,
	terms: WaveTerm[],
	time: number,
	waveAmp: number
): number {
	let gx = x;
	let gz = z;
	for (let i = 0; i < 4; i++) {
		gerstnerDisplace(gx, gz, terms, time, waveAmp, _disp);
		gx -= _disp.x - x;
		gz -= _disp.z - z;
	}
	gerstnerDisplace(gx, gz, terms, time, waveAmp, _disp);
	return _disp.y;
}

/** Surface normal at a world point, from the analytic horizontal derivatives. */
function gerstnerNormal(
	x: number,
	z: number,
	terms: WaveTerm[],
	time: number,
	waveAmp: number,
	out: { x: number; y: number; z: number }
): void {
	// Central differences on the height field: 2 extra height solves per axis,
	// which is affordable for a handful of hulls and avoids re-deriving the
	// tangent/binormal accumulation by hand.
	const e = 0.75;
	const hL = gerstnerHeight(x - e, z, terms, time, waveAmp);
	const hR = gerstnerHeight(x + e, z, terms, time, waveAmp);
	const hD = gerstnerHeight(x, z - e, terms, time, waveAmp);
	const hU = gerstnerHeight(x, z + e, terms, time, waveAmp);
	const nx = hL - hR;
	const nz = hD - hU;
	const ny = 2 * e;
	const len = Math.hypot(nx, ny, nz) || 1;
	out.x = nx / len;
	out.y = ny / len;
	out.z = nz / len;
}

function shortAngle(from: number, to: number): number {
	let d = (to - from) % (Math.PI * 2);
	if (d > Math.PI) d -= Math.PI * 2;
	if (d < -Math.PI) d += Math.PI * 2;
	return d;
}

function hashPhase(id: string): number {
	let h = 0;
	for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
	return (h & 0xffff) / 0xffff * Math.PI * 2;
}
