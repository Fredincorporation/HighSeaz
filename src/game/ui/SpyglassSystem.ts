import { Vector3 } from "@babylonjs/core";
import type { FreeCamera } from "@babylonjs/core";
import type { ShipState, Faction } from "@shared/index";
import { SHIP_CLASSES } from "@shared/index";

/**
 * Lens model — a real spyglass magnification, not one hard-coded FOV. Babylon
 * `fov` is the VERTICAL angle in radians; the chase loop's own speed-FOV sits
 * ~0.85..1.01 (≈ 50–58°). The glass narrows that by the chosen magnification:
 * fov = WIDE_FOV / mag, where WIDE_FOV is the vertical view at ×1 (a mild ~41°
 * binocular field) and `mag` is the player-controlled zoom. Higher magnification
 * = a tighter telephoto that fills the frame with a distant hull, exactly like
 * dialling a camera lens.
 */
const WIDE_FOV = 0.72; // vertical FOV (rad) at ×1
const MIN_MAG = 1; // no magnification
const MAX_MAG = 5; // full telephoto
const DEFAULT_MAG = 2.5; // a sensible resting zoom when raised
const ZOOM_STEP = 0.25; // per button click / wheel notch

/** Half-cone (radians) around the view axis an identified hull must fall inside.
 *  Wider than the narrowed frame so a ship still drifting off-centre is kept
 *  readable rather than flicking to "no vessel sighted" as you steer. */
const ID_CONE = 0.24;

/** Max straight-line range (world units) at which the glass resolves a hull.
 *  The server already culls beyond the weather sight range, so this is a
 *  courtesy cap well inside what the client could ever have been sent. */
const MAX_RANGE = 720;

/** Faction -> (label, flag swatch colour). Mirrors the three reputation counters
 *  in the shared types; a neutral grey covers any future faction. */
const FACTIONS: Record<Faction, { label: string; color: string }> = {
	naval: { label: "Naval", color: "#6fb0ff" },
	pirate: { label: "Pirate", color: "#ff7a6f" },
	merchant: { label: "Merchant", color: "#ffc06f" },
};

export interface SpyglassDeps {
	camera: FreeCamera;
	/** Latest authoritative hull states (the client snapshot the glass reads). */
	getStates: () => ShipState[];
	/** The player's own runtime ship id, or null before joining. Used to skip self. */
	getSelfId: () => string | null;
}

/**
 * A spyglass reveal — "identify before engage".
 *
 * Purely a client-side UX layer over data the client ALREADY has: the server
 * culls distant hulls by weather sight range (world-as-cover), so every hull in
 * the snapshot is one the player can in principle see. Raising the glass narrows
 * the camera FOV (zoom) and names the single most prominent in-range hull ahead
 * of the view axis — the one you'd be shooting at — so you can decide to engage
 * before you commit a broadside.
 *
 * No server protocol. Additive + revertible: on deactivate we simply stop
 * overriding the FOV and the existing chase loop eases the lens back to its
 * natural (speed-driven) value on its own; `dispose()` restores it explicitly.
 */
export class SpyglassSystem {
	active = false;

	/** Current lens magnification (×), clamped to [MIN_MAG, MAX_MAG]. */
	private mag = DEFAULT_MAG;

	private el: HTMLDivElement | null = null;
	private lens: HTMLDivElement | null = null;
	private readout: HTMLDivElement | null = null;
	private zoomLabel: HTMLSpanElement | null = null;
	// Bound once so the wheel zoom can be cleanly removed in dispose().
	private wheelHandler: ((e: WheelEvent) => void) | null = null;
	// Reused scratch for the camera-forward lookup so update() allocates nothing
	// per frame while the glass is held.
	private _fwd = new Vector3(0, 0, 1);
	private _localForward = new Vector3(0, 0, 1);
	/** Distance (world units) to the last identified hull, cached for the readout. */
	private _lastRange = 0;

	constructor(private deps: SpyglassDeps) {}

	/** Bind `V` / the HUD button to a toggle. Call once after construction. */
	toggle(): void {
		this.setActive(!this.active);
	}

	setActive(on: boolean): void {
		if (on === this.active) return;
		this.active = on;
		this.ensureDom();
		this.updateZoomLabel();
		if (this.el) this.el.style.opacity = on ? "1" : "0";
		// On the way OUT, hand the lens back to the speed-FOV loop (which eases
		// camera.fov from the zoomed value toward its natural target every frame),
		// so restore is guaranteed even if update() stops being called.
		if (!on) this.render(null);
	}

	/** Adjust the magnification by `delta` (× units), clamped to the lens range. */
	zoomBy(delta: number): void {
		this.setZoom(this.mag + delta);
	}

	setZoom(m: number): void {
		this.mag = Math.min(MAX_MAG, Math.max(MIN_MAG, m));
		this.updateZoomLabel();
	}

	private updateZoomLabel(): void {
		if (this.zoomLabel) this.zoomLabel.textContent = `×${this.mag.toFixed(1)}`;
	}

	/** Per-frame: drive the zoom + readout. Call from the render loop AFTER the
	 *  chase loop's own FOV easing so the glass wins while active. */
	update(dt: number): void {
		if (!this.active) return;
		const cam = this.deps.camera;
		// Ease hard toward the FOV this magnification implies; the chase loop already
		// set this frame's natural value into cam.fov, so we steer down from it.
		const targetFov = WIDE_FOV / this.mag;
		const k = 1 - Math.exp(-dt / 0.18);
		cam.fov += (targetFov - cam.fov) * k;
		this.render(this.pickTarget(cam.position, cam));
	}

	/** Dispose DOM + guarantee the FOV is released back toward normal. */
	dispose(): void {
		if (this.wheelHandler) {
			window.removeEventListener("wheel", this.wheelHandler);
			this.wheelHandler = null;
		}
		this.el?.remove();
		this.el = null;
		this.lens = null;
		this.readout = null;
		this.zoomLabel = null;
		this.active = false;
		// Restore: nudge the lens off the telephoto value so the chase loop's own
		// easing recovers the natural FOV on the very next frame.
		if (this.deps.camera.fov < 0.6) this.deps.camera.fov = 0.85;
	}

	// --- Target selection ---------------------------------------------------

	/** The hull whose bearing is closest to the camera-forward axis (within the
	 *  ID cone + max range); tie-break by angular difference, then distance. */
	private pickTarget(camPos: Vector3, cam: FreeCamera): ShipState | null {
		// FreeCamera looks down its local +Z; map that to world without allocating.
		// (getDirectionToRef writes into `_fwd` and returns void.)
		cam.getDirectionToRef(this._localForward, this._fwd);
		const fwd = this._fwd;
		// Horizontalise: we care about bearing, not pitch of the chase cam.
		let fx = fwd.x;
		let fz = fwd.z;
		const fl = Math.hypot(fx, fz) || 1;
		fx /= fl;
		fz /= fl;

		let best: ShipState | null = null;
		let bestAngle = Infinity;
		let bestDist = Infinity;

		const selfId = this.deps.getSelfId();
		for (const s of this.deps.getStates()) {
			if (s.id === selfId) continue;
			if (s.status === "sunk_needs_repair") continue;
			const dx = s.position.x - camPos.x;
			const dz = s.position.z - camPos.z;
			const dist = Math.hypot(dx, dz);
			if (dist < 0.001 || dist > MAX_RANGE) continue;
			const dot = (dx / dist) * fx + (dz / dist) * fz;
			// acos clamped: dot>0 keeps the hull in FRONT of the lens.
			const angle = Math.acos(Math.max(-1, Math.min(1, dot)));
			if (angle > ID_CONE) continue;
			if (angle < bestAngle - 1e-4 || (Math.abs(angle - bestAngle) <= 1e-4 && dist < bestDist)) {
				best = s;
				bestAngle = angle;
				bestDist = dist;
			}
		}
		this._lastRange = best ? bestDist : 0;
		return best;
	}

	// --- DOM ----------------------------------------------------------------

	private render(ship: ShipState | null): void {
		if (!this.readout) return;
		if (!ship) {
			this.readout.innerHTML = `<div class="sg-none">No vessel sighted</div>`;
			return;
		}
		const spec = SHIP_CLASSES[ship.shipClass];
		const fac = FACTIONS[ship.faction] ?? { label: ship.faction, color: "#cbd6e2" };
		this.readout.innerHTML =
			`<div class="sg-name">${esc(ship.name)}</div>` +
			`<div class="sg-row"><span class="sg-key">Class</span><span>${esc(spec?.label ?? ship.shipClass)}</span></div>` +
			`<div class="sg-row"><span class="sg-key">Flag</span><span style="color:${fac.color}">● ${esc(fac.label)}</span></div>` +
			`<div class="sg-row"><span class="sg-key">Cargo</span><span>${Math.round(ship.cargo)}</span></div>` +
			`<div class="sg-row"><span class="sg-key">Range</span><span>${Math.round(this._lastRange)}</span></div>`;
	}

	private ensureDom(): void {
		if (this.el && typeof document !== "undefined" && document.contains(this.el)) return;
		if (typeof document === "undefined") return;
		const root = document.createElement("div");
		root.id = "hs-spyglass";
		// Full-screen overlay: a spyglass-tube vignette (transparent centre, dark
		// ring) + a small readout docked under the lens. pointer-events none so it
		// never eats helm/click input.
		root.style.cssText =
			"position:fixed;inset:0;z-index:80;pointer-events:none;opacity:0;" +
			"transition:opacity 0.18s ease;";
		root.innerHTML =
			`<div id="hs-sg-vignette" style="position:absolute;inset:0;` +
			`background:radial-gradient(circle at center, rgba(0,0,0,0) 34%, rgba(6,8,12,0.55) 52%, rgba(4,5,8,0.96) 74%);"></div>` +
			`<div id="hs-sg-lens" style="position:absolute;left:50%;top:50%;` +
			`width:60vmin;height:60vmin;transform:translate(-50%,-50%);` +
			`border-radius:50%;border:2px solid rgba(230,192,121,0.5);` +
			`box-shadow:0 0 0 3px rgba(0,0,0,0.6),inset 0 0 40px rgba(0,0,0,0.55);"></div>` +
			`<div id="hs-sg-cross" style="position:absolute;left:50%;top:50%;width:2px;height:2px;` +
			`transform:translate(-50%,-50%);background:rgba(230,192,121,0.6);border-radius:50%;"></div>` +
			// On-screen lens controls (the only elements that accept pointer input
			// in this otherwise click-through overlay): zoom − / magnification /
			// zoom +, then a labelled "lower" button so exiting is discoverable.
			`<div id="hs-sg-ctrl" style="position:absolute;left:50%;top:18px;` +
			`transform:translateX(-50%);display:flex;align-items:center;gap:6px;` +
			`pointer-events:auto;">` +
			`<button id="hs-sg-out" title="Zoom out">−</button>` +
			`<span id="hs-sg-zoom">×${DEFAULT_MAG.toFixed(1)}</span>` +
			`<button id="hs-sg-in" title="Zoom in">+</button>` +
			`<button id="hs-sg-close" title="Lower the glass (V)">Lower ✕</button>` +
			`</div>` +
			`<div id="hs-sg-readout" style="position:absolute;left:50%;top:50%;` +
			`transform:translate(-50%,44vmin);min-width:220px;max-width:64vw;` +
			`padding:10px 14px;background:rgba(12,18,26,0.82);color:#e7eef7;` +
			`border:1px solid rgba(230,192,121,0.35);border-radius:10px;` +
			`font:13px/1.5 ui-monospace,SFMono-Regular,monospace;letter-spacing:0.02em;` +
			`box-shadow:0 8px 30px rgba(0,0,0,0.5);text-align:left;"></div>`;

		// Scoped styles for the control bar + readout's inner rows (no global CSS file).
		const style = document.createElement("style");
		style.id = "hs-spyglass-style";
		style.textContent =
			"#hs-spyglass .sg-name{color:#e6c079;font-weight:700;font-size:15px;margin-bottom:6px;letter-spacing:0.04em;}" +
			"#hs-spyglass .sg-row{display:flex;justify-content:space-between;gap:18px;}" +
			"#hs-spyglass .sg-key{color:#8aa3bd;}" +
			"#hs-spyglass .sg-none{color:#8aa3bd;font-style:italic;text-align:center;}" +
			"#hs-sg-ctrl button{cursor:pointer;min-width:34px;padding:6px 10px;background:rgba(12,18,26,0.8);" +
			"color:#e6c079;font:700 15px/1 ui-monospace,monospace;border:1px solid rgba(230,192,121,0.5);" +
			"border-radius:8px;}" +
			"#hs-sg-ctrl button:hover{background:rgba(230,192,121,0.85);color:#0b1018;}" +
			"#hs-sg-close{font-size:12px !important;text-transform:uppercase;letter-spacing:0.05em;}" +
			"#hs-sg-zoom{min-width:46px;text-align:center;color:#e6c079;font:700 14px/1 ui-monospace,monospace;}";
		if (!document.getElementById(style.id)) document.head.appendChild(style);

		document.body.appendChild(root);
		this.el = root;
		this.lens = root.querySelector("#hs-sg-vignette") as HTMLDivElement | null;
		this.readout = root.querySelector("#hs-sg-readout") as HTMLDivElement | null;
		this.zoomLabel = root.querySelector("#hs-sg-zoom") as HTMLSpanElement | null;

		// Wire the visible controls. These are reachable only while the glass is up.
		root.querySelector("#hs-sg-in")?.addEventListener("click", () => this.zoomBy(ZOOM_STEP));
		root.querySelector("#hs-sg-out")?.addEventListener("click", () => this.zoomBy(-ZOOM_STEP));
		root.querySelector("#hs-sg-close")?.addEventListener("click", () => this.setActive(false));

		// Mouse-wheel zoom (bound once so dispose can remove it): scrolling up
		// tightens the telephoto, down widens it. Guarded on `active` so the wheel
		// is a no-op — and not preventDefault'd — when the glass is lowered.
		if (!this.wheelHandler && typeof window !== "undefined") {
			this.wheelHandler = (e: WheelEvent) => {
				if (!this.active) return;
				e.preventDefault();
				this.zoomBy(e.deltaY < 0 ? ZOOM_STEP : -ZOOM_STEP);
			};
			window.addEventListener("wheel", this.wheelHandler, { passive: false });
		}
	}
}

/** Escape the handful of string fields we splice into innerHTML (names are
 *  server/player-supplied and could contain markup). */
function esc(s: string): string {
	return String(s)
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;");
}
