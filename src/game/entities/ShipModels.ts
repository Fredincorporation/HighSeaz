import { AssetContainer, Scene, TransformNode, Vector3, SceneLoader, Node } from "@babylonjs/core";
import "@babylonjs/loaders/glTF"; // side-effect: registers the .glb/.gltf loader with SceneLoader
import type { ShipClass } from "@shared/index";
import { asset } from "../core/assets";

/**
 * Loads each ship GLB ONCE, measures it, and hands out scaled + waterline-
 * centred instances (via TransformNode.instantiateHierarchy). Model files live
 * in `public/models` (spaces URL-encoded). Bow is assumed to face +Z; if a
 * hull renders sideways add its yaw offset to ORIENTATION_OFFSET.
 */

const MODEL_FILE: Record<ShipClass, string> = {
	starter_sloop: "Starter Sloop.glb",
	raider_sloop: "Raider Sloop.glb",
	raider_brig: "Raider Brig.glb",
	brigantine: "Brigantine.glb",
	merchant: "Merchant Ship.glb",
	galleon: "Galleon.glb",
	war_galleon: "War Galleon.glb",
	imperial: "Imperial Ship.glb",
};

/** Target hull length in world units, by class (drives auto-fit scale). */
const TARGET_LENGTH: Record<ShipClass, number> = {
	starter_sloop: 22,
	raider_sloop: 26,
	raider_brig: 32,
	brigantine: 38,
	merchant: 44,
	galleon: 52,
	war_galleon: 62,
	imperial: 72,
};

/** Extra yaw (radians) applied to models whose bow is not +Z. The imported
 *  PBR hulls are authored with the bow along local -X, so they need a quarter
 *  turn (and a half) to point down the ship's heading (root-local +Z). */
const ORIENTATION_OFFSET: Partial<Record<ShipClass, number>> = {
	starter_sloop: -Math.PI / 2,
	raider_sloop: -Math.PI / 2,
	raider_brig: -Math.PI / 2,
	brigantine: -Math.PI / 2,
	merchant: -Math.PI / 2,
	galleon: -Math.PI / 2,
	war_galleon: -Math.PI / 2,
	imperial: -Math.PI / 2,
};

interface Template {
	container: AssetContainer;
	roots: Node[];
	scale: number;
	center: Vector3;
	minY: number;
}

export class ShipModels {
	private templates = new Map<ShipClass, Template>();
	private loading = new Map<ShipClass, Promise<Template>>();

	constructor(private scene: Scene) {}

	private loadTemplate(cls: ShipClass): Promise<Template> {
		const existing = this.loading.get(cls);
		if (existing) return existing;

		const promise = SceneLoader.LoadAssetContainerAsync(asset("/models/"), MODEL_FILE[cls], this.scene, undefined, ".glb").then(
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
				const scale = TARGET_LENGTH[cls] / horizontal;
				const center = new Vector3((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);

				const roots = container.rootNodes;
				container.meshes.forEach((m) => m.setEnabled(false));

				const tpl: Template = { container, roots, scale, center, minY };
				this.templates.set(cls, tpl);
				return tpl;
			}
		);

		this.loading.set(cls, promise);
		return promise;
	}

	/** Returns a root node to place in the world; resolves once the model is ready. */
	async spawn(cls: ShipClass, id: string): Promise<TransformNode> {
		const tpl = await this.loadTemplate(cls);
		const root = new TransformNode(`ship_${id}`, this.scene);
		const body = new TransformNode(`ship_${id}_body`, this.scene);
		body.parent = root;
		body.scaling.setAll(tpl.scale);
		// Horizontal: center the hull on the root origin. Vertical: anchor the
		// keel a couple units below the waterline (DRAFT) so the ship sits IN the
		// sea, not perched on top of it.
		const DRAFT = 3;
		body.position.set(-tpl.center.x * tpl.scale, -DRAFT - tpl.minY * tpl.scale, -tpl.center.z * tpl.scale);
		body.rotation.y = ORIENTATION_OFFSET[cls] ?? 0;

		// Clone each root node, then reparent under `body`. Both Mesh and
		// TransformNode expose clone(name), but Mesh.clone's optional parent arg
		// only accepts an AbstractMesh, so we assign `.parent` afterwards (the
		// property accepts any Node, including our TransformNode body).
		for (const r of tpl.roots) {
			const clone = (r as unknown as { clone: (n: string) => { parent?: unknown } | null }).clone(
				`ship_${id}_${r.name}`
			);
			if (clone) clone.parent = body;
		}
		// The source meshes are disabled (to hide the template); the freshly
		// instantiated clones inherit that, so re-enable this ship's meshes.
		body.getChildMeshes().forEach((m) => m.setEnabled(true));
		return root;
	}

	dispose(): void {
		for (const tpl of this.templates.values()) tpl.container.dispose();
		this.templates.clear();
		this.loading.clear();
	}
}
