import {
	Scene,
	Vector3,
	Color3,
	Color4,
	MeshBuilder,
	StandardMaterial,
	Texture,
	ParticleSystem,
	Mesh,
	PointLight,
	DynamicTexture,
	TransformNode,
	Quaternion,
	Matrix,
} from "@babylonjs/core";

/**
 * Registry of the additive billboard/particle textures in `public/vfx/`
 * (rendered on pure black, so black == transparent under ADDITIVE blending).
 * The combat + weather builds create the Babylon ParticleSystems that consume
 * these; here we centralise the paths + recommended blend mode so effects stay
 * consistent and are referenced by name, not string literals.
 */
export type VfxKey =
	| "muzzleFlash"
	| "cannonSmoke"
	| "fire"
	| "explosion"
	| "smokeColumn"
	| "woodSplinters"
	| "debris"
	| "bubbles"
	| "waterImpact"
	| "hullImpact";

export interface VfxDef {
	texturePath: string;
	/** Additive for glow/fire/sparks; standard for smoke/debris/bubbles. */
	blend: "additive" | "standard";
}

const BASE = "/vfx";

/** Hulls recycle their oldest scorch mark past this many, so a long duel against
 *  one target can't accumulate unbounded child quads. Small on purpose. */
const HULL_DECAL_CAP = 12;

export const VFX: Record<VfxKey, VfxDef> = {
	muzzleFlash: { texturePath: `${BASE}/muzzle_flash.png`, blend: "additive" },
	cannonSmoke: { texturePath: `${BASE}/cannon_smoke.png`, blend: "standard" },
	fire: { texturePath: `${BASE}/fire.png`, blend: "additive" },
	explosion: { texturePath: `${BASE}/explosion.png`, blend: "additive" },
	smokeColumn: { texturePath: `${BASE}/smoke_column.png`, blend: "standard" },
	woodSplinters: { texturePath: `${BASE}/wood_splinters.png`, blend: "standard" },
	debris: { texturePath: `${BASE}/debris.png`, blend: "standard" },
	bubbles: { texturePath: `${BASE}/bubbles.png`, blend: "additive" },
	waterImpact: { texturePath: `${BASE}/water_impact.png`, blend: "additive" },
	hullImpact: { texturePath: `${BASE}/hull_impact.png`, blend: "additive" },
};

/**
 * Runtime effect spawner. Combat events and the sinking pipeline call into this;
 * it builds short-lived, self-disposing particle bursts (one-shot via
 * `manualEmitCount` + `targetStopDuration`) so a broadside reads as a chain of
 * muzzle flash -> flying shell -> hull splinter/boom -> (on the kill) a burning
 * wreck. Textures are cached; a concurrency cap stops a sustained firefight
 * from allocating unbounded particle systems and spiking the frame.
 */
export class Vfx {
	private scene: Scene;
	private texCache = new Map<string, Texture | null>();
	private ballGeo: Mesh;
	private ballMat: StandardMaterial;
	private activeBursts = 0;
	/** Black-powder smoke trail following each flying shell, keyed by its mesh. */
	private shellTrails = new Map<Mesh, ParticleSystem>();
	/** One reusable muzzle flash light: a broadside briefly lights the deck + sea. */
	private muzzleLight: PointLight;
	// --- Hull-impact decals (task #141) ------------------------------------
	// The ship is a GPU-only GLB with no CPU vertex buffer, so a real projected
	// surface decal is impossible. Instead a confirmed hull hit stamps a small dark
	// scorch quad as a CHILD of the victim hull's own root — so it rides the hull's
	// roll/pitch/sink for free and disposes with it. One shared procedural blot
	// texture + material keep this cheap; a per-hull cap bounds a long firefight.
	private decalGeo: Mesh | null = null;
	private decalMat: StandardMaterial | null = null;
	private decalTex: DynamicTexture | null = null;
	/** Monotonic id so we can drop the OLDEST decal on a hull once it is full. */
	private decalSeq = 0;

	constructor(scene: Scene) {
		this.scene = scene;

		// One shared, low-poly shell mesh geometry cloned per shot; a single dark
		// iron material for every cannonball keeps them cheap.
		this.ballGeo = MeshBuilder.CreateSphere("shellGeo", { diameter: 0.7, segments: 8 }, scene);
		this.ballGeo.setEnabled(false);
		this.ballMat = new StandardMaterial("shellMat", scene);
		this.ballMat.diffuseColor = new Color3(0.05, 0.05, 0.06);
		this.ballMat.specularColor = new Color3(0.25, 0.25, 0.28);
		this.ballMat.disableLighting = false;

		// A single warm point light parked far below the world when idle; muzzle()
		// teleports it to the gun and `tick` decays it, so the flash is free.
		this.muzzleLight = new PointLight("muzzleLight", new Vector3(0, -9999, 0), scene);
		this.muzzleLight.diffuse = new Color3(1.0, 0.72, 0.36);
		this.muzzleLight.specular = new Color3(1.0, 0.82, 0.5);
		this.muzzleLight.intensity = 0;
		this.muzzleLight.range = 60;
	}

	private tex(key: VfxKey): Texture | null {
		const def = VFX[key];
		const cached = this.texCache.get(def.texturePath);
		if (cached !== undefined) return cached;
		let t: Texture | null = null;
		try {
			t = new Texture(def.texturePath, this.scene, true, false);
		} catch {
			t = null;
		}
		this.texCache.set(def.texturePath, t);
		return t;
	}

	/**
	 * Build a one-shot particle burst. `count` particles emit over `life` seconds
	 * from a point, fan out within the given speed range, and the whole system
	 * disposes itself when it finishes — nothing to clean up at the call site.
	 */
	private burst(opts: {
		key: VfxKey;
		at: Vector3;
		count: number;
		capacity?: number;
		minSize: number;
		maxSize: number;
		minLife: number;
		maxLife: number;
		speed: number;
		upBias?: number;
		color1: Color4;
		color2: Color4;
		colorDead: Color4;
		gravity?: Vector3;
	}): void {
		if (this.activeBursts > 120) return; // hard budget: skip rather than tank fps
		const def = VFX[opts.key];
		const ps = new ParticleSystem(`${opts.key}_${Math.random()}`, opts.capacity ?? opts.count, this.scene);
		const t = this.tex(opts.key);
		if (t) ps.particleTexture = t;
		ps.emitter = opts.at.clone();
		const box = 0.6;
		ps.minEmitBox = new Vector3(-box, -box * 0.5, -box);
		ps.maxEmitBox = new Vector3(box, box * 0.5, box);
		ps.color1 = opts.color1;
		ps.color2 = opts.color2;
		ps.colorDead = opts.colorDead;
		ps.minSize = opts.minSize;
		ps.maxSize = opts.maxSize;
		ps.minLifeTime = opts.minLife;
		ps.maxLifeTime = opts.maxLife;
		ps.emitRate = 0;
		const dir = new Vector3(0, opts.upBias ?? 0, 0);
		const spread = opts.speed;
		ps.direction1 = new Vector3(dir.x - spread, dir.y - spread, dir.z - spread);
		ps.direction2 = new Vector3(dir.x + spread, dir.y + spread, dir.z + spread);
		ps.minAngularSpeed = -2;
		ps.maxAngularSpeed = 2;
		ps.minEmitPower = opts.speed * 0.6;
		ps.maxEmitPower = opts.speed;
		ps.gravity = opts.gravity ?? new Vector3(0, -9.8, 0);
		ps.blendMode =
			def.blend === "additive" ? ParticleSystem.BLENDMODE_ADD : ParticleSystem.BLENDMODE_STANDARD;
		ps.targetStopDuration = opts.maxLife + 0.1;
		ps.disposeOnStop = true;
		ps.manualEmitCount = opts.count;
		this.activeBursts++;
		ps.onStoppedObservable.addOnce(() => {
			this.activeBursts = Math.max(0, this.activeBursts - 1);
		});
		ps.start();
	}

	muzzle(at: Vector3, headingDir: Vector3): void {
		// Kick the shared flash light at the gun; `tick` fades it within ~1/15s.
		this.muzzleLight.position.copyFrom(at);
		this.muzzleLight.range = 60;
		this.muzzleLight.intensity = Math.max(this.muzzleLight.intensity, 26);
		// Bright flash pushed along the firing direction + a lingering smoke puff.
		this.burst({
			key: "muzzleFlash",
			at,
			count: 12,
			minSize: 1.5,
			maxSize: 3.5,
			minLife: 0.08,
			maxLife: 0.2,
			speed: 3,
			upBias: 0.4,
			color1: new Color4(1, 0.85, 0.5, 1),
			color2: new Color4(1, 0.6, 0.2, 1),
			colorDead: new Color4(0.3, 0.1, 0, 0),
			gravity: new Vector3(headingDir.x * 8, 2, headingDir.z * 8),
		});
		this.burst({
			key: "cannonSmoke",
			at,
			count: 16,
			minSize: 2,
			maxSize: 5,
			minLife: 0.6,
			maxLife: 1.4,
			speed: 1.4,
			upBias: 0.5,
			color1: new Color4(0.6, 0.6, 0.62, 0.5),
			color2: new Color4(0.4, 0.4, 0.42, 0.4),
			colorDead: new Color4(0.2, 0.2, 0.22, 0),
			gravity: new Vector3(0, 1.2, 0),
		});
	}

	hullImpact(at: Vector3): void {
		this.burst({
			key: "hullImpact",
			at,
			count: 12,
			minSize: 1.4,
			maxSize: 3,
			minLife: 0.12,
			maxLife: 0.32,
			speed: 5,
			upBias: 0.6,
			color1: new Color4(1, 0.75, 0.35, 1),
			color2: new Color4(1, 0.4, 0.1, 1),
			colorDead: new Color4(0.4, 0.1, 0, 0),
			gravity: new Vector3(0, -6, 0),
		});
		this.burst({
			key: "woodSplinters",
			at,
			count: 24,
			minSize: 0.4,
			maxSize: 1.2,
			minLife: 0.5,
			maxLife: 1.3,
			speed: 8,
			upBias: 1.2,
			color1: new Color4(0.5, 0.38, 0.24, 1),
			color2: new Color4(0.35, 0.26, 0.16, 1),
			colorDead: new Color4(0.2, 0.14, 0.08, 0),
			gravity: new Vector3(0, -14, 0),
		});
		// The round takes: a brief fireball at the breach and a smoke plume that
		// climbs off the wounded hull, so a hit reads as damage you can see land.
		this.burst({
			key: "fire",
			at,
			count: 16,
			capacity: 30,
			minSize: 1.2,
			maxSize: 2.6,
			minLife: 0.4,
			maxLife: 0.9,
			speed: 2,
			upBias: 1.6,
			color1: new Color4(1, 0.62, 0.2, 0.9),
			color2: new Color4(0.95, 0.32, 0.06, 0.8),
			colorDead: new Color4(0.3, 0.08, 0, 0),
			gravity: new Vector3(0, 1.2, 0),
		});
		this.burst({
			key: "smokeColumn",
			at,
			count: 14,
			capacity: 30,
			minSize: 2.5,
			maxSize: 5.5,
			minLife: 1.4,
			maxLife: 3,
			speed: 1.2,
			upBias: 2.2,
			color1: new Color4(0.28, 0.28, 0.3, 0.5),
			color2: new Color4(0.16, 0.16, 0.18, 0.4),
			colorDead: new Color4(0.1, 0.1, 0.12, 0),
			gravity: new Vector3(0, 1.4, 0),
		});
	}

	waterImpact(at: Vector3): void {
		// Kept BELOW the bloom threshold (0.75) on purpose: the additive water
		// texture is rendered on black, so near-white particles were catching the
		// bloom pass and reading as a glowing explosion at the waterline. Dimmer,
		// smaller and lower-biased, it becomes a splash crown instead.
		this.burst({
			key: "waterImpact",
			at,
			count: 12,
			minSize: 0.8,
			maxSize: 2.4,
			minLife: 0.25,
			maxLife: 0.7,
			speed: 4.5,
			upBias: 1.1,
			color1: new Color4(0.5, 0.66, 0.78, 0.5),
			color2: new Color4(0.34, 0.5, 0.62, 0.36),
			colorDead: new Color4(0.22, 0.34, 0.42, 0),
			gravity: new Vector3(0, -16, 0),
		});
	}

	/**
	 * A round bursting against masonry: a grey stone-dust plume, a fan of rubble,
	 * and a short spark flash at the breach. Distinct from `hullImpact` (which is
	 * wood + fire) so a broadside cracking a fort wall reads as STONE, not timber.
	 */
	stoneImpact(at: Vector3): void {
		this.burst({
			key: "hullImpact",
			at,
			count: 10,
			minSize: 1.2,
			maxSize: 2.6,
			minLife: 0.1,
			maxLife: 0.28,
			speed: 5,
			upBias: 0.8,
			color1: new Color4(0.85, 0.85, 0.82, 1),
			color2: new Color4(0.6, 0.6, 0.58, 1),
			colorDead: new Color4(0.3, 0.3, 0.3, 0),
			gravity: new Vector3(0, -8, 0),
		});
		this.burst({
			key: "debris",
			at,
			count: 22,
			minSize: 0.5,
			maxSize: 1.5,
			minLife: 0.7,
			maxLife: 1.8,
			speed: 9,
			upBias: 1.6,
			color1: new Color4(0.6, 0.6, 0.58, 1),
			color2: new Color4(0.42, 0.42, 0.4, 1),
			colorDead: new Color4(0.22, 0.22, 0.2, 0),
			gravity: new Vector3(0, -15, 0),
		});
		this.burst({
			key: "smokeColumn",
			at,
			count: 12,
			capacity: 30,
			minSize: 3,
			maxSize: 6.5,
			minLife: 1.2,
			maxLife: 2.8,
			speed: 1.4,
			upBias: 2.2,
			color1: new Color4(0.55, 0.54, 0.5, 0.45),
			color2: new Color4(0.35, 0.34, 0.32, 0.35),
			colorDead: new Color4(0.2, 0.2, 0.2, 0),
			gravity: new Vector3(0, 1.6, 0),
		});
	}

	/**
	 * A powder magazine going up — the fort's finisher. A far larger fireball,
	 * shockwave of smoke, and a heavy debris field than a ship's sink, so the
	 * kill reads as a demolished landmark, not just another hull lost.
	 */
	fortDetonate(at: Vector3): void {
		this.burst({
			key: "explosion",
			at,
			count: 40,
			capacity: 70,
			minSize: 7,
			maxSize: 16,
			minLife: 0.35,
			maxLife: 0.9,
			speed: 9,
			upBias: 3,
			color1: new Color4(1, 0.78, 0.32, 1),
			color2: new Color4(1, 0.36, 0.06, 1),
			colorDead: new Color4(0.5, 0.1, 0, 0),
			gravity: new Vector3(0, -3, 0),
		});
		this.burst({
			key: "smokeColumn",
			at,
			count: 55,
			capacity: 90,
			minSize: 9,
			maxSize: 20,
			minLife: 3,
			maxLife: 6,
			speed: 3.2,
			upBias: 5,
			color1: new Color4(0.26, 0.26, 0.28, 0.62),
			color2: new Color4(0.14, 0.14, 0.16, 0.5),
			colorDead: new Color4(0.08, 0.08, 0.1, 0),
			gravity: new Vector3(0, 1.6, 0),
		});
		this.burst({
			key: "debris",
			at,
			count: 40,
			capacity: 60,
			minSize: 0.7,
			maxSize: 2,
			minLife: 1.2,
			maxLife: 2.6,
			speed: 14,
			upBias: 3,
			color1: new Color4(0.55, 0.5, 0.42, 1),
			color2: new Color4(0.36, 0.32, 0.26, 1),
			colorDead: new Color4(0.18, 0.15, 0.11, 0),
			gravity: new Vector3(0, -14, 0),
		});
		// A brief, huge flash at the epicentre: the shared muzzle light, boosted.
		this.muzzleLight.position.copyFrom(at);
		this.muzzleLight.intensity = 90;
		this.muzzleLight.range = 260;
	}

	sink(at: Vector3): void {
		this.burst({
			key: "explosion",
			at,
			count: 22,
			capacity: 40,
			minSize: 4,
			maxSize: 9,
			minLife: 0.25,
			maxLife: 0.7,
			speed: 6,
			upBias: 2,
			color1: new Color4(1, 0.7, 0.25, 1),
			color2: new Color4(1, 0.35, 0.05, 1),
			colorDead: new Color4(0.5, 0.1, 0, 0),
			gravity: new Vector3(0, -4, 0),
		});
		this.burst({
			key: "smokeColumn",
			at,
			count: 30,
			capacity: 60,
			minSize: 6,
			maxSize: 14,
			minLife: 2.5,
			maxLife: 5,
			speed: 2.5,
			upBias: 4,
			color1: new Color4(0.25, 0.25, 0.27, 0.6),
			color2: new Color4(0.15, 0.15, 0.17, 0.5),
			colorDead: new Color4(0.1, 0.1, 0.12, 0),
			gravity: new Vector3(0, 1.5, 0),
		});
		this.burst({
			key: "debris",
			at,
			count: 20,
			minSize: 0.6,
			maxSize: 1.6,
			minLife: 1,
			maxLife: 2.2,
			speed: 8,
			upBias: 2,
			color1: new Color4(0.4, 0.3, 0.2, 1),
			color2: new Color4(0.25, 0.2, 0.14, 1),
			colorDead: new Color4(0.15, 0.12, 0.08, 0),
			gravity: new Vector3(0, -13, 0),
		});
	}

	/**
	 * Create the physical shell mesh for a shot. The CombatSystem owns its
	 * lifetime and animates it along the arc, then calls `releaseShell`.
	 * A thin black-powder trail is pinned to the mesh so the ball draws a visible
	 * smoke line across the sky — the cue that sells a heavy, slow cannon shot.
	 */
	spawnShell(at: Vector3): Mesh {
		const m = this.ballGeo.clone("shell");
		m.material = this.ballMat;
		m.position.copyFrom(at);
		m.setEnabled(true);

		const tex = this.tex("cannonSmoke");
		const trail = new ParticleSystem("shellTrail", 60, this.scene);
		if (tex) trail.particleTexture = tex;
		trail.emitter = m;
		trail.minEmitBox = new Vector3(-0.15, -0.15, -0.15);
		trail.maxEmitBox = new Vector3(0.15, 0.15, 0.15);
		trail.color1 = new Color4(0.55, 0.55, 0.58, 0.32);
		trail.color2 = new Color4(0.4, 0.4, 0.43, 0.24);
		trail.colorDead = new Color4(0.25, 0.25, 0.28, 0);
		trail.minSize = 0.5;
		trail.maxSize = 1.6;
		trail.minLifeTime = 0.4;
		trail.maxLifeTime = 1.0;
		trail.emitRate = 70;
		trail.direction1 = new Vector3(-0.2, 0.1, -0.2);
		trail.direction2 = new Vector3(0.2, 0.4, 0.2);
		trail.minEmitPower = 0.1;
		trail.maxEmitPower = 0.4;
		trail.gravity = new Vector3(0, 0.4, 0);
		trail.blendMode = ParticleSystem.BLENDMODE_STANDARD;
		trail.start();
		this.shellTrails.set(m, trail);
		return m;
	}

	releaseShell(mesh: Mesh): void {
		const trail = this.shellTrails.get(mesh);
		if (trail) {
			// Stop emitting but let the trail linger and fade out on its own.
			trail.emitRate = 0;
			trail.targetStopDuration = 1.2;
			trail.disposeOnStop = true;
			this.shellTrails.delete(mesh);
		}
		mesh.dispose();
	}

	/**
	 * Build the shared decal blot once: a 128px canvas whose RED channel encodes
	 * the scorch strength (a soft radial core with a splattered rim), fed to the
	 * material as an `opacityTexture` so black-painted pixels are fully opaque and
	 * the surroundings dissolve to nothing. Drawn opaque (alpha 255) throughout so
	 * Babylon reads red as the opacity value; the blot's colour comes from the
	 * material's dark emissive tint, not the canvas.
	 */
	private ensureDecalAssets(): void {
		if (this.decalGeo && this.decalMat) return;

		const dt = new DynamicTexture("hullDecalTex", { width: 128, height: 128 }, this.scene, false);
		const ctx = dt.getContext();
		const S = 128;
		const cx = S / 2;
		const cy = S / 2;
		// Base: opacity 0 everywhere (red channel 0), fully opaque canvas so red is
		// the only channel the opacity sampler reads.
		ctx.fillStyle = "rgba(0,0,0,255)";
		ctx.fillRect(0, 0, S, S);
		// Core scorch: strongest at the impact centre, feathering to nothing.
		const g = ctx.createRadialGradient(cx, cy, S * 0.03, cx, cy, S * 0.42);
		g.addColorStop(0, "rgba(255,60,0,255)");
		g.addColorStop(0.5, "rgba(180,40,0,255)");
		g.addColorStop(1, "rgba(0,0,0,255)");
		ctx.fillStyle = g;
		ctx.beginPath();
		ctx.arc(cx, cy, S * 0.42, 0, Math.PI * 2);
		ctx.fill();
		// Irregular splatter rim so the breach edge reads burnt, not geometric.
		for (let i = 0; i < 26; i++) {
			const a = Math.random() * Math.PI * 2;
			const r = S * (0.28 + Math.random() * 0.16);
			const px = cx + Math.cos(a) * r;
			const py = cy + Math.sin(a) * r;
			const rad = 2 + Math.random() * 6;
			const sg = ctx.createRadialGradient(px, py, 0, px, py, rad);
			sg.addColorStop(0, "rgba(140,30,0,255)");
			sg.addColorStop(1, "rgba(0,0,0,0)");
			ctx.fillStyle = sg;
			ctx.beginPath();
			ctx.arc(px, py, rad, 0, Math.PI * 2);
			ctx.fill();
		}
		dt.update();
		dt.hasAlpha = false;

		this.decalMat = new StandardMaterial("hullDecalMat", this.scene);
		this.decalMat.disableLighting = true;
		this.decalMat.emissiveColor = new Color3(0.05, 0.042, 0.036);
		this.decalMat.diffuseColor = new Color3(0, 0, 0);
		this.decalMat.specularColor = new Color3(0, 0, 0);
		this.decalMat.opacityTexture = dt;
		// Hull normals curve away, so the quad can catch a grazing angle and vanish;
		// disabling back-face culling keeps the mark visible from either side.
		this.decalMat.backFaceCulling = false;

		this.decalGeo = MeshBuilder.CreatePlane("hullDecalGeo", { size: 1 }, this.scene);
		this.decalGeo.setEnabled(false);

		this.decalTex = dt;
	}

	/**
	 * Stamp a scorch/hole decal on a hull where a shell struck. `worldPoint` is the
	 * impact in world space; it is transformed into the hull's LOCAL space (so the
	 * mark survives the ship's own roll/pitch/sink) and a small plane is parented to
	 * `hullRoot` with its normal facing outward. Caps at `HULL_DECAL_CAP` marks per
	 * hull, dropping the oldest, and the marks are disposed automatically when the
	 * hull root is disposed.
	 */
	spawnHullDecal(hullRoot: TransformNode, worldPoint: Vector3): void {
		this.ensureDecalAssets();
		const geo = this.decalGeo;
		const mat = this.decalMat;
		if (!geo || !mat) return;

		// Enforce the per-hull cap: recycle the oldest marked child first.
		hullRoot.computeWorldMatrix(true);
		const kids = hullRoot.getChildMeshes(false);
		const marked = kids.filter((m) => (m.metadata as { hullDecal?: number } | null)?.hullDecal !== undefined);
		if (marked.length >= HULL_DECAL_CAP) {
			marked.sort(
				(a, b) =>
					((a.metadata as { hullDecal: number }).hullDecal ?? 0) -
					((b.metadata as { hullDecal: number }).hullDecal ?? 0)
			);
			marked[0].dispose();
		}

		// World -> local (parent transform includes the hull's live rotation, so the
		// stored position rides the ship exactly).
		const inv = Matrix.Invert(hullRoot.getWorldMatrix());
		const local = Vector3.TransformCoordinates(worldPoint, inv);

		// Outward normal ≈ from hull centre to the impact, flattened in local space.
		let nx = local.x;
		let ny = local.y;
		let nz = local.z;
		let len = Math.hypot(nx, ny, nz);
		if (len < 0.001) {
			// Degenerate (dead-centre) hit: fall back to amidships so the mark faces
			// somewhere sensible rather than vanishing.
			nx = 0;
			ny = 0.6;
			nz = 0.8;
			len = Math.hypot(nx, ny, nz);
		}
		const outward = new Vector3(nx / len, ny / len, nz / len);

		const quad = geo.clone(`hullDecal_${this.decalSeq}`);
		quad.material = mat;
		quad.parent = hullRoot;
		quad.setEnabled(true);

		// Seat slightly OUT of the surface to dodge z-fighting with the hull mesh.
		const seat = 0.22;
		quad.position.set(local.x + outward.x * seat, local.y + outward.y * seat, local.z + outward.z * seat);

		// A plane's geometric normal is local +Z; rotate that onto the outward vector
		// so the scorch faces off the hull, then roll it randomly about that normal
		// (cheap variety so repeat hits never look stamped).
		const q = new Quaternion();
		Quaternion.FromUnitVectorsToRef(Vector3.Forward(), outward, q);
		const roll = Quaternion.RotationAxis(outward, Math.random() * Math.PI * 2);
		quad.rotationQuaternion = roll.multiply(q);

		const size = 1.1 + Math.random() * 1.3;
		quad.scaling.set(size, size, 1);
		quad.visibility = 0.7 + Math.random() * 0.3;
		quad.isPickable = false;
		quad.metadata = { hullDecal: this.decalSeq++ };
	}

	/** Per-frame decay of the muzzle flash light. Called from CombatSystem.update. */
	tick(dt: number): void {
		if (this.muzzleLight.intensity > 0) {
			this.muzzleLight.intensity *= Math.exp(-dt / 0.07);
			if (this.muzzleLight.intensity < 0.2) this.muzzleLight.intensity = 0;
		}
	}

	dispose(): void {
		this.muzzleLight.dispose();
		for (const trail of this.shellTrails.values()) trail.dispose();
		this.shellTrails.clear();
		for (const t of this.texCache.values()) t?.dispose();
		this.texCache.clear();
		this.ballGeo.dispose();
		this.ballMat.dispose();
		// Decal child quads ride their hull roots (disposed with each ship), but the
		// shared geometry/material/texture are ours to release here.
		this.decalGeo?.dispose();
		this.decalMat?.dispose();
		this.decalTex?.dispose();
	}
}
