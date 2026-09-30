import { AssetContainer, Scene, TransformNode, Vector3, SceneLoader, Node, AbstractMesh, ParticleSystem, Texture, Color4, MeshBuilder, StandardMaterial, Color3, Mesh } from "@babylonjs/core";
import "@babylonjs/loaders/glTF"; // side-effect: registers the .glb loader with SceneLoader
import { PORT_DEFS, REEF_DEFS, FORT_DEFS, type PortDef } from "@shared/index";
import { asset } from "../core/assets";

/**
 * FIXED, seeded island + shoreline scenery — the answer to "there is nothing
 * but water". Unlike the near-field floating clutter (which wraps around the
 * hull to sell speed), these are true world landmarks at stable coordinates:
 * sail toward one and it grows and you arrive at it, which is what makes the
 * horizon read as a place rather than a screensaver.
 *
 * Layout is a pure function of a constant seed, so every client (and every
 * reload) agrees on where each island is without the server replicating any of
 * it. Models are loaded once, measured, auto-scaled to a target footprint, and
 * seated on the waterline by their bounding box (the same measure-then-fit
 * trick ShipModels uses for hulls).
 */

// A single deterministic PRNG (mulberry32) drives every placement decision so
// the scatter is reproducible across clients from one integer seed.
function mulberry32(seed: number): () => number {
	let a = seed >>> 0;
	return () => {
		a |= 0;
		a = (a + 0x6d2b79f5) | 0;
		let t = Math.imul(a ^ (a >>> 15), 1 | a);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}

const WORLD_SEED = 0x1a2b3c;

/** Target horizontal footprint (world units) per island model. Tuned UP (task
 *  #128) so the horizon reads as substantial landmasses rather than islets —
 *  scaling a clone costs no extra vertices, so this is memory-safe. */
const ISLAND_TARGET: Record<string, number> = {
	"Jungle Island.glb": 230,
	"Volcanic Island.glb": 290,
	"Tropical Pirate Island.glb": 210,
	"Fortified Island.glb": 200,
};
const ISLAND_MODELS = Object.keys(ISLAND_TARGET);

/** Which island GLB stands in for each faction's named harbour, and how large
 *  to build it (bigger than the wild scatter so it reads as THE port). */
const PORT_ISLAND: Record<PortDef["faction"], { model: string; target: number }> = {
	pirate: { model: "Tropical Pirate Island.glb", target: 260 },
	naval: { model: "Fortified Island.glb", target: 280 },
	merchant: { model: "Jungle Island.glb", target: 250 },
};
/** The merchantman moored off each harbour — the visible "shop / trading post". */
const PORT_SHIP: { model: string; target: number } = { model: "Merchant Ship.glb", target: 60 };
/** Moored merchant hulls that ring each harbour to form the trading hub a fresh
 *  captain starts docked among. `ang` offsets from the harbour yaw, `rad` is a
 *  multiple of the island footprint so every hull sits just off the beach in
 *  open water. All share the one PORT_SHIP template (loaded once, instanced),
 *  so a full hub costs almost nothing beyond the first merchant load. */
const PORT_HUB_SHIPS = [
	{ ang: Math.PI * 0.5, rad: 1.6 },
	{ ang: Math.PI * 0.85, rad: 1.9 },
	{ ang: Math.PI * 0.2, rad: 1.95 },
	{ ang: -Math.PI * 0.15, rad: 1.7 },
];

/** Foliage species and the target height we scale each to. */
const FOLIAGE: Record<string, number> = {
	"palm tree.glb": 13,
	"twisted coastal tree.glb": 10,
	"tropical bush.glb": 4,
	"fern.glb": 2.6,
	"reeds.glb": 2.4,
};
const FOLIAGE_KEYS = Object.keys(FOLIAGE);
/** Tall canopy species — the green mass that reads as forest from the sea. */
const CANOPY_KEYS = ["palm tree.glb", "twisted coastal tree.glb"];
/** Low species used as undergrowth scattered around each canopy core. */
const UNDERSTORY_KEYS = ["tropical bush.glb", "fern.glb", "reeds.glb"];

// DENSITY BUDGET. These models are very high-poly (150-200K verts each), so the
// old "densify" values (60 islands x 9 foliage) blew the renderer's memory limit
// and Chrome tab-crashed the whole game ("Aw, Snap: Out of Memory"). The horizon
// goal is met far below that: enough land that you always see something, kept
// cheap by instancing (below). Tune these DOWN first if memory ever regresses.
//
// The total landmass count is held at the SAME ~30+4 the OOM budget was signed
// off on: raising ISLAND_COUNT would regress #70, so making the sea feel fuller
// comes from bigger footprints + a tighter radius + satellite isles that REPLACE
// scatter (they count toward ISLAND_COUNT), not add to it.
const ISLAND_COUNT = 30; // wild scatter + harbour satellites + near ring (all cap here)
const ISLAND_R_MIN = 190;
const ISLAND_R_MAX = 1850; // pulled in from 2750 so mid-ocean always has land on view
/** Inner ring of guaranteed isles around the world centre — covers any captain
 *  who sails into open water away from the harbours. Counts toward ISLAND_COUNT. */
const NEAR_RING = 16;
const MIN_ISLAND_SPACING = 320;
/** Keep the seeded scatter + near ring clear of a named port's own island so the
 *  four trading harbours read as distinct landmarks, not one merged landmass. */
const PORT_CLEAR_RADIUS = 520;
/** And clear of a shore fort's battery so the (large) fort model never has an
 *  island growing through it — assets must not pass through each other. */
const FORT_CLEAR_RADIUS = 460;
/**
 * HARBOUR RING (task #128) — the "island you can see from the dock" fix. A fresh
 * captain spawns MOORED at a merchant port (world.nextPlayerSpawn: on a 128-unit
 * circle, `heading` pointing straight OUT from the harbour centre) and faces open
 * sea, so the harbour itself sits behind them and the start read as empty water.
 * Rather than pin satellites at fixed angles that only align with one particular
 * spawn heading, we ring EVERY dockable (merchant) port with an even spread of
 * large isles. Whatever outward heading the player spawns on, the ring guarantees
 * an island within ~30° straight ahead and close (~360 units — well inside view).
 * They sit inside PORT_CLEAR_RADIUS by design and so skip the scatter's keep-out
 * test; pushed into `centres` before the rest, the no-overlap guard below still
 * keeps the wild scatter and the near ring off their beaches, and they consume
 * budget from ISLAND_COUNT (the scatter refills only what's left), so they cost no
 * net landmass. Only merchant harbours get them, since those are the only docks.
 */
const HARBOUR_RING_COUNT = 6;
/** Alternating ring radii (a multiple of the merchant harbour footprint ~125, so
 *  they hug the approach without touching the hub ships moored at ~1.6–2× it). */
const HARBOUR_RING_RADII = [360, 470];
/** Big wild-island models cycled around each harbour ring (shared templates, so
 *  instancing keeps the whole ring memory-cheap). */
const HARBOUR_RING_MODELS = ["Volcanic Island.glb", "Tropical Pirate Island.glb", "Jungle Island.glb"];
/** FOREST DENSITY — the AC-Black-Flag "green island" lever. The old code sprinkled
 *  6 props on the shoreline band only, so isles read as bare rock. Now each island
 *  gets `THICKETS_PER_ISLAND` clustered patches spread across the INTERIOR, each a
 *  canopy tree ringed by undergrowth. Foliage are tiny GLBs cloned from a shared
 *  template (geometry is shared, only a transform is added per clone), so raising
 *  these two numbers is cheap on memory — the thing that OOM'd before was the
 *  count of 150-200K-vert ISLAND meshes, not props. Tune DOWN here first if the
 *  tab ever memory-crashes again. */
const THICKETS_PER_ISLAND = 5;
const PROPS_PER_THICKET = 4;
/** Radius band (fraction of footprint) where thickets sit — pulled inward from
 *  the old 0.62-0.90 shoreline ring so the island's middle fills with green. */
const FOREST_R_MIN = 0.28;
const FOREST_R_MAX = 0.82;

/** ROCKS — generated procedurally (see buildRocks) and placed as GPU instances,
 *  so a hundred boulders cost a handful of shared geometries, not a downloaded
 *  asset. None of the island GLBs bake in believable stone, so this is what puts
 *  cliffs, boulder fields and offshore sea-stacks on the coast. Counts are
 *  instanced-cheap; the memory knob is geometry VARIANTS × their tessellation. */
const ROCK_BOULDERS_PER_ISLAND = 7; // ring of stone at the beach/waterline
const ROCK_OUTCROP_EVERY = 3; // some islands get a big coastal cliff mass
const SEA_STACK_EVERY = 4; // some islands get dramatic spires in the water
const SEA_STACKS_PER = 3;

/** A handful of islands get a lighthouse so there are readable tall spires. */
const LIGHTHOUSE_EVERY = 7;
/** Foliage props scattered per island, on a band around the shoreline. */
/** Floating POIs moored just off some shores (navigation + story hooks). */
const MOORINGS = ["buoy.glb", "treasure chest floating.glb", "ship debris.glb"];
const MOORING_TARGET: Record<string, number> = {
	"buoy.glb": 6,
	"treasure chest floating.glb": 4,
	"ship debris.glb": 7,
};
/** Every Nth island gets a moored prop just off its beach. */
const MOORING_EVERY = 5;
/** Anchored sailing vessels off some shores — horizon traffic + a scale cue. */
const ANCHORAGE: { model: string; target: number }[] = [
	{ model: "Merchant Ship.glb", target: 44 },
	{ model: "Galleon.glb", target: 52 },
	{ model: "Brigantine.glb", target: 38 },
];
const ANCHORAGE_EVERY = 9;

/** Ambient life: a handful of islands get circling seagull billboards. Kept
 *  deliberately small (every GULL_EVERYth island, GULLS_PER_ISLAND each) because
 *  this scenery pass is OOM-sensitive — the gulls are cheap billboard quads
 *  sharing one texture + one geometry via clones, so the cost is almost all in
 *  count, not draw. Tune these DOWN first if memory regresses. */
const GULL_EVERY = 5;
const GULLS_PER_ISLAND = 2;

/** Thematic port names cycled across the islands, for the docking prompt. */
const PORT_NAMES = [
	"Tortuga Cove", "Port Royal", "Isla de Fuego", "Skull Harbour", "Maracaibo",
	"Nassau", "Barataria", "Sainte-Anne", "Tortuga", "Portobelo", "Cartagena",
	"Hispaniola", "Motorino", "Santo Cristo", "Guanabo", "San Blas", "Bluefields",
	"Belize", "Roatan", "Utila", "Cozumel", "Trinidad",
];

interface Template {
	container: AssetContainer;
	roots: Node[];
	scale: number;
	center: Vector3;
	minY: number;
	/** Half-extent in XZ after scaling — the footprint radius used for rings. */
	footprint: number;
}

export class IslandSystem {
	private templates = new Map<string, Template>();
	private loading = new Map<string, Promise<Template>>();
	private root: TransformNode;
	private spawned = 0;
	private failed: string[] = [];

	// Procedural rock bodies, generated once and placed as GPU instances. Each
	// base is a noise-displaced icosphere sharing one geometry + one material;
	// instances add only a transform, so high boulder/sea-stack counts are
	// memory-cheap (unlike the textured island GLBs). See buildRocks/addRocks.
	private rockMat!: StandardMaterial;
	private rockBases: Mesh[] = [];
	private rockCount = 0;
	private foliageCount = 0;

	// Shore surf (one foam system per island) + moored floating props that bob.
	private foamTex: Texture;
	private surf: ParticleSystem[] = [];
	private moorings: { node: TransformNode; baseY: number; phase: number }[] = [];
	private time = 0;
	/** True once activate() has decoded the world; update() no-ops before this. */
	private started = false;
	/** Dockable landfalls at stable world coords — the docking prompt reads these. */
	private ports: { x: number; z: number; name: string }[] = [];

	// Ambient seagull billboards: one shared texture + one template plane, cloned
	// per bird, each circling/bobbing above a chosen island. See spawnGulls().
	private gullTex!: Texture;
	private gullMat!: StandardMaterial;
	private gullTemplate!: Mesh;
	private gulls: {
		mesh: Mesh; cx: number; cz: number; r: number; speed: number; angle: number;
		baseY: number; bobAmp: number; bobFreq: number; phase: number;
	}[] = [];

	constructor(private scene: Scene) {
		this.root = new TransformNode("islands", this.scene);
		this.foamTex = new Texture(asset("/vfx/water_impact.png"), scene);
		this.initGulls();
		this.buildRocks();
		// The textured scenery (island / foliage / port-ship GLBs, ~400 MB of GPU
		// uploads) is NOT decoded here. The boot constructor runs while the canvas is
		// still hidden behind the title, and decoding the whole archipelago for a
		// scene nobody sees is what OOM-kills the tab (task #70). It happens once on
		// the first join instead — see activate().
	}

	/** Decode the world. Idempotent; called from createGame's startPlaying(). */
	activate(): void {
		if (this.started) return;
		this.started = true;
		this.build();
	}

	/**
	 * One transparent gull sprite (public/img/gull.png) + a single billboarded
	 * template plane, unlit so it reads the same at any time-of-day. Every gull is
	 * a clone of this template, so N birds cost one geometry + one texture upload.
	 * The template is disabled; only clones are shown. Parented under `root` so it
	 * is torn down with the rest of the scenery.
	 */
	private initGulls(): void {
		this.gullTex = new Texture(asset("/img/gull.png"), this.scene, false, true);
		this.gullTex.hasAlpha = true;
		this.gullMat = new StandardMaterial("gullMat", this.scene);
		// Emissive + opacity from the same texture = a flat, lighting-independent
		// sprite; backFaceCulling off so a billboard never disappears when the
		// camera passes it.
		this.gullMat.emissiveTexture = this.gullTex;
		this.gullMat.opacityTexture = this.gullTex;
		this.gullMat.diffuseColor = new Color3(0, 0, 0);
		this.gullMat.specularColor = new Color3(0, 0, 0);
		this.gullMat.disableLighting = true;
		this.gullMat.backFaceCulling = false;

		this.gullTemplate = MeshBuilder.CreatePlane("gull_tpl", { size: 1 }, this.scene);
		// Keep the bird upright and turn it to face the camera horizontally — a
		// full YZ/ALL billboard would tilt the silhouette with camera pitch.
		this.gullTemplate.billboardMode = AbstractMesh.BILLBOARDMODE_Y;
		this.gullTemplate.material = this.gullMat;
		this.gullTemplate.isPickable = false;
		this.gullTemplate.setEnabled(false);
		this.gullTemplate.parent = this.root;
	}

	/**
	 * Spawn a small flock circling above one island. Called for a subset of
	 * islands (see GULL_EVERY) to stay inside the scenery memory budget. Each bird
	 * gets its own orbit radius / speed / direction / bob phase so the flock never
	 * marches in lockstep. The gull one-shot audio is already weather-gated inside
	 * AudioSystem (scheduleAmbient), so the visuals and the calls are tied through
	 * the shared fair-weather condition rather than a direct, over-coupled hook.
	 */
	private spawnGulls(cx: number, cz: number, footprint: number, rnd: () => number): void {
		for (let i = 0; i < GULLS_PER_ISLAND; i++) {
			const mesh = this.gullTemplate.clone(`gull_${cx.toFixed(0)}_${cz.toFixed(0)}_${i}`);
			if (!mesh) continue;
			mesh.parent = this.root;
			mesh.setEnabled(true);
			// ~6-9 world-unit wingspan; small on the horizon, readable up close.
			mesh.scaling.setAll(6 + rnd() * 3);
			const angle = rnd() * Math.PI * 2;
			const r = footprint * (0.7 + rnd() * 0.5);
			const baseY = 26 + rnd() * 20;
			mesh.position.set(cx + Math.cos(angle) * r, baseY, cz + Math.sin(angle) * r);
			this.gulls.push({
				mesh, cx, cz, r, angle, baseY,
				// Slow circling, some clockwise, some not.
				speed: (0.12 + rnd() * 0.12) * (rnd() < 0.5 ? -1 : 1),
				bobAmp: 1.5 + rnd() * 2.5,
				bobFreq: 0.8 + rnd() * 0.8,
				phase: rnd() * Math.PI * 2,
			});
		}
	}

	/** Measure a GLB once and derive an auto-fit scale + footprint. */
	private loadTemplate(model: string, target: number): Promise<Template> {
		const existing = this.loading.get(model);
		if (existing) return existing;

		const promise = SceneLoader.LoadAssetContainerAsync(asset("/models/"), model, this.scene, undefined, ".glb").then(
			(container) => {
				let minX = Infinity, minY = Infinity, minZ = Infinity;
				let maxX = -Infinity, maxY = -Infinity, maxZ = -Infinity;
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
				const dx = maxX - minX, dz = maxZ - minZ;
				const horizontal = Math.max(dx, dz) || 1;
				const scale = target / horizontal;
				const center = new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
				const footprint = (horizontal / 2) * scale;
				// Hide the template so only our clones are visible.
				container.meshes.forEach((m) => m.setEnabled(false));
				const tpl: Template = { container, roots: container.rootNodes, scale, center, minY, footprint };
				this.templates.set(model, tpl);
				return tpl;
			}
		);
		this.loading.set(model, promise);
		return promise;
	}

	/** Clone every root node of a template under `parent` and enable them. */
	private instantiate(tpl: Template, parent: TransformNode, name: string): void {
		for (const r of tpl.roots) {
			const clone = (r as unknown as { clone: (n: string) => AbstractMesh | Node | null }).clone(
				`${name}_${r.name}`
			);
			if (!clone) continue;
			clone.parent = parent;
			(clone as unknown as { setEnabled?: (v: boolean) => void }).setEnabled?.(true);
		}
	}

	/**
	 * Generate a few noise-displaced rock geometries once, hidden, to serve as the
	 * sources for GPU instances placed along every coast (see addRocks). The
	 * icospheres are displaced radially by a layered sine field so each variant
	 * gets a distinct craggy silhouette; flat-shading the result gives the faceted
	 * look of granite catching the sun. Pure geometry, no download — the OOM-safe
	 * way to put real stone in the scene, since none of the island GLBs bake it.
	 */
	private buildRocks(): void {
		const mat = new StandardMaterial("rockMat", this.scene);
		// Cool grey-boulder base with a faint ambient blue; low specular so wet rock
		// at the waterline doesn't mirror the sky.
		mat.diffuseColor = new Color3(0.33, 0.32, 0.3);
		mat.ambientColor = new Color3(0.22, 0.23, 0.26);
		mat.specularColor = new Color3(0.05, 0.05, 0.05);
		this.rockMat = mat;

		const VARIANTS = 4;
		for (let i = 0; i < VARIANTS; i++) {
			const subdiv = i % 2 === 0 ? 2 : 3; // mix chunky + detailed bodies
			const seed = WORLD_SEED + i * 2017;
			const amp = 0.5 + (i % 3) * 0.12; // crag amount
			const mesh = MeshBuilder.CreateIcoSphere(`rockBase${i}`, { radius: 1, subdivisions: subdiv }, this.scene);
			const pos = mesh.getVerticesData("position");
			if (pos) {
				for (let v = 0; v < pos.length; v += 3) {
					const x = pos[v], y = pos[v + 1], z = pos[v + 2];
					const disp = 1 + amp * (this.rockNoise(x, y, z, seed) - 0.5);
					pos[v] = x * disp;
					pos[v + 1] = y * disp * 0.85; // squash slightly so it settles like a rock
					pos[v + 2] = z * disp;
				}
				mesh.setVerticesData("position", pos);
			}
			// Flat shading rebuilds per-face normals from the new positions -> facets.
			mesh.convertToFlatShadedMesh();
			mesh.material = mat;
			mesh.isPickable = false;
			// The source geometry stays hidden; only its instances render.
			mesh.isVisible = false;
			mesh.parent = this.root;
			this.rockBases.push(mesh);
		}
	}

	/** Cheap continuous 3-octave pseudo-noise in [0,1] — blobby lumps plus fine
	 *  crags. A pure function of position, so even a non-indexed icosphere (with
	 *  duplicated verts on shared points) displaces identically and leaves no
	 *  cracks at the seams. */
	private rockNoise(x: number, y: number, z: number, seed: number): number {
		const o1 = (Math.sin(x * 2.1 + seed) + Math.sin(y * 2.7 + seed * 0.3) + Math.sin(z * 2.3 + seed * 0.7)) / 3;
		const o2 = (Math.sin(x * 4.9 + seed * 1.3) + Math.sin(y * 5.3 + seed * 0.9) + Math.sin(z * 4.1 + seed * 1.7)) / 3;
		const o3 = (Math.sin(x * 9.0) + Math.sin(y * 8.0 + seed) + Math.sin(z * 11.0)) / 3;
		return 0.5 + (o1 * 0.6 + o2 * 0.3 + o3 * 0.1) * 0.5;
	}

	/**
	 * Place rock instances around one island: a beach boulder ring at the
	 * waterline (so the coast reads as rocky, not smooth), a coastal outcrop on
	 * some isles, and offshore sea-stacks on others — the dramatic spires that dot
	 * an AC-Black-Flag coastline, standing in open water clear of the island.
	 */
	private addRocks(cx: number, cz: number, footprint: number, rnd: () => number, islandIdx: number): void {
		if (this.rockBases.length === 0) return;

		// Beach boulders: low and half-buried around the shoreline band.
		for (let i = 0; i < ROCK_BOULDERS_PER_ISLAND; i++) {
			const a = rnd() * Math.PI * 2;
			const r = footprint * (0.86 + rnd() * 0.2);
			const size = footprint * (0.05 + rnd() * 0.09);
			this.instanceRock(cx + Math.sin(a) * r, cz + Math.cos(a) * r, size, size * (0.5 + rnd() * 0.5), rnd, 0.35);
		}

		// A big coastal cliff mass on some islands — an elongated rock hugging the shore.
		if (islandIdx % ROCK_OUTCROP_EVERY === 0) {
			const a = rnd() * Math.PI * 2;
			const r = footprint * 0.8;
			const s = footprint * (0.22 + rnd() * 0.16);
			this.instanceRock(cx + Math.sin(a) * r, cz + Math.cos(a) * r, s, s * (1.3 + rnd() * 0.8), rnd, 0.3);
		}

		// Offshore sea-stacks: tall spires standing in the water off the coast.
		if (islandIdx % SEA_STACK_EVERY === 0) {
			for (let i = 0; i < SEA_STACKS_PER; i++) {
				const a = rnd() * Math.PI * 2;
				const r = footprint * (1.5 + rnd() * 0.7); // clearly in open water
				const s = footprint * (0.1 + rnd() * 0.12);
				// Deep burial so only the spire shows above the swell.
				this.instanceRock(cx + Math.sin(a) * r, cz + Math.cos(a) * r, s, s * (2.2 + rnd() * 1.6), rnd, 0.9);
			}
		}
	}

	/** Create one rock instance. sxz is the footprint, sy the height, and `bury`
	 *  the fraction of the rock pushed below the surface so it reads as grounded
	 *  (boulders) or emerging from the sea (stacks) rather than floating. */
	private instanceRock(x: number, z: number, sxz: number, sy: number, rnd: () => number, bury: number): void {
		const base = this.rockBases[Math.floor(rnd() * this.rockBases.length) % this.rockBases.length];
		const inst = base.createInstance(`rock_${x.toFixed(0)}_${z.toFixed(0)}`);
		inst.position.set(x, -bury * sy, z);
		inst.scaling.set(sxz, sy, sxz);
		inst.rotation.set(rnd() * 0.5, rnd() * Math.PI * 2, rnd() * 0.5);
		inst.isPickable = false;
		this.rockCount++;
	}

	/**
	 * Cluster foliage into thickets spread across the island interior so it reads
	 * as forest from the sea. Each patch is one canopy tree ringed by undergrowth;
	 * patches sit close enough that their crowns overlap into a mass. Clones share
	 * prop geometry, so this stays cheap — the reverse of the earlier OOM, which
	 * was heavy island meshes, not props.
	 */
	private addForest(cx: number, cz: number, yaw: number, footprint: number, rnd: () => number, nameTag: string): void {
		for (let p = 0; p < THICKETS_PER_ISLAND; p++) {
			const pa = rnd() * Math.PI * 2;
			const pr = footprint * (FOREST_R_MIN + rnd() * (FOREST_R_MAX - FOREST_R_MIN));
			// World position accounts for the island slot's own yaw.
			const px = cx + Math.sin(pa + yaw) * pr;
			const pz = cz + Math.cos(pa + yaw) * pr;
			for (let i = 0; i < PROPS_PER_THICKET; i++) {
				const key =
					i === 0
						? CANOPY_KEYS[Math.floor(rnd() * CANOPY_KEYS.length)]
						: UNDERSTORY_KEYS[Math.floor(rnd() * UNDERSTORY_KEYS.length)];
				const a = rnd() * Math.PI * 2;
				const r = footprint * (i === 0 ? 0 : 0.03 + rnd() * 0.08);
				const s = i === 0 ? 1.0 + rnd() * 0.5 : 0.7 + rnd() * 0.4; // canopy taller
				this.placeProp(key, px + Math.sin(a) * r, pz + Math.cos(a) * r, s, rnd, `${nameTag}_thk${p}_${i}`);
			}
		}
	}

	/** Clone a foliage prop onto the waterline at world (x,z) with a per-instance
	 *  scale, using the same measure-then-fit template loader as everything else. */
	private placeProp(key: string, x: number, z: number, scaleMul: number, rnd: () => number, name: string): void {
		const slot = new TransformNode(name, this.scene);
		slot.parent = this.root;
		slot.position.set(x, 0, z);
		slot.rotation.y = rnd() * Math.PI * 2;
		this.loadTemplate(key, FOLIAGE[key])
			.then((tpl) => {
				const body = new TransformNode("fb", this.scene);
				body.parent = slot;
				body.scaling.setAll(tpl.scale * scaleMul);
				const fSINK = 0.4;
				body.position.set(-tpl.center.x * tpl.scale, -fSINK - tpl.minY * tpl.scale, -tpl.center.z * tpl.scale);
				this.instantiate(tpl, body, name);
				body.freezeWorldMatrix();
				slot.freezeWorldMatrix();
				this.foliageCount++;
			})
			.catch((err) => this.failed.push(`${key}: ${err instanceof Error ? err.message : String(err)}`));
	}

	private build(): void {
		const rnd = mulberry32(WORLD_SEED);

		// The four canonical trading harbours first, at their shared PORT_DEFS
		// coordinates — this is what makes a port a *place* you can sail to, not a
		// floating text label. Seeded before the scatter so the clear-radius below
		// can keep wild islands off their beaches.
		this.buildPorts();
		this.buildReefs();

		// Rejection-sample island centres so no two overlap and the field looks
		// natural rather than grid-locked.
		const centres: { x: number; z: number; r: number; satellite?: string }[] = [];

		// Harbour rings FIRST, around every DOCKABLE (merchant) port — the deliberate
		// "land you can see from the dock" fix. An even spread means whichever way the
		// moored captain faces out to sea, a large isle is close ahead. They are
		// intentionally inside PORT_CLEAR_RADIUS, so they skip the clear-of-ports test
		// (and skip the inter-island spacing guard — a ring is meant to encircle the
		// harbour); the guards below still keep the wild scatter and near ring off their
		// beaches, and they consume ISLAND_COUNT budget rather than adding to it.
		for (const port of PORT_DEFS) {
			if (port.faction !== "merchant") continue;
			for (let i = 0; i < HARBOUR_RING_COUNT; i++) {
				const ang = (i / HARBOUR_RING_COUNT) * Math.PI * 2 + 0.52;
				const off = HARBOUR_RING_RADII[i % HARBOUR_RING_RADII.length];
				centres.push({
					x: port.x + Math.sin(ang) * off,
					z: port.z + Math.cos(ang) * off,
					r: 0.5,
					satellite: HARBOUR_RING_MODELS[i % HARBOUR_RING_MODELS.length],
				});
			}
		}

		// Guaranteed near-field land: an even ring of isles around the centre, at a
		// few tight radii, so any captain in open water always has land on the
		// horizon. The ring is tighter and denser than the open-water default (the
		// direct fix for "there is nothing but water"); the same no-overlap guard
		// keeps the closer spacing from stacking two hulls' worth of land on one
		// spot, and the scatter refills any skipped slot back up to ISLAND_COUNT.
		for (let i = 0; i < NEAR_RING; i++) {
			const ang = (i / NEAR_RING) * Math.PI * 2;
			const rad = [200, 300, 420, 300][i % 4];
			const x = Math.sin(ang) * rad;
			const z = Math.cos(ang) * rad;
			if (!this.clearOfPorts(x, z)) continue;
			if (!this.clearOfForts(x, z)) continue;
			if (centres.every((c) => Math.hypot(c.x - x, c.z - z) > MIN_ISLAND_SPACING)) {
				centres.push({ x, z, r: rnd() });
			}
		}

		let guard = 0;
		while (centres.length < ISLAND_COUNT && guard++ < ISLAND_COUNT * 60) {
			const ang = rnd() * Math.PI * 2;
			// sqrt biases toward uniform area density instead of clumping centre.
			const rad = ISLAND_R_MIN + Math.sqrt(rnd()) * (ISLAND_R_MAX - ISLAND_R_MIN);
			const x = Math.sin(ang) * rad;
			const z = Math.cos(ang) * rad;
			if (!this.clearOfPorts(x, z)) continue;
			if (!this.clearOfForts(x, z)) continue;
			if (centres.every((c) => Math.hypot(c.x - x, c.z - z) > MIN_ISLAND_SPACING)) {
				centres.push({ x, z, r: rnd() });
			}
		}

		for (let islandIdx = 0; islandIdx < centres.length; islandIdx++) {
			const c = centres[islandIdx];
			// A harbour satellite draws a specific, chosen model (and its full-size
			// ISLAND_TARGET footprint); everything else picks a model from its seed.
			const model = c.satellite ?? ISLAND_MODELS[Math.floor(c.r * ISLAND_MODELS.length) % ISLAND_MODELS.length];
			const target = ISLAND_TARGET[model];
			const slot = new TransformNode(`island_${c.x.toFixed(0)}_${c.z.toFixed(0)}`, this.scene);
			slot.parent = this.root;
			slot.position.set(c.x, 0, c.z);
			slot.rotation.y = c.r * Math.PI * 2;
			this.ports.push({ x: c.x, z: c.z, name: PORT_NAMES[islandIdx % PORT_NAMES.length] });

			this.loadTemplate(model, target)
				.then((tpl) => {
					const body = new TransformNode("body", this.scene);
					body.parent = slot;
					body.scaling.setAll(tpl.scale);
					// Horizontal: centre the footprint on the slot origin. Vertical:
					// drop the model's lowest point a few units BELOW y=0 so the rock
					// base is submerged and the beach meets the waterline instead of the
					// island perching on top of the sea.
					const SINK = 7;
					body.position.set(-tpl.center.x * tpl.scale, -SINK - tpl.minY * tpl.scale, -tpl.center.z * tpl.scale);
					this.instantiate(tpl, body, slot.name);
					// Islands are immovable — freeze their world matrices so the engine
					// stops recomputing hundreds of static transforms every frame.
					body.freezeWorldMatrix();
					slot.freezeWorldMatrix();
					this.spawned++;

					// Surf: a broad ring of foam washing just outside the beach, so the
					// island reads as meeting a living sea, not sitting in a pool.
					this.addSurf(c.x, c.z, tpl.footprint);

					// Ambient life: a small flock of seagull billboards circles a subset
					// of islands (kept sparse for the OOM budget — see GULL_EVERY).
					if (islandIdx % GULL_EVERY === 0) {
						this.spawnGulls(c.x, c.z, tpl.footprint, rnd);
					}

					// A moored prop just off some shores — a buoy, a drifting chest, a
					// waterlogged wreck — to give the horizon readable points of interest.
					if (islandIdx % MOORING_EVERY === 0) {
						const mkey = MOORINGS[Math.floor(rnd() * MOORINGS.length)];
						const ma = rnd() * Math.PI * 2;
						const mr = tpl.footprint * (1.25 + rnd() * 0.35);
						const mslot = new TransformNode(`moor_${slot.name}`, this.scene);
						mslot.parent = this.root;
						mslot.position.set(c.x + Math.sin(ma) * mr, 0, c.z + Math.cos(ma) * mr);
						mslot.rotation.y = rnd() * Math.PI * 2;
						this.moorings.push({ node: mslot, baseY: 0, phase: rnd() * Math.PI * 2 });
						this.loadTemplate(mkey, MOORING_TARGET[mkey])
							.then((mtpl) => {
								const mb = new TransformNode("mb", this.scene);
								mb.parent = mslot;
								mb.scaling.setAll(mtpl.scale);
								mb.position.set(-mtpl.center.x * mtpl.scale, -0.5 - mtpl.minY * mtpl.scale, -mtpl.center.z * mtpl.scale);
								this.instantiate(mtpl, mb, mslot.name);
							})
							.catch((err) => this.failed.push(`${mkey}: ${err instanceof Error ? err.message : String(err)}`));
					}

					// Anchored vessel off some shores: a tall sail on the horizon reads
					// as a living, trafficked sea and gives the islands a sense of scale.
					if (islandIdx % ANCHORAGE_EVERY === 2) {
						const ah = ANCHORAGE[Math.floor(rnd() * ANCHORAGE.length)];
						const aa = rnd() * Math.PI * 2;
						const ar = tpl.footprint * (1.6 + rnd() * 0.5);
						const aslot = new TransformNode(`anchor_${slot.name}`, this.scene);
						aslot.parent = this.root;
						aslot.position.set(c.x + Math.sin(aa) * ar, 0, c.z + Math.cos(aa) * ar);
						// Broadside to the viewer-ish so the sail silhouette is wide.
						aslot.rotation.y = aa + Math.PI * 0.5;
						this.moorings.push({ node: aslot, baseY: 0, phase: rnd() * Math.PI * 2 });
						this.loadTemplate(ah.model, ah.target)
							.then((atpl) => {
								const ab = new TransformNode("ab", this.scene);
								ab.parent = aslot;
								ab.scaling.setAll(atpl.scale);
								// Sit the hull IN the water with a couple units of draft.
								const DRAFT = 3;
								ab.position.set(-atpl.center.x * atpl.scale, -DRAFT - atpl.minY * atpl.scale, -atpl.center.z * atpl.scale);
								this.instantiate(atpl, ab, aslot.name);
							})
							.catch((err) => this.failed.push(`anchor ${ah.model}: ${err instanceof Error ? err.message : String(err)}`));
					}

					const ring = tpl.footprint;
					// Clustered forest across the interior (was a 6-prop shoreline
					// sprinkle) + a procedural rocky coast: beach boulder ring, coastal
					// outcrops and, on some isles, offshore sea-stacks in the water.
					this.addForest(c.x, c.z, slot.rotation.y, tpl.footprint, rnd, slot.name);
					this.addRocks(c.x, c.z, tpl.footprint, rnd, islandIdx);

					// A few islands get a lighthouse on their highest shore, giving the
					// horizon tall, readable navigation spires.
					if (Math.round(c.r * 1000) % LIGHTHOUSE_EVERY === 0) {
						const lslot = new TransformNode(`lh_${slot.name}`, this.scene);
						lslot.parent = this.root;
						lslot.position.set(c.x + ring * 0.75, 0, c.z);
						this.loadTemplate("lighthouse.glb", 60)
							.then((ltpl) => {
								const lb = new TransformNode("lb", this.scene);
								lb.parent = lslot;
								lb.scaling.setAll(ltpl.scale);
								lb.position.set(-ltpl.center.x * ltpl.scale, -8 - ltpl.minY * ltpl.scale, -ltpl.center.z * ltpl.scale);
								this.instantiate(ltpl, lb, lslot.name);
								lb.freezeWorldMatrix();
								lslot.freezeWorldMatrix();
							})
							.catch((err) => this.failed.push(`lighthouse.glb: ${err instanceof Error ? err.message : String(err)}`));
					}
				})
				.catch((err) => this.failed.push(`${model}: ${err instanceof Error ? err.message : String(err)}`));
		}
	}

	/** True when (x,z) is clear of every named port's own island footprint. */
	private clearOfPorts(x: number, z: number): boolean {
		return PORT_DEFS.every((p) => Math.hypot(p.x - x, p.z - z) > PORT_CLEAR_RADIUS);
	}

	/** True when (x,z) is clear of every shore fort's battery, so scatter/ring
	 *  islands never grow through a fort model. */
	private clearOfForts(x: number, z: number): boolean {
		return FORT_DEFS.every((f) => Math.hypot(f.x - x, f.z - z) > FORT_CLEAR_RADIUS);
	}

	/**
	 * Anchor a real landmass + a moored trader at each PORT_DEFS coordinate so a
	 * port is a destination you can see and sail to (the old build only ever drew a
	 * floating label where the docking circle is). Reuses the same measure-then-fit
	 * loader as the wild islands; each harbour also registers in `this.ports` so the
	 * proximity prompt names the true harbour rather than an anonymous rock.
	 */
	/**
	 * Paint each REEF_DEFS shoal as a pale turquoise shelf ringed by breakers, so
	 * the shallow-water hazard is readable from the sea before you commit to it.
	 * A translucent disc sits just proud of the (opaque) ocean plane; a white torus
	 * at its rim reads as surf. Static, frozen, unlit-cheap.
	 */
	private buildReefs(): void {
		const shelfMat = new StandardMaterial("reefShelf", this.scene);
		shelfMat.diffuseColor = new Color3(0.35, 0.8, 0.78);
		shelfMat.specularColor = new Color3(0, 0, 0);
		shelfMat.emissiveColor = new Color3(0.12, 0.4, 0.42);
		shelfMat.alpha = 0.5;
		const foamMat = new StandardMaterial("reefFoam", this.scene);
		foamMat.diffuseColor = new Color3(0.95, 0.98, 1);
		foamMat.emissiveColor = new Color3(0.6, 0.66, 0.7);
		foamMat.specularColor = new Color3(0, 0, 0);
		foamMat.alpha = 0.7;
		for (const r of REEF_DEFS) {
			const shelf = MeshBuilder.CreateDisc(`reef_${r.id}`, { radius: r.radius, tessellation: 48 }, this.scene);
			shelf.rotation.x = Math.PI / 2;
			shelf.position.set(r.x, 0.25, r.z);
			shelf.material = shelfMat;
			shelf.isPickable = false;
			const breakers = MeshBuilder.CreateTorus(`reefring_${r.id}`, { diameter: r.radius * 2, thickness: 7, tessellation: 48 }, this.scene);
			breakers.position.set(r.x, 0.4, r.z);
			breakers.material = foamMat;
			breakers.isPickable = false;
			shelf.freezeWorldMatrix();
			breakers.freezeWorldMatrix();
		}
	}

	private buildPorts(): void {
		for (const port of PORT_DEFS) {
			const spec = PORT_ISLAND[port.faction];
			const yaw = port.id * 0.9;
			const slot = new TransformNode(`port_${port.id}`, this.scene);
			slot.parent = this.root;
			slot.position.set(port.x, 0, port.z);
			slot.rotation.y = yaw;
			// Register the REAL harbour (name from PORT_DEFS) for the dock prompt.
			this.ports.push({ x: port.x, z: port.z, name: port.name });

			this.loadTemplate(spec.model, spec.target)
				.then((tpl) => {
					const body = new TransformNode("body", this.scene);
					body.parent = slot;
					body.scaling.setAll(tpl.scale);
					const SINK = 7;
					body.position.set(-tpl.center.x * tpl.scale, -SINK - tpl.minY * tpl.scale, -tpl.center.z * tpl.scale);
					this.instantiate(tpl, body, slot.name);
					body.freezeWorldMatrix();
					slot.freezeWorldMatrix();

					this.addSurf(port.x, port.z, tpl.footprint);

					// A lighthouse on the harbour mouth — every port reads as a staffed
					// navigation point, day or night.
					const lslot = new TransformNode(`lh_${slot.name}`, this.scene);
					lslot.parent = this.root;
					lslot.position.set(port.x + tpl.footprint * 0.8, 0, port.z);
					this.loadTemplate("lighthouse.glb", 66)
						.then((ltpl) => {
							const lb = new TransformNode("lb", this.scene);
							lb.parent = lslot;
							lb.scaling.setAll(ltpl.scale);
							lb.position.set(-ltpl.center.x * ltpl.scale, -8 - ltpl.minY * ltpl.scale, -ltpl.center.z * ltpl.scale);
							this.instantiate(ltpl, lb, lslot.name);
							lb.freezeWorldMatrix();
							lslot.freezeWorldMatrix();
						})
						.catch((err) => this.failed.push(`port lh ${port.name}: ${err instanceof Error ? err.message : String(err)}`));

					// A moored merchant fleet off the beach — the trading hub that
					// gives the harbour its reason to exist and the place a fresh
					// captain starts docked. Each hull bobs on its own phase.
					for (let hi = 0; hi < PORT_HUB_SHIPS.length; hi++) {
						const off = PORT_HUB_SHIPS[hi];
						const sa = yaw + off.ang;
						const sr = tpl.footprint * off.rad;
						const sslot = new TransformNode(`ship_${slot.name}_${hi}`, this.scene);
						sslot.parent = this.root;
						sslot.position.set(port.x + Math.sin(sa) * sr, 0, port.z + Math.cos(sa) * sr);
						sslot.rotation.y = sa + Math.PI * 0.5;
						this.moorings.push({ node: sslot, baseY: 0, phase: sa });
						this.loadTemplate(PORT_SHIP.model, PORT_SHIP.target)
							.then((stpl) => {
								const sb = new TransformNode("sb", this.scene);
								sb.parent = sslot;
								sb.scaling.setAll(stpl.scale);
								const DRAFT = 3;
								sb.position.set(-stpl.center.x * stpl.scale, -DRAFT - stpl.minY * stpl.scale, -stpl.center.z * stpl.scale);
								this.instantiate(stpl, sb, sslot.name);
							})
							.catch((err) => this.failed.push(`port ship ${port.name} ${hi}: ${err instanceof Error ? err.message : String(err)}`));
					}
				})
				.catch((err) => this.failed.push(`port island ${port.name}: ${err instanceof Error ? err.message : String(err)}`));
		}
	}

	/** A ring of surf foam washing the shoreline: whitecaps rising and falling. */
	private addSurf(x: number, z: number, footprint: number): void {
		const ps = new ParticleSystem(`surf_${x.toFixed(0)}_${z.toFixed(0)}`, 1500, this.scene);
		ps.particleTexture = this.foamTex;
		const emitter = new Vector3(x, 0.4, z);
		ps.emitter = emitter;
		// A box spanning the island footprint spreads foam around the whole coast.
		const b = footprint * 1.05;
		ps.minEmitBox = new Vector3(-b, 0, -b);
		ps.maxEmitBox = new Vector3(b, 0.4, b);
		ps.color1 = new Color4(0.92, 0.97, 1.0, 0.5);
		ps.color2 = new Color4(0.82, 0.92, 1.0, 0.32);
		ps.colorDead = new Color4(1, 1, 1, 0.0);
		ps.minSize = 2.5;
		ps.maxSize = 7;
		ps.minLifeTime = 0.5;
		ps.maxLifeTime = 1.2;
		ps.emitRate = 120;
		ps.blendMode = ParticleSystem.BLENDMODE_ADD;
		ps.gravity = new Vector3(0, -6, 0);
		// Push outward from the island so it reads as breakers washing the rock.
		ps.direction1 = new Vector3(-1, 2.5, -1);
		ps.direction2 = new Vector3(1, 4, 1);
		ps.minEmitPower = 1.5;
		ps.maxEmitPower = 4;
		ps.updateSpeed = 0.014;
		ps.start();
		this.surf.push(ps);
	}

	/** Bob the moored props so they float on the sea rather than being planted. */
	update(dt: number): void {
		if (this.moorings.length === 0 && this.gulls.length === 0) return;
		this.time += dt;
		for (const m of this.moorings) {
			m.node.position.y = m.baseY + Math.sin(this.time * 1.2 + m.phase) * 0.5;
			m.node.rotation.z = Math.sin(this.time * 0.6 + m.phase) * 0.05;
		}
		// Circling + bobbing gulls. Facing the camera is handled by the mesh's
		// billboardMode, so here we only drive position along each bird's orbit.
		for (const g of this.gulls) {
			g.angle += g.speed * dt;
			g.mesh.position.x = g.cx + Math.cos(g.angle) * g.r;
			g.mesh.position.z = g.cz + Math.sin(g.angle) * g.r;
			g.mesh.position.y = g.baseY + Math.sin(this.time * g.bobFreq + g.phase) * g.bobAmp;
		}
	}

	/** Nearest dockable landfall within `range`, for the proximity HUD prompt. */
	nearestPort(x: number, z: number, range: number): { name: string; dist: number } | null {
		let best: { name: string; dist: number } | null = null;
		for (const p of this.ports) {
			const d = Math.hypot(p.x - x, p.z - z);
			if (d <= range && (!best || d < best.dist)) best = { name: p.name, dist: d };
		}
		return best;
	}

	/** QA: did the horizon scenery actually load? Surfaced on the dev handle. */
	stats(): { islands: number; expected: number; meshCount: number; rocks: number; foliage: number; failed: string[] } {
		return {
			islands: this.spawned,
			expected: ISLAND_COUNT,
			// Total meshes under the scenery root — the number to watch for LOD.
			meshCount: this.root.getChildMeshes().length,
			// Instanced rock bodies + cloned foliage props actually placed.
			rocks: this.rockCount,
			foliage: this.foliageCount,
			failed: this.failed,
		};
	}

	dispose(): void {
		for (const ps of this.surf) {
			ps.stop();
			ps.dispose();
		}
		this.surf = [];
		this.foamTex.dispose();
		this.root.dispose(false, true);
		for (const tpl of this.templates.values()) tpl.container.dispose();
		this.templates.clear();
		this.loading.clear();
	}
}
