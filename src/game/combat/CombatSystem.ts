import type { CombatEvent, WeaponType } from "@shared/index";
import { Vector3 } from "@babylonjs/core";
import type { Vfx } from "../vfx/VfxLibrary";

interface Shell {
	mesh: import("@babylonjs/core").Mesh;
	p0: Vector3;
	p1: Vector3;
	/** accumulated flight seconds. */
	t: number;
	flight: number;
	/** peak of the ballistic bulge (world units). */
	arc: number;
}

/**
 * Client-side projection of authoritative combat. All damage, hit resolution and
 * sinking happen on the server (server/src/world.ts); this class only turns the
 * `shot` / `hullImpact` / `waterImpact` / `sunk` events into visuals: it flies a
 * shell mesh along the arc the server pre-solved, then plays the impact it
 * committed to. Because the server sends the resolved endpoints, the client never
 * disagrees about whether a broadside connected.
 */
export class CombatSystem {
	private shells: Shell[] = [];

	constructor(
		private vfx: Vfx,
		/** Resolves a ship's current world position so sink/splash land on the hull. */
		private resolvePosition: (shipId: string) => Vector3 | null
	) {}

	onEvent(evt: CombatEvent): void {
		switch (evt.t) {
			case "muzzleFlash":
				// The accompanying `shot` carries origin + direction and draws the
				// flash; the bare event exists for a future audio hook.
				break;
			case "shot":
				this.launchShot(evt.origin, evt.impactPoint, evt.flightTime, evt.weapon);
				break;
			case "hullImpact":
				this.vfx.hullImpact(toV(evt.point));
				break;
			case "waterImpact":
				this.vfx.waterImpact(toV(evt.point));
				break;
			case "sunk": {
				const pos = this.resolvePosition(evt.shipId);
				if (pos) this.vfx.sink(pos);
				break;
			}
		}
	}

	private launchShot(origin: { x: number; y: number; z: number }, impact: { x: number; y: number; z: number }, flight: number, weapon?: WeaponType): void {
		const p0 = toV(origin);
		const p1 = toV(impact);
		// Fire the gun (flash + smoke) from the muzzle along the shot direction.
		const dir = p1.subtract(p0);
		dir.y = 0;
		if (dir.lengthSquared() > 1e-4) dir.normalize();
		this.vfx.muzzle(p0, dir);

		const dist = p1.subtract(p0).length();
		const mesh = this.vfx.spawnShell(p0);
		// Loft a real ballistic bulge: a broadside at reach is a heavy, slow,
		// arcing iron ball, not a laser. Arc grows with distance (higher loft for
		// long shots) so the eye reads range and travel time. Fire barrels are
		// heaved in a high mortar arc; chain/swivel skim flatter and faster.
		const arcMul = weapon === "fire" ? 2.2 : weapon === "broadside" ? 1 : 0.6;
		this.shells.push({ mesh, p0, p1, t: 0, flight, arc: Math.max(6, Math.min(34, dist * 0.16)) * arcMul });
	}

	update(dt: number): void {
		this.vfx.tick(dt);
		if (this.shells.length === 0) return;
		const keep: Shell[] = [];
		for (const s of this.shells) {
			s.t += dt;
			const u = s.t / s.flight;
			if (u >= 1) {
				this.vfx.releaseShell(s.mesh);
				continue;
			}
			// Parabolic path: linear in XZ, sin bulge in Y peaking mid-flight.
			s.mesh.position.set(
				s.p0.x + (s.p1.x - s.p0.x) * u,
				s.p0.y + (s.p1.y - s.p0.y) * u + Math.sin(Math.PI * u) * s.arc,
				s.p0.z + (s.p1.z - s.p0.z) * u
			);
			keep.push(s);
		}
		this.shells = keep;
	}

	/** QA handle: shells currently in flight. */
	shellCount(): number {
		return this.shells.length;
	}

	dispose(): void {
		for (const s of this.shells) this.vfx.releaseShell(s.mesh);
		this.shells.length = 0;
	}
}

function toV(v: { x: number; y: number; z: number }): Vector3 {
	return new Vector3(v.x, v.y, v.z);
}
