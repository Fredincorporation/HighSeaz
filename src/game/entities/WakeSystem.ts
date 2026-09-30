import {
	ParticleSystem,
	Texture,
	Color4,
	Vector3,
	Scene,
	TransformNode,
	SceneLoader,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF"; // side-effect: registers the .glb loader with SceneLoader
import { asset } from "../core/assets";

/**
 * Deterministic 0..1 hash — same input, same output, forever. Used to place
 * scenery without a persisted layout and to de-sync wave phases per hull.
 */
function hash01(str: string): number {
	let h = 2166136261;
	for (let i = 0; i < str.length; i++) {
		h ^= str.charCodeAt(i);
		h = Math.imul(h, 16777619);
	}
	return (h >>> 0) / 4294967296;
}

interface Wake {
	ps: ParticleSystem;
	emitter: Vector3;
	/** Foam breaking at the stem — the cue that the hull is driving forward. */
	bowPs: ParticleSystem;
}

/**
 * Deterministic scatter for the sea clutter the player actually sails past.
 *
 * The wake alone is not enough to read as forward motion: a foam trail that
 * stays in shot reads as "object on a treadmill". What sells speed is
 * PARALLAX — distinct, opaque objects crossing the frame at different rates —
 * so this is the half of the fix that changes what the world looks like.
 *
 * All layout is a function of a constant seed, so two clients (and a reload)
 * agree on where the rocks are without the server having to replicate any of
 * it. World is draw-call limited, so we only add a handful of items.
 */
const CLUTTER_SEED = "highseaz-v1";

interface ClutterItem {
	/** Sink/bob phase so the whole scatter does not rise and fall in unison. */
	phase: number;
	/** Radians per second of tumble/roll; 0 for items that only bob. */
	tumble: number;
	baseY: number;
	/** Half-size of this item's wrap box (near vs far parallax layer). */
	wrapR: number;
	/** World-space shove velocity imparted when the hull pushes this item aside.
	 *  Decays under water drag so the flotsam slides clear of the ship, then
	 *  settles back into the field. 0 when at rest. */
	vx: number;
	vz: number;
	/** Collision radius (world units) for the hull push. Far items never collide. */
	radius: number;
}

interface ClutterSpec {
	model: string;
	scale: number;
	count: number;
	/** Far-field landmarks sit on the horizon and slide slowly; near clutter
	 *  hugs the hull and streams past fast. Two layers = readable parallax. */
	far: boolean;
	/** Base tumble rate. */
	tumble: number;
}

// Near clutter is scattered through a box of this half-size centred on the
// player and wrapped modulo it, so there is always debris sweeping past the
// hull. Far landmarks wrap in a much larger box so they stay on the horizon.
// WRAP_NEAR sets BOTH the passing rate (smaller box = more crossings = faster
// read) AND the density (items per unit area). It was tuned too tight and too
// dense — the sea read as a littered junkyard with props on top of the deck.
// Loosened so the field breathes.
const WRAP_NEAR = 120;
const WRAP_FAR = 620;

// ---- Hull / debris interaction --------------------------------------------
// The near field is the ONLY thing the player physically shares water with on
// the client (gameplay wrecks are server radius checks, not geometry). Without
// a hull exclusion every prop sails straight through the deck — visually wrong
// and the main reason the clutter felt like "too much". The hull is modelled as
// a circle this radius (the wake spans -11..+9, so 11 is the true footprint),
// and any near item inside `HULL_R + item.radius` is pushed clear and shoved
// along the ship's heading so it parts at the bow and is left behind — the
// player literally moves the debris out of the way.
const HULL_R = 11;
/** Per-second exponential damping of a debris shove (water drag). */
const CLUTTER_DRAG = 1.5;
/** Minimum outward shove (units/s) so even dead-slow contact visibly clears. */
const SHOVE_BASE = 7;
/** Extra outward shove proportional to hull speed. */
const SHOVE_SPEED = 0.6;
/** Fraction of the hull's own velocity handed to the debris (wake carry). */
const SHOVE_CARRY = 0.4;

// ---- Drift-patch distribution ---------------------------------------------
// Real flotsam does not sit in a uniform grid; it gathers in scattered bands
// with clear water between. Near props are seeded into this many loose patches
// of this radius instead of a uniform sprinkle, so the field reads as drift
// lanes you sail through, not wallpaper on every wave.
const NEAR_PATCHES = 7;
const NEAR_PATCH_R = 24;

const CLUTTER: ClutterSpec[] = [
	// Weighted toward SMALL, CLOSE items: near-field objects sweeping past the
	// hull are what read as speed. Counts are deliberately modest — the passing
	// cue survives on far fewer props, and every clone is a full GLB subtree, so
	// density is also an OOM budget, not just taste.
	{ model: "floating plank.glb", scale: 3, count: 9, far: false, tumble: 0.5 },
	{ model: "floating barrel.glb", scale: 3, count: 6, far: false, tumble: 0.34 },
	{ model: "ship debris.glb", scale: 2.5, count: 5, far: false, tumble: 0.22 },
	{ model: "floating crate.glb", scale: 3, count: 4, far: false, tumble: 0.26 },
	{ model: "buoy.glb", scale: 1.6, count: 3, far: false, tumble: 0.5 },
	{ model: "treasure chest floating.glb", scale: 2.2, count: 2, far: false, tumble: 0.2 },
	// NOTE: islands + lighthouse no longer live here. A far landmark that
	// toroidally wraps teleports instead of being approached, which is the
	// opposite of what a horizon landmark should do. They are now FIXED,
	// seeded world objects in IslandSystem (Phase 1); this field is purely the
	// near-field floating debris whose passing rate sells forward speed.
];

/**
 * Speed-driven foam wake behind each moving hull, plus the deterministic
 * near-field clutter that provides the parallax cue.
 */
export class WakeSystem {
	private wakes = new Map<string, Wake>();
	private tex: Texture;

	private clutterRoot: TransformNode | null = null;
	private clutterItems: ClutterItem[] = [];
	private clutterNodes: TransformNode[] = [];
	private clutterLoading = false;
	private time = 0;
	/** QA counters: how many clutter props actually made it into the scene. */
	private clutterSpawned = 0;
	private clutterFailed: string[] = [];

	constructor(private scene: Scene) {
		this.tex = new Texture(asset("/vfx/water_impact.png"), scene);
	}

	/**
	 * Scatter the floating clutter deterministically around the origin. The field
	 * is folded around the player every frame by wrapClutter, so it always
	 * surrounds the hull rather than sitting in one fixed patch. Positions are
	 * computed before the GLBs resolve, so the layout is fully deterministic
	 * regardless of network timing.
	 */
	private buildClutter(): void {
		if (this.clutterRoot || this.clutterLoading) return;
		this.clutterLoading = true;

		const root = new TransformNode("seaClutter", this.scene);
		this.clutterRoot = root;

		// Drift-patch centres the near field clumps into (see NEAR_PATCHES). A
		// handful of loose bands with clear water between reads as flotsam lines
		// you sail through, not a uniform sprinkle welded onto every wave.
		const patches: Array<{ x: number; z: number }> = [];
		for (let pi = 0; pi < NEAR_PATCHES; pi++) {
			const pk = `${CLUTTER_SEED}:patch:${pi}`;
			patches.push({
				x: (hash01(pk + "x") * 2 - 1) * WRAP_NEAR * 0.7,
				z: (hash01(pk + "z") * 2 - 1) * WRAP_NEAR * 0.7,
			});
		}

		// Place every slot first — cheap, synchronous, deterministic. Positions are
		// authored around the ORIGIN; wrapClutter then folds them into a box centred
		// on the player every frame, so the field always surrounds the hull no matter
		// how far it has sailed. Near items fill a small box (fast parallax); far
		// landmarks ride a big ring on the horizon (slow parallax).
		for (let specIdx = 0; specIdx < CLUTTER.length; specIdx++) {
			const spec = CLUTTER[specIdx];
			const wrapR = spec.far ? WRAP_FAR : WRAP_NEAR;
			for (let i = 0; i < spec.count; i++) {
				const key = `${CLUTTER_SEED}:${spec.model}:${i}`;
				const node = new TransformNode(`clutter_${specIdx}_${i}`, this.scene);
				node.parent = root;
				let px: number;
				let pz: number;
				if (spec.far) {
					const a = hash01(key + "a") * Math.PI * 2;
					const r = wrapR * (0.72 + hash01(key + "r") * 0.2);
					px = Math.sin(a) * r;
					pz = Math.cos(a) * r;
				} else {
					// Clump into one seeded drift patch, then jitter inside its radius.
					const pc = patches[Math.floor(hash01(key + "patch") * NEAR_PATCHES) % NEAR_PATCHES];
					const pa = hash01(key + "pa") * Math.PI * 2;
					const pr = Math.sqrt(hash01(key + "pr")) * NEAR_PATCH_R;
					px = pc.x + Math.cos(pa) * pr;
					pz = pc.z + Math.sin(pa) * pr;
				}
				node.position.set(px, 0, pz);
				node.rotation.y = hash01(key + "yaw") * Math.PI * 2;
				const s = spec.scale * (0.75 + hash01(key + "s") * 0.5);
				node.scaling.setAll(s);
				node.setEnabled(false);

				this.clutterItems.push({
					phase: hash01(key + "p") * Math.PI * 2,
					tumble: spec.tumble * (0.6 + hash01(key + "t") * 0.8),
					baseY: 0,
					wrapR,
					vx: 0,
					vz: 0,
					radius: s * 1.6,
				});
				this.clutterNodes.push(node);
			}
		}

		// One container per distinct model, then clone into the placed slots.
		const byModel = new Map<string, TransformNode[]>();
		let cursor = 0;
		for (const spec of CLUTTER) {
			const slots: TransformNode[] = [];
			for (let i = 0; i < spec.count; i++) slots.push(this.clutterNodes[cursor++]);
			byModel.set(spec.model, slots);
		}

		for (const [model, slots] of byModel) {
			SceneLoader.LoadAssetContainerAsync(asset("/models/"), model, this.scene, undefined, ".glb")
				.then((container) => {
					const roots = container.rootNodes;
					container.meshes.forEach((m) => m.setEnabled(false));
					let cloned = 0;
					for (const slot of slots) {
						for (const r of roots) {
							const clone = (
								r as unknown as { clone: (n: string) => { parent?: unknown } | null }
							).clone(`${slot.name}_${r.name}`);
							if (!clone) continue;
							clone.parent = slot;
							cloned++;
						}
						slot.setEnabled(true);
						// The source meshes were disabled above to hide the template, and
						// the freshly cloned meshes inherit that disabled state. Enabling
						// only the cloned root node left the actual geometry hidden — the
						// props were in the scene graph (spawned count looked fine) but
						// nothing rendered. Re-enable the whole mesh subtree per slot.
						slot.getChildMeshes(false).forEach((mm) => mm.setEnabled(true));
					}
					this.clutterSpawned += slots.length;
					if (cloned === 0) this.clutterFailed.push(`${model}: no root nodes`);
				})
				.catch((err: unknown) => {
					// Surfaced rather than swallowed: a silent catch here once hid the
					// fact that no scenery was loading at all, which cost a full
					// debugging round. Scenery is still non-fatal — we just say so.
					this.clutterFailed.push(`${model}: ${err instanceof Error ? err.message : String(err)}`);
				});
		}
	}

	/** Load/scatter diagnostics, surfaced on the dev handle for QA. */
	clutterStats(): { spawned: number; expected: number; failed: string[] } {
		return {
			spawned: this.clutterSpawned,
			expected: this.clutterNodes.length,
			failed: this.clutterFailed,
		};
	}

	/**
	 * Fold every item into the box centred on the player (toroidal wrap). Because
	 * each item carries its own wrap radius, the near layer recycles tightly and
	 * constantly around the hull while the far landmarks drift slowly on a much
	 * larger ring — the two-rate motion is exactly the parallax that reads as
	 * forward travel. An item only ever teleports once it is a full box-width
	 * behind the player, off-screen, so the wrap is never seen to pop.
	 */
	private wrapClutter(x: number, z: number): void {
		if (this.clutterNodes.length === 0) return;
		for (let i = 0; i < this.clutterNodes.length; i++) {
			const node = this.clutterNodes[i];
			const item = this.clutterItems[i];
			const R = item.wrapR;
			const span = 2 * R;
			const rawDx = node.position.x - x;
			const rawDz = node.position.z - z;
			const dx = ((((rawDx + R) % span) + span) % span) - R;
			const dz = ((((rawDz + R) % span) + span) % span) - R;
			// If the fold moved the item, it just teleported to the far side to be
			// recycled — drop any shove velocity so it re-enters the field at rest.
			if (dx !== rawDx || dz !== rawDz) {
				item.vx = 0;
				item.vz = 0;
			}
			node.position.x = x + dx;
			node.position.z = z + dz;
		}
	}

	/**
	 * Anchor the near clutter on the player and make it behave like floating
	 * flotsam the hull displaces. Runs once per frame (unlike `update`, which is
	 * per-hull). Order per frame:
	 *   1. carry — integrate any shove velocity into the world position, then
	 *      damp it (water drag), so pushed debris keeps sliding aside and settles;
	 *   2. recycle — fold items that have drifted past the box back to the far side;
	 *   3. displace — push every near item clear of the hull footprint and hand it
	 *      the ship's shove, so debris parts at the bow instead of clipping through.
	 */
	follow(x: number, z: number, vx: number, vz: number, dt: number): void {
		this.buildClutter();

		const damp = Math.exp(-CLUTTER_DRAG * dt);
		for (let i = 0; i < this.clutterNodes.length; i++) {
			const item = this.clutterItems[i];
			if (item.wrapR !== WRAP_NEAR) continue; // far landmarks: no dynamics
			if (item.vx === 0 && item.vz === 0) continue;
			const node = this.clutterNodes[i];
			node.position.x += item.vx * dt;
			node.position.z += item.vz * dt;
			item.vx *= damp;
			item.vz *= damp;
			if (Math.abs(item.vx) < 0.02) item.vx = 0;
			if (Math.abs(item.vz) < 0.02) item.vz = 0;
		}

		this.wrapClutter(x, z);

		const shipSpeed = Math.hypot(vx, vz);
		// Perpendicular of the heading is the fallback push when an item sits dead
		// on the centreline — shove it to a side so it goes around, not under.
		const sideX = shipSpeed > 1e-3 ? vz / shipSpeed : 1;
		const sideZ = shipSpeed > 1e-3 ? -vx / shipSpeed : 0;
		for (let i = 0; i < this.clutterNodes.length; i++) {
			const item = this.clutterItems[i];
			if (item.wrapR !== WRAP_NEAR) continue;
			const node = this.clutterNodes[i];
			const dx = node.position.x - x;
			const dz = node.position.z - z;
			const dist = Math.hypot(dx, dz);
			const minSep = HULL_R + item.radius;
			if (dist >= minSep) continue;
			// Outward normal (from the hull centre to the item).
			let nx: number;
			let nz: number;
			if (dist > 1e-3) {
				nx = dx / dist;
				nz = dz / dist;
			} else {
				nx = sideX;
				nz = sideZ;
			}
			// 1. Never inside the hull: seat it exactly on the clearance ring.
			node.position.x = x + nx * minSep;
			node.position.z = z + nz * minSep;
			// 2. Shove it outward (harder the faster we drive) and carry it in the
			//    hull's flow, so it visibly clears the bow and is left astern.
			const push = SHOVE_BASE + shipSpeed * SHOVE_SPEED;
			item.vx = nx * push + vx * SHOVE_CARRY;
			item.vz = nz * push + vz * SHOVE_CARRY;
		}
	}

	/** Bob/tumble the scatter so it reads as floating, not welded to the sea. */
	private animateClutter(dt: number): void {
		this.time += dt;
		const amp = 0.35;
		for (let i = 0; i < this.clutterNodes.length; i++) {
			const item = this.clutterItems[i];
			const node = this.clutterNodes[i];
			if (!node.isEnabled()) continue;
			node.position.y = item.baseY + Math.sin(this.time * 1.3 + item.phase) * amp;
			if (item.tumble !== 0) {
				node.rotation.z = Math.sin(this.time * item.tumble + item.phase) * 0.06;
			}
		}
	}

	private create(id: string): Wake {
		const emitter = new Vector3(0, 0.3, -9999);
		const ps = new ParticleSystem(`wake_${id}`, 300, this.scene);
		ps.particleTexture = this.tex;
		ps.emitter = emitter;
		ps.minEmitBox = new Vector3(-1.5, 0, 0);
		ps.maxEmitBox = new Vector3(1.5, 0, 0);
		ps.color1 = new Color4(0.85, 0.95, 1.0, 0.9);
		ps.color2 = new Color4(0.7, 0.85, 0.95, 0.6);
		ps.colorDead = new Color4(0.9, 0.95, 1.0, 0.0);
		ps.minSize = 1.4;
		ps.maxSize = 3.4;
		ps.minLifeTime = 0.5;
		ps.maxLifeTime = 1.1;
		ps.emitRate = 0;
		ps.blendMode = ParticleSystem.BLENDMODE_ADD;
		ps.gravity = new Vector3(0, -0.6, 0);
		ps.direction1 = new Vector3(-1, 0.6, 0);
		ps.direction2 = new Vector3(1, 0.6, 0);
		ps.minEmitPower = 1.5;
		ps.maxEmitPower = 4;
		ps.updateSpeed = 0.012;
		ps.start();
		return { ps, emitter, bowPs: this.createBowWave(id) };
	}

	/**
	 * Bow wave: water breaking at the STEM, thrown outward and up as the hull
	 * shoulders through it. This is the single most important motion cue for a
	 * boat, and its absence is why a hull with only a stern wake reads as
	 * "being held back" rather than driving forward — a stern trail tells you
	 * where you have BEEN, while a bow wave tells you the hull is actively
	 * shoving water aside right now.
	 */
	private createBowWave(id: string): ParticleSystem {
		const emitter = new Vector3(0, 0.4, -9999);
		const ps = new ParticleSystem(`bow_${id}`, 400, this.scene);
		ps.particleTexture = this.tex;
		ps.emitter = emitter;
		// Wide across the beam so foam peels off both sides of the stem.
		ps.minEmitBox = new Vector3(-2.6, 0, 0);
		ps.maxEmitBox = new Vector3(2.6, 0, 0);
		ps.color1 = new Color4(1.0, 1.0, 1.0, 1.0);
		ps.color2 = new Color4(0.82, 0.92, 1.0, 0.85);
		ps.colorDead = new Color4(0.9, 0.95, 1.0, 0.0);
		// Larger and shorter-lived than the stern foam: it is a splash, not a trail.
		ps.minSize = 1.8;
		ps.maxSize = 4.2;
		ps.minLifeTime = 0.28;
		ps.maxLifeTime = 0.7;
		ps.emitRate = 0;
		ps.blendMode = ParticleSystem.BLENDMODE_ADD;
		ps.gravity = new Vector3(0, -3.2, 0);
		ps.minEmitPower = 2.5;
		ps.maxEmitPower = 6;
		ps.updateSpeed = 0.01;
		ps.start();
		return ps;
	}

	/**
	 * @param pos    hull world position
	 * @param heading bow direction (radians, matches ShipManager rotation.y)
	 * @param speed  horizontal speed magnitude (world units / s)
	 * @param dt     frame delta (s), drives the floating clutter bob
	 */
	update(id: string, pos: Vector3, heading: number, speed: number, dt: number): void {
		let w = this.wakes.get(id);
		if (!w) {
			w = this.create(id);
			this.wakes.set(id, w);
		}
		const bowX = Math.sin(heading);
		const bowZ = Math.cos(heading);
		// stern sits a few units behind the hull centre, at the waterline
		w.emitter.set(pos.x - bowX * 11, 0.3, pos.z - bowZ * 11);
		// foam fans outward + trails backward as the hull moves off it
		w.ps.direction1.set(-bowX - bowZ, 0.6, -bowZ + bowX);
		w.ps.direction2.set(-bowX + bowZ, 0.6, -bowZ - bowX);
		w.ps.emitRate = Math.min(220, Math.max(0, speed * 26));

		// Bow wave, forward of the stem, thrown out to both sides and up.
		const bowEmitter = w.bowPs.emitter as Vector3;
		bowEmitter.set(pos.x + bowX * 9, 0.4, pos.z + bowZ * 9);
		// Perpendicular to the bow, so the spray peels sideways off the hull.
		const sideX = bowZ;
		const sideZ = -bowX;
		w.bowPs.direction1.set(bowX * 0.5 + sideX, 1.1, bowZ * 0.5 + sideZ);
		w.bowPs.direction2.set(bowX * 0.5 - sideX, 1.1, bowZ * 0.5 - sideZ);
		// Needs a bit of way on before she starts throwing water; scales faster
		// than the stern foam so the cue arrives as she gets going.
		w.bowPs.emitRate = Math.min(300, Math.max(0, (speed - 1.5) * 34));

		this.animateClutter(dt);
	}
	remove(id: string): void {
		const w = this.wakes.get(id);
		if (w) {
			w.ps.stop();
			w.ps.dispose();
			w.bowPs.stop();
			w.bowPs.dispose();
			this.wakes.delete(id);
		}
	}

	dispose(): void {
		for (const w of this.wakes.values()) {
			w.ps.stop();
			w.ps.dispose();
			w.bowPs.stop();
			w.bowPs.dispose();
		}
		this.wakes.clear();
		this.clutterRoot?.dispose(false, true);
		this.clutterRoot = null;
		this.clutterNodes = [];
		this.clutterItems = [];
		this.tex.dispose();
	}
}
