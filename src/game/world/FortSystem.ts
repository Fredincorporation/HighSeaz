import {
	Scene,
	TransformNode,
	Vector3,
	StandardMaterial,
	Color3,
	Color4,
	ParticleSystem,
	Texture,
	AssetContainer,
	SceneLoader,
	Node,
	AbstractMesh,
} from "@babylonjs/core";
import "@babylonjs/loaders/glTF"; // side-effect: registers the .glb loader with SceneLoader
import { FORT_DEFS, type FortDef, type FortState, type FortSectionKey } from "@shared/index";
import { asset } from "../core/assets";
import type { Vfx } from "../vfx/VfxLibrary";

/**
 * Client-side projection of the destructible shore forts — the naval-boss arena.
 * The fort is a STATIC landmark: its geometry is a real GLB battery (see
 * FORT_MODELS) built here from the shared FORT_DEFS (so it never needs the
 * distance-culled snapshot to exist), and only its destructibility takes dynamic
 * state from the server (`forts` in every snapshot).
 *
 * The real fort meshes are monolithic citadels, so the four separately-destructible
 * sections no longer map to four sub-meshes. Instead the aggregate intactness of
 * the four sections (northWall/southWall/mortarTower/powderMagazine) drives the
 * WHOLE model collapsing toward the ground — it crouches, sinks and lists as it is
 * battered, and vanishes at zero — while each still-standing section smoulders from
 * its own pinned emitter. Damage priority (walls -> tower -> magazine) lives
 * entirely on the server; this class just paints whatever hp it is told and reacts
 * to the impact / detonation combat events, so client and authoritative state never
 * disagree.
 */

const SECTIONS: FortSectionKey[] = ["northWall", "southWall", "mortarTower", "powderMagazine"];

/** The real fort batteries, in draw order. The measure-then-fit loader scales each
 *  up to `FORT_SIZE` regardless of the authored (normalised ~2-unit) dimensions, so
 *  these read as looming shore works rather than the primitives they replace. One
 *  model per fort index; more forts than models cycle. */
const FORT_MODELS = ["fort1.glb", "fort2.glb", "fort3.glb", "fort4.glb", "fort5.glb", "fort6.glb"];

/** Horizontal footprint (world units) every fort is scaled to. Deliberately far
 *  larger than the aim-cone `radius` so the battery looks like the fortress it is —
 *  "larger than it is supposed to be" — while the server still aims at the true,
 *  much smaller radius. */
const FORT_SIZE = (def: FortDef) => Math.max(220, def.radius * 5);

interface FortTemplate {
	container: AssetContainer;
	roots: Node[];
	scale: number;
	center: Vector3;
	minY: number;
	/** Fitted vertical extent (world units) — the height the smoulder sits at. */
	height: number;
}

interface FortRuntime {
	def: FortDef;
	model: string;
	root: TransformNode;
	/** Outer node carrying the collapse transform (crouch/sink/list) applied to the
	 *  whole battery; the fitted model clones live under its inner `fit` node. */
	body: TransformNode;
	fit: TransformNode;
	size: number;
	/** True once the GLB is loaded and seated. */
	ready: boolean;
	/** Fitted model height, filled on load — used to place the smoulders. */
	height: number;
	/** A persistent smoulder pinned to each section, started only when wounded. */
	smoke: Record<FortSectionKey, ParticleSystem>;
	/** World-space XZ of each smoke emitter (its height re-aims as the fort sinks). */
	smokeAt: Record<FortSectionKey, Vector3>;
	/** Vertical offset of each section's top above the ground, before collapse. */
	smokeExtent: Record<FortSectionKey, number>;
	hp: Record<FortSectionKey, number>;
	defeated: boolean;
}

export class FortSystem {
	private forts: FortRuntime[] = [];
	private smokeTex: Texture;
	private templates = new Map<string, FortTemplate>();
	private loading = new Map<string, Promise<FortTemplate>>();
	/** Tracks which section smoulders are live so we start/stop them on edges,
	 *  not every frame (a ParticleSystem restarts its buffer on repeated start). */
	private running = new Map<ParticleSystem, boolean>();
	/** True once activate() has built the forts; update() no-ops before this. */
	private started = false;

	constructor(private scene: Scene, private vfx: Vfx) {
		this.smokeTex = new Texture(asset("/vfx/smoke_column.png"), scene);
		// The six fort GLBs (2–5 MB each) are not decoded here. Like the islands, the
		// boot constructor runs behind the hidden title canvas; decoding them for a
		// scene nobody sees contributes to the tab OOM (task #70). Deferred to the
		// first join — see activate().
	}

	/** Build + decode the shore forts. Idempotent; called from startPlaying(). */
	activate(): void {
		if (this.started) return;
		this.started = true;
		for (const def of FORT_DEFS) this.forts.push(this.build(def));
	}

	/**
	 * Build one fort: a root at its authoritative coordinates, a body/fit node pair
	 * that the real GLB is seated into, and four smoulder emitters pinned to the
	 * sections. Geometry loads async (see `loadModel`); until then the fort is an
	 * empty transform, and any snapshot state already received is applied on load.
	 */
	private build(def: FortDef): FortRuntime {
		const root = new TransformNode(`fort_${def.id}`, this.scene);
		const yaw = def.id * 0.9;
		root.position.set(def.x, 0, def.z);
		// Face the battery to seaward the same way the harbour island is seated.
		root.rotation.y = yaw;

		const body = new TransformNode(`fortbody_${def.id}`, this.scene);
		body.parent = root;
		const fit = new TransformNode(`fortfit_${def.id}`, this.scene);
		fit.parent = body;

		const size = FORT_SIZE(def);
		const model = FORT_MODELS[def.id % FORT_MODELS.length];

		// The fort is yawed with its harbour; world XZ of a local point rotates about
		// Y so each smoulder emitter sits over the right quarter of the battery.
		const cosY = Math.cos(yaw),
			sinY = Math.sin(yaw);
		const worldXZ = (lx: number, lz: number): [number, number] => [def.x + (lx * cosY + lz * sinY), def.z + (lz * cosY - lx * sinY)];

		// Section smoulder anchors in LOCAL space: the two wall faces front/back, the
		// tower the centre, the magazine a quarter over. Heights are fractions of the
		// fitted model height (unknown until load), so store the fraction and resolve
		// the world Y once `height` is known.
		const smoke = {} as Record<FortSectionKey, ParticleSystem>;
		const smokeAt = {} as Record<FortSectionKey, Vector3>;
		const smokeExtent = {} as Record<FortSectionKey, number>;
		const anchors: Record<FortSectionKey, [number, number, number]> = {
			northWall: [0, size * 0.42, 0.55],
			southWall: [0, -size * 0.42, 0.5],
			mortarTower: [0, 0, 1.0],
			powderMagazine: [size * 0.34, -size * 0.12, 0.4],
		};
		for (const key of SECTIONS) {
			const [lx, lz, frac] = anchors[key];
			const [wx, wz] = worldXZ(lx, lz);
			smokeExtent[key] = frac; // fraction of fitted height; resolved in update()
			smokeAt[key] = new Vector3(wx, 6, wz);
			smoke[key] = this.makeSmoke(smokeAt[key]);
		}

		const rt: FortRuntime = {
			def,
			model,
			root,
			body,
			fit,
			size,
			ready: false,
			height: size * 0.3,
			smoke,
			smokeAt,
			smokeExtent,
			hp: { ...def.max },
			defeated: false,
		};

		this.loadModel(rt);
		return rt;
	}

	/** Load the real GLB once, measure it, and seat it (base at the waterline) under
	 *  this fort's fit node. Scales the model UP to `size` so it looms. */
	private loadModel(f: FortRuntime): void {
		this.loadTemplate(f.model, f.size)
			.then((tpl) => {
				f.fit.scaling.setAll(tpl.scale);
				// Seat the lowest point a few units below y=0 so the rock base meets
				// the shore instead of perching above the sea.
				const SINK = 6;
				f.fit.position.set(-tpl.center.x * tpl.scale, -SINK - tpl.minY * tpl.scale, -tpl.center.z * tpl.scale);
				for (const r of tpl.roots) {
					const clone = (r as unknown as { clone: (n: string) => AbstractMesh | Node | null }).clone(`fortmesh_${f.def.id}_${r.name}`);
					if (!clone) continue;
					clone.parent = f.fit;
					(clone as unknown as { setEnabled?: (v: boolean) => void }).setEnabled?.(true);
					(clone as unknown as { isPickable?: boolean }).isPickable = false;
				}
				f.height = tpl.height;
				f.ready = true;
				// Paint whatever authoritative state has already arrived.
				this.applyCrumble(f);
			})
			.catch(() => {
				// Model missing: leave the (empty) transform so the arena still exists
				// server-side and the smoke/collapse logic keeps running harmlessly.
			});
	}

	/** Measure a GLB once and derive an auto-fit scale + fitted height. */
	private loadTemplate(model: string, target: number): Promise<FortTemplate> {
		const existing = this.loading.get(model);
		if (existing) return existing;

		const promise = SceneLoader.LoadAssetContainerAsync(asset("/models/forts/"), model, this.scene, undefined, ".glb").then(
			(container) => {
				let minX = Infinity,
					minY = Infinity,
					minZ = Infinity;
				let maxX = -Infinity,
					maxY = -Infinity,
					maxZ = -Infinity;
				for (const m of container.meshes) {
					m.computeWorldMatrix(true);
					const bb = m.getBoundingInfo().boundingBox;
					minX = Math.min(minX, bb.minimumWorld.x);
					minY = Math.min(minY, bb.minimumWorld.y);
					minZ = Math.min(minZ, bb.minimumWorld.z);
					maxX = Math.max(maxX, bb.maximumWorld.x);
					maxY = Math.max(maxY, bb.maximumWorld.y);
					maxZ = Math.max(maxZ, bb.maximumWorld.z);
				}
				const dx = maxX - minX,
					dz = maxZ - minZ;
				const horizontal = Math.max(dx, dz) || 1;
				const scale = target / horizontal;
				const center = new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
				const height = (maxY - minY) * scale;
				container.meshes.forEach((m) => m.setEnabled(false));
				const tpl: FortTemplate = { container, roots: container.rootNodes, scale, center, minY, height };
				this.templates.set(model, tpl);
				return tpl;
			}
		);
		this.loading.set(model, promise);
		return promise;
	}

	/** A stopped smoulder emitter pinned to a world point; update() starts it when
	 *  its section is wounded and re-aims it downward as the fort collapses. */
	private makeSmoke(at: Vector3): ParticleSystem {
		const ps = new ParticleSystem(`fortsmoke_${at.x.toFixed(0)}_${at.z.toFixed(0)}`, 240, this.scene);
		ps.particleTexture = this.smokeTex;
		ps.emitter = at;
		ps.minEmitBox = new Vector3(-3, -0.5, -3);
		ps.maxEmitBox = new Vector3(3, 0.5, 3);
		ps.color1 = new Color4(0.4, 0.4, 0.42, 0.35);
		ps.color2 = new Color4(0.24, 0.24, 0.26, 0.28);
		ps.colorDead = new Color4(0.12, 0.12, 0.13, 0);
		ps.minSize = 2.5;
		ps.maxSize = 6;
		ps.minLifeTime = 1.5;
		ps.maxLifeTime = 3.2;
		ps.emitRate = 0;
		ps.direction1 = new Vector3(-0.6, 3, -0.6);
		ps.direction2 = new Vector3(0.6, 5, 0.6);
		ps.minEmitPower = 0.6;
		ps.maxEmitPower = 1.4;
		ps.gravity = new Vector3(0, 0.8, 0);
		ps.blendMode = ParticleSystem.BLENDMODE_STANDARD;
		return ps;
	}

	/** Reconcile every section's hp from the authoritative snapshot. */
	applyStates(states: FortState[]): void {
		for (const st of states) {
			const f = this.forts[st.id];
			if (!f) continue;
			f.defeated = st.defeated;
			for (const key of SECTIONS) f.hp[key] = st.hp[key];
			this.applyCrumble(f);
		}
	}

	/** A hit landed on a section: bleed its local hp for instant feedback (the next
	 *  snapshot reconciles authoritatively) and throw a burst at the impact. */
	impact(fortId: number, section: FortSectionKey, point: { x: number; y: number; z: number }, damage: number): void {
		const f = this.forts[fortId];
		if (!f || f.defeated) return;
		f.hp[section] = Math.max(0, f.hp[section] - damage);
		this.applyCrumble(f);
		this.vfx.stoneImpact(new Vector3(point.x, point.y, point.z));
	}

	/** The magazine went up: the whole fort comes down in one blast. */
	detonate(fortId: number, point: { x: number; y: number; z: number }): void {
		const f = this.forts[fortId];
		if (!f) return;
		f.defeated = true;
		for (const key of SECTIONS) f.hp[key] = 0;
		this.applyCrumble(f);
		this.vfx.fortDetonate(new Vector3(point.x, point.y, point.z));
	}

	/**
	 * Collapse the whole battery toward the ground in proportion to its aggregate
	 * intactness: full-size when pristine, crouched/sunk/listed as it is battered,
	 * and hidden once the magazine has gone up (or everything is at zero). The real
	 * model is a single mesh, so this replaces the old per-section scaling.y crumble.
	 */
	private applyCrumble(f: FortRuntime): void {
		const max = f.def.max;
		const totalMax = max.northWall + max.southWall + max.mortarTower + max.powderMagazine;
		const totalHp = f.hp.northWall + f.hp.southWall + f.hp.mortarTower + f.hp.powderMagazine;
		const ratio = totalMax > 0 ? totalHp / totalMax : 0;
		const dead = f.defeated || totalHp <= 0;
		if (dead) {
			f.body.setEnabled(false);
			return;
		}
		f.body.setEnabled(true);
		if (!f.ready) return; // until the GLB loads there is nothing to crumble
		// Crouch toward the ground (never fully vanish before it is actually dead),
		// sink a little, and list as more of it falls.
		f.body.scaling.set(1, 0.5 + 0.5 * ratio, 1);
		f.body.position.y = -(1 - ratio) * 6;
		f.body.rotation.z = (1 - ratio) * 0.06;
		f.body.rotation.x = (1 - ratio) * 0.04;
	}

	/** Keep wounded (but not yet destroyed) sections smouldering, sinking each
	 *  emitter with the collapsing fort. */
	update(dt: number): void {
		void dt;
		if (!this.started) return;
		for (const f of this.forts) {
			const max = f.def.max;
			const crumble = f.ready ? f.body.scaling.y : 1;
			for (const key of SECTIONS) {
				const sectionMax = max[key];
				const ratio = sectionMax > 0 ? f.hp[key] / sectionMax : 0;
				const ps = f.smoke[key];
				const running = this.running.get(ps) ?? false;
				const wounded = !f.defeated && f.hp[key] > 0 && ratio < 0.7;
				if (wounded) {
					// Re-aim the emitter down the collapsing fort: its top falls with the
					// body's crouch, so the smoke stays glued to the standing height.
					f.smokeAt[key].y = f.height * f.smokeExtent[key] * crumble;
					if (!running) {
						ps.start();
						this.running.set(ps, true);
					}
					ps.emitRate = 6 + Math.round((0.7 - ratio) * 26);
				} else if (running) {
					ps.stop();
					this.running.set(ps, false);
				}
			}
		}
	}

	/** QA handle: the live section hp of the first fort. */
	stats(): { defeated: boolean; hp: Record<FortSectionKey, number> } | null {
		const f = this.forts[0];
		if (!f) return null;
		return { defeated: f.defeated, hp: { ...f.hp } };
	}

	/** DEV: knock down a fraction of a section and smoke it, without a real shot,
	 *  so the crumble + smoulder look can be eyeballed on demand. */
	debugWound(fortId = 0, section: FortSectionKey = "northWall", amount = 80): void {
		const f = this.forts[fortId];
		if (!f || f.defeated) return;
		this.impact(fortId, section, { x: f.def.x, y: 6, z: f.def.z }, amount);
	}

	/** DEV: detonate the magazine outright (the whole fort comes down). */
	debugDetonate(fortId = 0): void {
		const f = this.forts[fortId];
		if (!f) return;
		this.detonate(fortId, { x: f.def.x, y: 4, z: f.def.z });
	}

	dispose(): void {
		for (const f of this.forts) {
			for (const key of SECTIONS) f.smoke[key].dispose();
			f.root.dispose(false, true);
		}
		this.forts = [];
		this.smokeTex.dispose();
		for (const tpl of this.templates.values()) tpl.container.dispose();
		this.templates.clear();
		this.loading.clear();
	}
}
