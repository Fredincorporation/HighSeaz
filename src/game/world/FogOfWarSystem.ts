import { PORT_DEFS, POI_DEFS, FORT_DEFS, WORLD_SEA_RADIUS } from "@shared/index";

/**
 * FOG OF WAR / DISCOVERY (task #146) — CLIENT-ONLY.
 *
 * There is no persistent server world state for exploration, so this is a purely
 * local, session-scoped model over the FIXED world layout the client already
 * knows: the trading ports (PORT_DEFS), buried caches (POI_DEFS) and shore forts
 * (FORT_DEFS), all inside the playable disc of radius WORLD_SEA_RADIUS.
 *
 * Idea: the world is cut into a coarse grid of SECTORS. A sector starts
 * "undiscovered" (the map draws it veiled/dark). It becomes "discovered" when the
 * player sails close enough to reveal it — either by entering it / its
 * neighbourhood themselves, or by coming within POI_REVEAL_RADIUS of a point of
 * interest (which also marks that POI itself as "revealed" so the map may show its
 * marker).
 *
 * The class is presentation-agnostic: it thinks only in world coordinates and
 * string sector keys. The world-map panel (GameUi's chart) lays the veil out and
 * hides/shows markers from `isDiscovered` / `isPoiRevealed`.
 *
 * Revertible: drop the veil overlay + this import and the chart looks exactly as
 * it did before; nothing else reads the discovery state.
 */

/** One world coordinate of a POI the player can discover. `id` namespaces the
 *  marker kind so cache 0 and port 0 never collide. */
export interface FogPoi {
	id: string;
	x: number;
	z: number;
}

/** A renderable sector: its grid indices + world centre, for the caller to map to
 *  screen pixels. */
export interface FogSector {
	key: string;
	gx: number;
	gz: number;
	/** World-space centre of this sector (the point tested for on-disc / reveal). */
	cx: number;
	cz: number;
}

export class FogOfWarSystem {
	/** Coarse sector edge, in world units. The disc spans ±WORLD_SEA_RADIUS, so a
	 *  400-unit sector over a ±2900 sea gives a ~15×15 grid — coarse enough to
	 *  read as "a chart filling in", fine enough that revealing feels local. */
	static readonly SECTOR_SIZE = 400;

	/** Sailing this close to a port/fort/cache reveals that POI and its sector,
	 *  so landmarks surface as you approach them. Generous vs the dock/POI
	 *  interaction radii (140 / 60): the veil lifts well before you arrive. */
	static readonly POI_REVEAL_RADIUS = 750;

	/** Your own hull charts the water around you: any sector centre within this
	 *  of the player becomes discovered, so local sea clears as you sail. */
	static readonly PLAYER_REVEAL_RADIUS = FogOfWarSystem.SECTOR_SIZE * 1.5;

	/** localStorage key for the session's discovery (a bonus, not required). */
	private static readonly STORAGE_KEY = "hs-fog-v1";

	/** Discovered sector keys + revealed POI ids, held in memory for the session. */
	private discovered = new Set<string>();
	private revealedPois = new Set<string>();

	/** The fixed points of interest, built once from the shared world defs. */
	private readonly pois: FogPoi[];

	/** Every on-disc sector, enumerated once for the caller to lay out its veil. */
	private readonly sectorList: FogSector[];

	constructor() {
		this.pois = [
			...PORT_DEFS.map((p) => ({ id: `port:${p.id}`, x: p.x, z: p.z })),
			...POI_DEFS.map((p) => ({ id: `cache:${p.id}`, x: p.x, z: p.z })),
			...FORT_DEFS.map((f) => ({ id: `fort:${f.id}`, x: f.x, z: f.z })),
		];
		this.sectorList = FogOfWarSystem.buildSectorList();
		this.load();
	}

	/** Sector size in world units (exposed for the map's layout maths). */
	get sectorSize(): number {
		return FogOfWarSystem.SECTOR_SIZE;
	}

	/** Half-extent of the playable disc, so the caller can align its grid to it. */
	static get seaRadius(): number {
		return WORLD_SEA_RADIUS;
	}

	/** Grid key for an arbitrary world point. */
	static sectorKey(x: number, z: number): string {
		return `${FogOfWarSystem.colIndex(x)}:${FogOfWarSystem.colIndex(z)}`;
	}

	/** Column/row index of a world coordinate within the ±seaRadius disc. */
	private static colIndex(x: number): number {
		return Math.floor((x + WORLD_SEA_RADIUS) / FogOfWarSystem.SECTOR_SIZE);
	}

	/** Every sector whose centre lies on (or just outside) the sea disc. The
	 *  caller maps each centre to pixels and paints a veil cell for it. */
	private static buildSectorList(): FogSector[] {
		const S = FogOfWarSystem.SECTOR_SIZE;
		const R = WORLD_SEA_RADIUS;
		const n = Math.ceil((2 * R) / S);
		const out: FogSector[] = [];
		for (let gx = 0; gx < n; gx++) {
			for (let gz = 0; gz < n; gz++) {
				const cx = -R + S / 2 + gx * S;
				const cz = -R + S / 2 + gz * S;
				// Keep sectors that touch the disc (centre within R + one edge of
				// slack) so edge water is still veilable without painting the whole
				// square frame.
				if (Math.hypot(cx, cz) <= R + S) {
					out.push({ key: `${gx}:${gz}`, gx, gz, cx, cz });
				}
			}
		}
		return out;
	}

	/** On-disc sectors the map should be able to veil. */
	sectors(): readonly FogSector[] {
		return this.sectorList;
	}

	/** World coords of a POI's `id` (undefined if unknown). */
	poiById(id: string): FogPoi | undefined {
		return this.pois.find((p) => p.id === id);
	}

	/** Is a named POI revealed (close enough to the player to show its marker)? */
	isPoiRevealed(id: string): boolean {
		return this.revealedPois.has(id);
	}

	/** Is the sector at a world point discovered (veil lifted)? Convenience for
	 *  callers that only have a position, not a key. */
	isDiscoveredAt(x: number, z: number): boolean {
		return this.discovered.has(FogOfWarSystem.sectorKey(x, z));
	}

	/** Is a specific sector key discovered? */
	isDiscovered(key: string): boolean {
		return this.discovered.has(key);
	}

	/**
	 * Advance discovery for the player's current position. Marks nearby sectors
	 * (own hull + POIs in range) discovered/revealed. Returns true when anything
	 * NEW changed, so the caller can throttle a save / avoid needless relayout.
	 * Cheap (a handful of POIs + a bounded sector scan) to call every frame.
	 */
	update(playerX: number, playerZ: number): boolean {
		let changed = false;
		const S = FogOfWarSystem.SECTOR_SIZE;

		// 1) Chart the water around the hull: any on-disc sector whose centre is
		//    within the player reveal radius becomes discovered.
		const pr = FogOfWarSystem.PLAYER_REVEAL_RADIUS;
		for (const sec of this.sectorList) {
			if (this.discovered.has(sec.key)) continue;
			if (Math.hypot(sec.cx - playerX, sec.cz - playerZ) <= pr) {
				this.discovered.add(sec.key);
				changed = true;
			}
		}

		// 2) A POI within reveal radius surfaces: mark it revealed and lift the
		//    veil over its own sector so its marker is never stuck in the dark.
		const or = FogOfWarSystem.POI_REVEAL_RADIUS;
		for (const poi of this.pois) {
			if (Math.hypot(poi.x - playerX, poi.z - playerZ) > or) continue;
			if (!this.revealedPois.has(poi.id)) {
				this.revealedPois.add(poi.id);
				changed = true;
			}
			const key = FogOfWarSystem.sectorKey(poi.x, poi.z);
			if (!this.discovered.has(key)) {
				this.discovered.add(key);
				changed = true;
			}
		}

		void S; // (S kept local for clarity of the grid maths above)
		if (changed) this.save();
		return changed;
	}

	/** Fraction of on-disc sectors discovered (0..1), for a "charted" readout. */
	progress(): number {
		if (this.sectorList.length === 0) return 0;
		let n = 0;
		for (const sec of this.sectorList) if (this.discovered.has(sec.key)) n++;
		return n / this.sectorList.length;
	}

	// ---- localStorage persistence (bonus, guarded) --------------------------

	private save(): void {
		try {
			if (typeof localStorage === "undefined") return;
			localStorage.setItem(
				FogOfWarSystem.STORAGE_KEY,
				JSON.stringify({
					s: [...this.discovered],
					p: [...this.revealedPois],
				})
			);
		} catch {
			/* storage unavailable / quota — discovery stays in-memory only */
		}
	}

	private load(): void {
		try {
			if (typeof localStorage === "undefined") return;
			const raw = localStorage.getItem(FogOfWarSystem.STORAGE_KEY);
			if (!raw) return;
			const data = JSON.parse(raw) as { s?: string[]; p?: string[] };
			if (Array.isArray(data.s)) this.discovered = new Set(data.s);
			if (Array.isArray(data.p)) this.revealedPois = new Set(data.p);
		} catch {
			/* corrupt or unavailable — start unexplored */
		}
	}
}
