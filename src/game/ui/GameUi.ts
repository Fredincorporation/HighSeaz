import {
	Scene,
	Mesh,
} from "@babylonjs/core";
import {
	AdvancedDynamicTexture,
	Control,
	Rectangle,
	TextBlock,
	StackPanel,
	Image,
	Button,
} from "@babylonjs/gui";
import type { ShipState, WeatherState, PlayerPublicState, SecurityEvent, SecurityReason, WantedEntry } from "@shared/index";
import { SHIP_CLASSES, POI_DEFS, PORT_DEFS, WORLD_SEA_RADIUS, WEAPONS, AMMO, type WeaponType, type AmmoType, type Wreck } from "@shared/index";
import { formatUsdg } from "@shared/onchain";
import { FogOfWarSystem } from "../world/FogOfWarSystem";
import { asset } from "../core/assets";

export type ShipClass3 = "self" | "ally" | "npc";

/** Player-facing name for each anti-cheat block reason (shown on the shield). */
const REASON_TEXT: Record<SecurityReason, string> = {
	helm_clamp: "speed hack",
	helm_nan: "corrupt helm",
	aim_nan: "corrupt aim",
	ownership: "hijack attempt",
	rate_limit: "input flood",
};

/** A floating hull tag: a name, a numeric-HP health bar, and a class/distance line. */
interface Marker {
	panel: Rectangle;
	bar: Rectangle;
	label: TextBlock;
	sub: TextBlock;
}

export interface UiInput {
	selfId: string | null;
	selfState: ShipState | null;
	states: ShipState[];
	weather: WeatherState;
	connected: boolean;
	/** Nearest dockable port name, when the hull is within interaction range. */
	nearestPort: string | null;
	/** Compass bearing (degrees, 0=N) to the nearest harbour, regardless of range.
	 *  Drives the gold ⚓ waypoint that always points the player toward a port. */
	portBearing: number | null;
	/** The bow-relative gun arc the current aim would loose (chain / swivel /
	 *  broadside / fire), so the HUD names the shot before it is fired. */
	weapon: WeaponType;
	/** The loaded shot (round / chain / grape / heated) riding that gun. */
	ammo: AmmoType;
	/** True when the hull is sheltered inside a port's harbour — a safe zone
	 *  where guns run cold and the fire action is refused. */
	safeZone?: boolean;
}

/**
 * In-world HUD + ship identification, drawn with Babylon GUI so it lives in the
 * same render as the 3D scene (not a DOM overlay that would fight the canvas).
 *
 * Readability is the goal: at a glance you must tell your hull from an ally's
 * from a stranger, read your own damage and speed, sense the coming weather, and
 * know when a dock is near. Everything is event-light — the game loop calls
 * `update` once per frame with a snapshot of state and this layer only nudges
 * control properties. Markers follow their hull via GUI mesh-linking, so they
 * track correctly without per-frame manual projection.
 */
export class GameUi {
	private ui: AdvancedDynamicTexture;
	private hullBar: Rectangle;
	private hullText: TextBlock;
	private speedText: TextBlock;
	private className: TextBlock;
	private cargoText: TextBlock;
	private windText: TextBlock;
	private weatherText: TextBlock;
	private statusText: TextBlock;
	private dockPrompt: StackPanel;
	private dockText: TextBlock;
	private weaponLabel: TextBlock;
	private bearingText: TextBlock;
	private windGlyph: TextBlock;
	private toastText: TextBlock;
	private toastTimer: ReturnType<typeof setTimeout> | null = null;
	private purseText: TextBlock;
	private repText: TextBlock;
	private fleetText: TextBlock;

	/** Live Most-Wanted marquee (head-hunting board): a compact left-centre panel
	 *  rebuilt only when the server re-posts the board, never per frame. */
	private wantedStack: StackPanel;

	/** Gun reload readout in the status panel: a bar that fills over the hull
	 *  class's reloadSeconds after each broadside, hidden once the guns are ready. */
	private reloadHost: Rectangle;
	private reloadFill: Rectangle;
	private reloadLabel: TextBlock;
	private reloadTotal = 0;
	private reloadEndsAt = 0;

	/** Persistent "Anti-Cheat Active" shield: pulses on each server-side block,
	 *  flashes red + toasts when a hull is flagged for cheating. */
	private shield: Rectangle;
	private shieldLabel: TextBlock;
	private shieldResetTimer: ReturnType<typeof setTimeout> | null = null;

	/** Fired when the on-screen pause icon is tapped (touch + mouse). createGame
	 *  wires this to open the pause menu; keyboard/gamepad use Esc/Start directly. */
	public onPausePressed: (() => void) | null = null;

	/** Top-centre compass strip: cardinal labels repositioned by heading each frame. */
	private compassHost: Rectangle;
	private compassTicks: { label: TextBlock; deg: number }[] = [];
	/** A gold ⚓ that slides along the strip toward the nearest harbour's bearing,
	 *  so "which way to sail to dock" is always readable without looking down. */
	private portWaypoint: TextBlock | null = null;
	private static readonly COMPASS_SPAN_DEG = 60; // half-view of the strip, degrees
	private static readonly COMPASS_STRIP_W = 360; // px

	/** Bottom-left pirate compass: a north-seeking golden rose that spins with heading. */
	private compassRoseHost: Rectangle;
	private compassRose: Image;

	private anchors = new Map<string, Mesh>();
	private markers = new Map<string, Marker>();
	/** A persistent floating hull bar over the player's own ship (hidden until they spawn). */
	private selfMk: Marker | null = null;
	/** Buried-cache world markers, one per POI; hidden once dug. */
	private poiMarkers = new Map<number, { anchor: Mesh; panel: Rectangle }>();
	/** Salvage debris-field markers, synced from the live snapshot wrecks; dropped
	 *  once dove or scattered. Rebuilt each snapshot so positions/labels stay true. */
	private wreckMarkers = new Map<number, { anchor: Mesh; panel: Rectangle }>();
	/** Fixed trading-port world markers (where docking is enabled). */
	private portMarkers: { anchor: Mesh; panel: Rectangle }[] = [];
	/** DEV ONLY: a sticky sample wreck marker that tracks ahead of the hull so the
	 *  salvage UI can be inspected without orchestrating a real sinking. */
	private debugWreckActive = false;
	private debugWreckMk: { anchor: Mesh; panel: Rectangle } | null = null;
	/** DEV ONLY: force every rival marker to show a sample ⚔ prestige badge. */
	private debugBadgesActive = false;

	// ---- World map overlay (floating 🗺 icon toggles it) --------------------
	private mapOpen = false;
	private mapFrame!: Rectangle;
	private mapSelfDot!: Rectangle;
	private mapSelfTick!: Rectangle;
	/** Reusable ship dots (pool) + wreck dots, repositioned each frame while open. */
	private mapShipDots: Rectangle[] = [];
	private mapWreckDots: Rectangle[] = [];
	/** Inner plot radius in GUI px; world ±WORLD_SEA_RADIUS maps to ±this. */
	private static readonly MAP_HALF = 244;

	// ---- Fog of war (task #146): the chart's undiscovered veil --------------
	/** Session-local discovery over the fixed world layout (ports/caches/forts). */
	private fog: FogOfWarSystem | null = null;
	/** One dark cell per on-disc sector; `isVisible` mirrors `!isDiscovered`. */
	private veilCells: { d: Rectangle; key: string }[] = [];
	/** Port + cache dots, tagged with their POI id so unexplored ones hide. */
	private mapPortDots: { d: Rectangle; lbl: TextBlock; poiId: string }[] = [];
	private mapCacheDots: { d: Rectangle; poiId: string }[] = [];

	constructor(
		private scene: Scene,
		private camera: import("@babylonjs/core").Camera
	) {
		this.ui = AdvancedDynamicTexture.CreateFullscreenUI("hs-hud", true, scene);

		// ---- Top-left: own ship status panel ------------------------------
		// Explicit pixel height: a Rectangle with height="auto" measures to NaN
		// when it wraps a vertical StackPanel, and that NaN cascades through the
		// root container's layout so the ENTIRE fullscreen HUD draws nothing.
		const panel = new Rectangle("status");
		panel.width = "240px";
		panel.height = "176px";
		panel.cornerRadius = 8;
		panel.color = "rgba(180,210,235,0.35)";
		panel.background = "rgba(6,12,20,0.55)";
		panel.thickness = 1;
		panel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		panel.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
		panel.paddingLeft = "16px";
		panel.paddingTop = "14px";
		panel.paddingBottom = "14px";
		this.ui.addControl(panel);

		const stack = new StackPanel("statusStack");
		stack.isVertical = true;
		stack.width = "100%";
		stack.height = "100%";
		stack.spacing = 2;
		stack.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		stack.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
		panel.addControl(stack);

		this.className = mkText("Starter Sloop", 15, "#dff0ff", true);
		stack.addControl(this.className);

		// Hull integrity bar.
		const barHost = new Rectangle("hullHost");
		barHost.height = "12px";
		barHost.width = "200px";
		barHost.color = "rgba(0,0,0,0.6)";
		barHost.background = "rgba(30,45,60,0.9)";
		barHost.thickness = 1;
		barHost.cornerRadius = 4;
		barHost.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
		stack.addControl(barHost);
		this.hullBar = new Rectangle("hullBar");
		this.hullBar.width = "100%";
		this.hullBar.height = "10px";
		this.hullBar.color = "transparent";
		this.hullBar.background = "rgba(90,210,120,0.95)";
		this.hullBar.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		this.hullBar.cornerRadius = 3;
		barHost.addControl(this.hullBar);

		this.hullText = mkText("Hull 100%", 12, "#bfe8c8", false);
		this.hullText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		stack.addControl(this.hullText);

		this.speedText = mkText("0.0 kn", 12, "#a9c6de", false);
		this.speedText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		stack.addControl(this.speedText);

		// ---- Left: off-chain ledger (purse, faction standing, ghost fleet) ----
		this.purseText = mkText("Hold 0 · Purse 0", 12, "#ffe6a8", false);
		this.purseText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		stack.addControl(this.purseText);

		this.repText = mkText("Standing  P·0  N·0  M·0", 12, "#c9d6e6", false);
		this.repText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		stack.addControl(this.repText);

		this.fleetText = mkText("Fleet  0 dispatched", 12, "#c3d8ee", false);
		this.fleetText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		stack.addControl(this.fleetText);

		// ---- Gun reload progress: fills over the class's reloadSeconds after a
		// broadside, then hides. Driven by startReload() on fire + a per-frame tick
		// in update(); invisible while ready so it never clutters the status panel.
		this.reloadHost = new Rectangle("reloadHost");
		this.reloadHost.height = "10px";
		this.reloadHost.width = "200px";
		this.reloadHost.color = "rgba(0,0,0,0.6)";
		this.reloadHost.background = "rgba(40,30,12,0.9)";
		this.reloadHost.thickness = 1;
		this.reloadHost.cornerRadius = 4;
		this.reloadHost.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
		this.reloadHost.isVisible = false;
		stack.addControl(this.reloadHost);
		this.reloadFill = new Rectangle("reloadFill");
		this.reloadFill.width = "0px";
		this.reloadFill.height = "8px";
		this.reloadFill.color = "transparent";
		this.reloadFill.background = "#e6c079";
		this.reloadFill.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		this.reloadFill.cornerRadius = 3;
		this.reloadHost.addControl(this.reloadFill);
		this.reloadLabel = mkText("Reloading…", 11, "#e6c079", false);
		this.reloadLabel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		this.reloadLabel.isVisible = false;
		stack.addControl(this.reloadLabel);

		// ---- Bottom-centre: heading + wind bearing ------------------------
		const bottom = new StackPanel("bottom");
		bottom.isVertical = false;
		bottom.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		bottom.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
		bottom.paddingBottom = "18px";
		bottom.width = "420px";
		this.ui.addControl(bottom);

		this.bearingText = mkText("HDG 000°", 16, "#dff0ff", true);
		this.bearingText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		this.bearingText.width = "150px";
		this.bearingText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		bottom.addControl(this.bearingText);

		this.windGlyph = mkText("↓ wind", 16, "#a9d0ff", true);
		this.windGlyph.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		this.windGlyph.width = "150px";
		this.windGlyph.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		bottom.addControl(this.windGlyph);

		// ---- Top-right: cargo / wind / weather ------------------------------
		// A vertical StackPanel (not three hand-padded controls) so the lines keep
		// even spacing as their text changes and never collide in a storm.
		const topRight = new StackPanel("topRight");
		topRight.isVertical = true;
		topRight.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
		topRight.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
		topRight.width = "260px";
		topRight.paddingRight = "18px";
		topRight.paddingTop = "58px";
		topRight.spacing = 10;
		this.ui.addControl(topRight);

		this.cargoText = mkText("Cargo 0", 14, "#ffe6a8", false);
		this.cargoText.width = "100%";
		this.cargoText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
		topRight.addControl(this.cargoText);

		this.windText = mkText("Wind 6 m/s", 14, "#cfe0ff", false);
		this.windText.width = "100%";
		this.windText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
		topRight.addControl(this.windText);

		this.weatherText = mkText("Fair skies", 14, "#bfe8c8", false);
		this.weatherText.width = "100%";
		this.weatherText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
		topRight.addControl(this.weatherText);

		// ---- Pause icon (top-right corner, above the readout cluster) --------
		// Always visible so touch players (no Esc key) can open the pause menu;
		// also clickable with a mouse.
		const pauseBtn = Button.CreateSimpleButton("pauseBtn", "⏸");
		pauseBtn.width = "40px";
		pauseBtn.height = "40px";
		pauseBtn.cornerRadius = 10;
		pauseBtn.background = "rgba(6,12,20,0.6)";
		pauseBtn.color = "#dff0ff";
		pauseBtn.fontSize = "20px";
		pauseBtn.thickness = 1;
		pauseBtn.paddingLeft = "0px";
		pauseBtn.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
		pauseBtn.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
		pauseBtn.paddingRight = "18px";
		pauseBtn.paddingTop = "12px";
		pauseBtn.onPointerClickObservable.add(() => this.onPausePressed?.());
		this.ui.addControl(pauseBtn);

		const mapBtn = Button.CreateSimpleButton("mapBtn", "🗺");
		mapBtn.width = "40px";
		mapBtn.height = "40px";
		mapBtn.cornerRadius = 10;
		mapBtn.background = "rgba(6,12,20,0.6)";
		mapBtn.color = "#dff0ff";
		mapBtn.fontSize = "18px";
		mapBtn.thickness = 1;
		mapBtn.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
		mapBtn.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
		mapBtn.paddingRight = "66px";
		mapBtn.paddingTop = "12px";
		mapBtn.onPointerClickObservable.add(() => this.toggleMap());
		this.ui.addControl(mapBtn);
		this.buildMap();

		this.statusText = mkText("Connecting…", 12, "#ff9b9b", false);
		this.statusText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
		this.statusText.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
		this.statusText.width = "260px";
		this.statusText.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
		this.statusText.paddingRight = "18px";
		this.statusText.paddingBottom = "18px";
		this.ui.addControl(this.statusText);

		// ---- Crosshair ----------------------------------------------------
		const cross = new TextBlock("cross", "+");
		cross.color = "rgba(255,255,255,0.55)";
		cross.fontSize = "26px";
		cross.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		cross.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
		this.ui.addControl(cross);

		// ---- Weapon arc label ------------------------------------------------
		// Names the gun arc the current aim would loose, sitting just above the
		// dock prompt so it never covers the crosshair. Tints by weapon: broadside
		// steel, fire ember, chain rigging-grey, swivel brass.
		const weaponPanel = new StackPanel("weaponPanel");
		weaponPanel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		weaponPanel.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
		weaponPanel.paddingBottom = "150px";
		this.weaponLabel = new TextBlock("weaponLabel", "");
		this.weaponLabel.fontSize = "16px";
		this.weaponLabel.color = "#cfe0e8";
		this.weaponLabel.isHitTestVisible = false;
		weaponPanel.addControl(this.weaponLabel);
		this.ui.addControl(weaponPanel);

		// ---- Docking prompt ------------------------------------------------
		this.dockPrompt = new StackPanel("dock");
		this.dockPrompt.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		this.dockPrompt.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
		this.dockPrompt.paddingBottom = "96px";
		this.dockPrompt.isVisible = false;
		// Being inside PORT_RADIUS already MEANS you're moored at the harbour, so
		// this never says "press E to dock" (which reads as "you aren't docked yet");
		// it names the harbour and the thing E actually does — open market & docks.
		this.dockText = mkText("Press E for market & docks", 16, "#ffe6a8", true);
		this.dockPrompt.addControl(this.dockText);
		this.ui.addControl(this.dockPrompt);

		// ---- Transient toast (on-chain confirmations, event notices) --------
		this.toastText = mkText("", 20, "#9be8ff", true);
		this.toastText.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		this.toastText.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
		this.toastText.paddingTop = "90px";
		this.toastText.shadowBlur = 3;
		this.toastText.shadowOffsetX = 2;
		this.toastText.shadowOffsetY = 2;
		this.toastText.shadowColor = "#000";
		this.toastText.isVisible = false;
		this.ui.addControl(this.toastText);

		// ---- Anti-cheat shield badge (bottom-right, above the net status) ----
		// Always visible so players know the authoritative server is policing
		// inputs. `securityEvent` pulses it green on a blocked cheat and flashes
		// it red when a hull is flagged. Explicit pixel size (never "auto").
		this.shield = new Rectangle("shield");
		this.shield.width = "236px";
		this.shield.height = "28px";
		this.shield.cornerRadius = 14;
		this.shield.color = "rgba(120,235,150,0.85)";
		this.shield.background = "rgba(4,14,10,0.9)";
		this.shield.thickness = 1.5;
		this.shield.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
		this.shield.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
		this.shield.paddingRight = "18px";
		this.shield.paddingBottom = "48px";
		this.ui.addControl(this.shield);

		this.shieldLabel = new TextBlock("shieldLabel", "🛡  ANTI-CHEAT ACTIVE");
		this.shieldLabel.fontSize = "14px";
		this.shieldLabel.fontWeight = "bold";
		this.shieldLabel.color = "#c9ffe0";
		this.shieldLabel.width = "100%";
		this.shieldLabel.height = "100%";
		this.shieldLabel.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		this.shieldLabel.shadowBlur = 3;
		this.shieldLabel.shadowOffsetX = 1;
		this.shieldLabel.shadowOffsetY = 1;
		this.shieldLabel.shadowColor = "rgba(0,0,0,1)";
		this.shield.addControl(this.shieldLabel);

		// ---- Top-centre compass strip ---------------------------------------
		// A GUI control cannot rotate, so instead of a spinning rose this is a
		// scrolling strip: the eight compass points are repositioned every frame by
		// `marginLeft` from the hull's heading, sliding past a fixed centre pointer
		// — the same mental model as an FPS compass bar, and it keeps the "bow = up"
		// readout consistent with the HDG number at the bottom.
		this.compassHost = new Rectangle("compass");
		this.compassHost.width = `${GameUi.COMPASS_STRIP_W}px`;
		this.compassHost.height = "30px";
		this.compassHost.cornerRadius = 6;
		this.compassHost.color = "rgba(180,210,235,0.30)";
		this.compassHost.background = "rgba(6,12,20,0.42)";
		this.compassHost.thickness = 1;
		this.compassHost.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		this.compassHost.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
		this.compassHost.paddingTop = "14px";
		this.ui.addControl(this.compassHost);

		const centreTick = mkText("▼", 13, "#ffe6a8", true);
		centreTick.width = `${GameUi.COMPASS_STRIP_W}px`;
		centreTick.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		this.compassHost.addControl(centreTick);

		const CARDINALS: [string, number, string][] = [
			["N", 0, "#eafff0"], ["NE", 45, "#9fb6cc"], ["E", 90, "#eafff0"], ["SE", 135, "#9fb6cc"],
			["S", 180, "#eafff0"], ["SW", 225, "#9fb6cc"], ["W", 270, "#eafff0"], ["NW", 315, "#9fb6cc"],
		];
		for (const [name, deg, col] of CARDINALS) {
			const t = mkText(name, 14, col, true);
			t.width = "28px";
			t.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
			t.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
			this.compassHost.addControl(t);
			this.compassTicks.push({ label: t, deg });
		}

		// Port waypoint: a gold ⚓ that rides the same sliding strip as the cardinals
		// but tracks the bearing to the nearest harbour, not a fixed compass point.
		// It slides off the strip when the port is astern, exactly like a cardinal.
		this.portWaypoint = mkText("⚓", 16, "#ffd27a", true);
		this.portWaypoint.width = "28px";
		this.portWaypoint.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		this.portWaypoint.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		this.portWaypoint.shadowBlur = 4;
		this.portWaypoint.shadowColor = "#000";
		this.portWaypoint.isVisible = false;
		this.compassHost.addControl(this.portWaypoint);

		// ---- Bottom-left: pirate compass rose -------------------------------
		// A north-seeking rose: the golden card spins so its North point always
		// aims at true north while the fixed lubber mark at the top is the bow
		// (screen-up = heading). Unlike the top strip this is a real dial, and the
		// `rotation` setter on a GUI control lets it turn freely. The rose PNG had
		// its black backing knocked out to alpha so it floats over the sea.
		this.compassRoseHost = new Rectangle("compassRoseHost");
		this.compassRoseHost.width = "156px";
		this.compassRoseHost.height = "156px";
		this.compassRoseHost.cornerRadius = 78;
		this.compassRoseHost.background = "rgba(6,12,20,0.4)";
		this.compassRoseHost.color = "rgba(206,176,96,0.4)";
		this.compassRoseHost.thickness = 1;
		this.compassRoseHost.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		this.compassRoseHost.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
		this.compassRoseHost.paddingLeft = "20px";
		this.compassRoseHost.paddingBottom = "20px";
		this.ui.addControl(this.compassRoseHost);

		this.compassRose = new Image("compassRose", asset("/ui/compass_rose_alpha.png"));
		this.compassRose.width = "140px";
		this.compassRose.height = "140px";
		this.compassRose.isVisible = false;
		this.compassRoseHost.addControl(this.compassRose);

		// Fixed lubber line: the direction the bow is pointing, read off the card.
		const lubber = mkText("▲", 13, "#ffe6a8", true);
		lubber.width = "156px";
		lubber.height = "16px";
		lubber.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		lubber.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
		this.compassRoseHost.addControl(lubber);

		// ---- Most-Wanted marquee (live head-hunting board) ------------------
		// A left-centre bounty poster. Fixed pixel size (never "auto"), rebuilt
		// only when the board changes. Empty state stays hidden until the server
		// posts a live bounty.
		this.wantedStack = new StackPanel("wanted");
		this.wantedStack.isVertical = true;
		this.wantedStack.width = "220px";
		this.wantedStack.spacing = 3;
		this.wantedStack.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		this.wantedStack.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
		this.wantedStack.paddingLeft = "18px";
		this.wantedStack.isVisible = false;
		this.ui.addControl(this.wantedStack);

		// ---- Buried-cache world markers (off-chain POIs) --------------------
		for (const poi of POI_DEFS) {
			const anchor = new Mesh(`poi_${poi.id}`, this.scene);
			anchor.isVisible = false;
			anchor.position.set(poi.x, 3, poi.z);
			const tag = new Rectangle(`poimk_${poi.id}`);
			tag.width = "80px";
			tag.height = "20px";
			tag.color = "transparent";
			tag.background = "rgba(0,0,0,0)";
			tag.thickness = 0;
			this.ui.addControl(tag);
			tag.linkWithMesh(anchor);
			tag.linkOffsetY = -22;
			const lbl = mkText("✦ Cache", 13, "#ffd97a", true);
			lbl.width = "80px";
			lbl.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
			tag.addControl(lbl);
			this.poiMarkers.set(poi.id, { anchor, panel: tag });
		}

		// ---- Trading-port markers (the canonical docking anchors) -----------
		for (const port of PORT_DEFS) {
			const anchor = new Mesh(`port_${port.id}`, this.scene);
			anchor.isVisible = false;
			anchor.position.set(port.x, 6, port.z);
			const tag = new Rectangle(`portmk_${port.id}`);
			tag.width = "150px";
			tag.height = "22px";
			tag.color = "transparent";
			tag.background = "rgba(0,0,0,0)";
			tag.thickness = 0;
			this.ui.addControl(tag);
			tag.linkWithMesh(anchor);
			tag.linkOffsetY = -24;
			const lbl = mkText(`⚓ ${port.name}`, 14, "#8fe0ff", true);
			lbl.width = "150px";
			lbl.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
			tag.addControl(lbl);
			this.portMarkers.push({ anchor, panel: tag });
		}
	}

	/** Reflect a player's off-chain ledger (called on player:state, not per-frame). */
	setPlayer(state: PlayerPublicState, hold: number): void {
		this.purseText.text = `Hold ${hold} · Purse ${state.purse}`;
		this.repText.text =
			`Standing  P·${state.reputation.pirate}  N·${state.reputation.naval}  M·${state.reputation.merchant}`;
		this.fleetText.text = `Fleet  ${state.fleet.length} dispatched`;
	}

	/** Rebuild the Most-Wanted marquee from the live bounty board (top 3 heads). */
	setWanted(wanted: WantedEntry[]): void {
		this.wantedStack.children.slice().forEach((c) => c.dispose());
		if (wanted.length === 0) {
			this.wantedStack.isVisible = false;
			return;
		}
		this.wantedStack.isVisible = true;
		const title = mkText("☠  MOST WANTED", 15, "#ff9b9b", true);
		title.width = "100%";
		this.wantedStack.addControl(title);
		for (const w of wanted.slice(0, 3)) {
			const spec = SHIP_CLASSES[w.shipClass];
			const head = mkText(w.name.length > 22 ? `${w.name.slice(0, 21)}…` : w.name, 13, "#ffd98a", false);
			head.width = "100%";
			this.wantedStack.addControl(head);
			const price = mkText(`${formatUsdg(BigInt(w.amount))} USDG · ${spec.label}`, 12, "#cfe0ff", false);
			price.width = "100%";
			this.wantedStack.addControl(price);
		}
	}

	/** A cache was dug somewhere in the world: drop its marker for everyone. */
	markPoiClaimed(id: number): void {
		const mk = this.poiMarkers.get(id);
		if (!mk) return;
		mk.panel.dispose();
		mk.anchor.dispose();
		this.poiMarkers.delete(id);
	}

	/**
	 * Reconcile the salvage debris-field markers with the live snapshot: add a
	 * marker for every newly-sighted wreck and drop any whose field is gone (dove
	 * or scattered). A wreck sits still once it spawns, so existing markers need no
	 * per-frame update — only the membership changes.
	 */
	setWrecks(wrecks: Wreck[]): void {
		const seen = new Set<number>();
		for (const w of wrecks) {
			seen.add(w.id);
			if (this.wreckMarkers.has(w.id)) continue;
			const anchor = new Mesh(`wreck_${w.id}`, this.scene);
			anchor.isVisible = false;
			anchor.position.set(w.x, 2, w.z);
			const tag = new Rectangle(`wreckmk_${w.id}`);
			tag.width = "120px";
			tag.height = "20px";
			tag.color = "transparent";
			tag.background = "rgba(0,0,0,0)";
			tag.thickness = 0;
			this.ui.addControl(tag);
			tag.linkWithMesh(anchor);
			tag.linkOffsetY = -22;
			const lbl = mkText(`☠ Wreck · ${w.cargo}`, 13, "#b9a67f", true);
			lbl.width = "120px";
			lbl.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
			tag.addControl(lbl);
			this.wreckMarkers.set(w.id, { anchor, panel: tag });
		}
		for (const [id, m] of this.wreckMarkers) {
			if (seen.has(id)) continue;
			m.panel.dispose();
			m.anchor.dispose();
			this.wreckMarkers.delete(id);
		}
	}

	/** A wreck was dove or scattered: drop just that marker (the salver toasts). */
	markWreckGone(id: number): void {
		const mk = this.wreckMarkers.get(id);
		if (!mk) return;
		mk.panel.dispose();
		mk.anchor.dispose();
		this.wreckMarkers.delete(id);
	}

	/** DEV ONLY: force a sample salvage-wreck marker ahead of the hull. */
	debugWreck(on = true): void {
		this.debugWreckActive = on;
		if (!on && this.debugWreckMk) {
			this.debugWreckMk.panel.dispose();
			this.debugWreckMk.anchor.dispose();
			this.debugWreckMk = null;
		}
	}

	/** DEV ONLY: force every rival marker to display a sample ⚔ badge. */
	debugBadges(on = true): void {
		this.debugBadgesActive = on;
	}

	// ---- World map ----------------------------------------------------------

	/** Build the north-up chart overlay once: a framed panel with a self dot and
	 *  static port/cache dots, plus pools for the live ships and wrecks. The whole
	 *  panel is hidden until the floating 🗺 icon (or `toggleMap`) opens it. */
	private buildMap(): void {
		const FRAME = 512;
		const HALF = GameUi.MAP_HALF;
		const C = FRAME / 2;
		const R = WORLD_SEA_RADIUS;
		const px = (x: number) => C + (x / R) * HALF;

		this.mapFrame = new Rectangle("mapFrame");
		this.mapFrame.width = `${FRAME}px`;
		this.mapFrame.height = `${FRAME}px`;
		this.mapFrame.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		this.mapFrame.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
		this.mapFrame.background = "rgba(4,10,18,0.93)";
		this.mapFrame.color = "#c9a24b";
		this.mapFrame.thickness = 2;
		this.mapFrame.cornerRadius = 14;
		this.mapFrame.isVisible = false;
		this.mapFrame.zIndex = 50;
		this.ui.addControl(this.mapFrame);

		// A faint horizon ring so the playable disc reads as a map, not a void.
		const ring = new Rectangle("mapRing");
		ring.width = `${HALF * 2}px`;
		ring.height = `${HALF * 2}px`;
		ring.cornerRadius = HALF;
		ring.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		ring.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
		ring.background = "transparent";
		ring.color = "rgba(120,170,210,0.25)";
		ring.thickness = 1;
		this.mapFrame.addControl(ring);

		const title = mkText("CHART OF THE SEA", 16, "#e6c877", true);
		title.width = "100%";
		title.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		title.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
		title.paddingTop = "14px";
		title.zIndex = 12;
		this.mapFrame.addControl(title);

		const legend = mkText("◉ you   ▪ port   ⚑ cache   ▫ ship   ☠ wreck   ▨ unexplored", 11, "#8aa3bd", false);
		legend.width = "100%";
		legend.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		legend.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
		legend.paddingBottom = "12px";
		legend.zIndex = 12;
		this.mapFrame.addControl(legend);

		// Static port markers + names (constant, so built once).
		const dot = (size: number, color: string, round: boolean) => {
			const d = new Rectangle("mapdot");
			d.width = `${size}px`;
			d.height = `${size}px`;
			d.cornerRadius = round ? size : 2;
			d.background = color;
			d.color = "transparent";
			d.thickness = 0;
			d.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
			d.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
			this.mapFrame.addControl(d);
			return d;
		};

		for (const p of PORT_DEFS) {
			const d = dot(12, "#e0b34a", false);
			d.left = `${px(p.x) - 6}px`;
			d.top = `${px(p.z) - 6}px`;
			d.zIndex = 1;
			const lbl = mkText(p.name, 10, "#f0d493", false);
			lbl.width = "90px";
			lbl.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
			lbl.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
			lbl.left = `${px(p.x) + 8}px`;
			lbl.top = `${px(p.z) - 8}px`;
			lbl.zIndex = 1;
			this.mapFrame.addControl(lbl);
			this.mapPortDots.push({ d, lbl, poiId: `port:${p.id}` });
		}
		for (const poi of POI_DEFS) {
			const d = dot(6, poi.kind === "rare" ? "#c58bff" : "#d8d0a6", true);
			d.left = `${px(poi.x) - 3}px`;
			d.top = `${px(poi.z) - 3}px`;
			d.zIndex = 1;
			this.mapCacheDots.push({ d, poiId: `cache:${poi.id}` });
		}

		// Self dot + a forward tick, repositioned each refresh. Raised above the
		// veil (zIndex 8) so "you are here" always reads, even in dark water.
		this.mapSelfTick = dot(4, "#bfe8c8", false);
		this.mapSelfDot = dot(12, "#5ad278", true);
		this.mapSelfTick.zIndex = 8;
		this.mapSelfDot.zIndex = 8;

		// Live ship pool.
		for (let i = 0; i < 48; i++) {
			const d = dot(8, "#e6e6e6", true);
			d.isVisible = false;
			d.zIndex = 6;
			this.mapShipDots.push(d);
		}
		// Wreck pool.
		for (let i = 0; i < 12; i++) {
			const d = dot(8, "#b9a67f", true);
			d.isVisible = false;
			d.zIndex = 6;
			this.mapWreckDots.push(d);
		}

		// ---- Fog of war: one dark veil cell per on-disc sector ----------------
		// Built from the same world→pixel mapping as the dots. Each cell sits at
		// zIndex 4 (over the base dots, under the self dot). `refreshMap` toggles
		// `isVisible` off for discovered sectors, so the chart fills in as the
		// player explores. Revert this block + the import to drop the feature.
		this.fog = new FogOfWarSystem();
		const S = this.fog.sectorSize;
		const cellPx = (S / R) * HALF;
		for (const sec of this.fog.sectors()) {
			const veil = new Rectangle("mapVeil");
			veil.width = `${cellPx + 0.5}px`;
			veil.height = `${cellPx + 0.5}px`;
			veil.background = "rgba(2,6,12,0.82)";
			veil.color = "rgba(70,110,150,0.12)";
			veil.thickness = 1;
			veil.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
			veil.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
			veil.left = `${px(sec.cx) - cellPx / 2}px`;
			veil.top = `${px(sec.cz) - cellPx / 2}px`;
			veil.zIndex = 4;
			veil.isPointerBlocker = false;
			this.mapFrame.addControl(veil);
			this.veilCells.push({ d: veil, key: sec.key });
		}
	}

	toggleMap(): void {
		this.mapOpen = !this.mapOpen;
		this.mapFrame.isVisible = this.mapOpen;
	}

	isMapOpen(): boolean {
		return this.mapOpen;
	}

	/** Reposition every live dot while the chart is open. Called each frame. */
	private refreshMap(inp: UiInput): void {
		if (!this.mapOpen) return;
		const self = inp.selfState;
		if (!self) return;
		const FRAME = 512;
		const HALF = GameUi.MAP_HALF;
		const C = FRAME / 2;
		const R = WORLD_SEA_RADIUS;
		const px = (x: number) => C + (x / R) * HALF;

		this.mapSelfDot.left = `${px(self.position.x) - 6}px`;
		this.mapSelfDot.top = `${px(self.position.z) - 6}px`;
		// A tick nudged forward along the hull's heading (world forward = sin,cos).
		const ahead = { x: self.position.x + Math.sin(self.heading) * (R * 0.03), z: self.position.z + Math.cos(self.heading) * (R * 0.03) };
		this.mapSelfTick.left = `${px(ahead.x) - 2}px`;
		this.mapSelfTick.top = `${px(ahead.z) - 2}px`;

		const selfOwner = self.ownerAddress?.toLowerCase();
		let n = 0;
		for (const st of inp.states) {
			if (st.id === self.id || st.status !== "active") continue;
			if (n >= this.mapShipDots.length) break;
			const d = this.mapShipDots[n++];
			d.isVisible = true;
			d.background =
				st.ownerAddress && st.ownerAddress.toLowerCase() === selfOwner
					? "#7fb0ff"
					: st.ownerAddress
						? "#e07a7a"
						: "#9aa7b4";
			d.left = `${px(st.position.x) - 4}px`;
			d.top = `${px(st.position.z) - 4}px`;
		}
		for (let i = n; i < this.mapShipDots.length; i++) this.mapShipDots[i].isVisible = false;

		let w = 0;
		for (const [, mk] of this.wreckMarkers) {
			if (w >= this.mapWreckDots.length) break;
			const d = this.mapWreckDots[w++];
			d.isVisible = true;
			d.left = `${px(mk.anchor.position.x) - 4}px`;
			d.top = `${px(mk.anchor.position.z) - 4}px`;
		}
		for (let i = w; i < this.mapWreckDots.length; i++) this.mapWreckDots[i].isVisible = false;

		// ---- Fog of war: reveal the chart around the hull + nearby POIs -------
		// `update` is cheap (bounded sector scan + a handful of POIs), so it runs
		// every frame the map is open. Discovered sectors lift their veil cell, and
		// an unexplored port/cache hides its marker so the dark stays dark.
		if (this.fog) {
			this.fog.update(self.position.x, self.position.z);
			for (const cell of this.veilCells) {
				cell.d.isVisible = !this.fog.isDiscovered(cell.key);
			}
			for (const pd of this.mapPortDots) {
				const on = this.fog.isPoiRevealed(pd.poiId);
				pd.d.isVisible = on;
				pd.lbl.isVisible = on;
			}
			for (const cd of this.mapCacheDots) {
				cd.d.isVisible = this.fog.isPoiRevealed(cd.poiId);
			}
		}
	}

	/** Show a fading toast near the top-centre. Used for USDG settle events. */
	toast(message: string, color = "#9be8ff", ms = 4200): void {
		this.toastText.text = message;
		this.toastText.color = color;
		this.toastText.isVisible = true;
		if (this.toastTimer) clearTimeout(this.toastTimer);
		this.toastTimer = setTimeout(() => {
			this.toastText.isVisible = false;
		}, ms);
	}

	/**
	 * React to a server anti-cheat notice. A `blocked` (an illegal input was
	 * clamped/rolled back) briefly pulses the shield green and names what was
	 * stopped; a `flagged` (a hull crossed the suspicion line) flashes it red and
	 * toasts the offender, so every player sees the sea being policed.
	 */
	securityEvent(evt: SecurityEvent): void {
		if (evt.t === "flagged") {
			this.setShield("⚠  CHEATER DETECTED", "#ff8a8a", "rgba(46,8,12,0.9)", 1600);
			this.toast(`⚠ ${evt.shipName} flagged for cheating`, "#ff8a8a", 4200);
			return;
		}
		const what = evt.reason ? REASON_TEXT[evt.reason] : "illegal input";
		this.setShield(`🛡  BLOCKED · ${what}`, "#eafff2", "rgba(12,44,26,0.9)", 1100);
	}

	/** Override the shield's look, then restore the calm default after `ms`. */
	private setShield(text: string, color: string, bg: string, ms: number): void {
		this.shieldLabel.text = text;
		this.shieldLabel.color = color;
		this.shield.color = color;
		this.shield.background = bg;
		if (this.shieldResetTimer) clearTimeout(this.shieldResetTimer);
		this.shieldResetTimer = setTimeout(() => {
			this.shieldLabel.text = "🛡  ANTI-CHEAT ACTIVE";
			this.shieldLabel.color = "#c9ffe0";
			this.shield.color = "rgba(120,235,150,0.85)";
			this.shield.background = "rgba(4,14,10,0.9)";
		}, ms);
	}

	/** Begin a reload readout of `durationSeconds` (called when a broadside fires). */
	startReload(durationSeconds: number): void {
		this.reloadTotal = Math.max(0.1, durationSeconds);
		this.reloadEndsAt = performance.now() + this.reloadTotal * 1000;
		this.reloadHost.isVisible = true;
		this.reloadLabel.isVisible = true;
	}

	update(inp: UiInput, classify: (s: ShipState) => ShipClass3): void {
		// Gun reload bar: fills left→right over the run-out, then hides when ready.
		{
			const rem = (this.reloadEndsAt - performance.now()) / 1000;
			if (rem > 0) {
				const ratio = 1 - rem / this.reloadTotal;
				this.reloadFill.width = `${Math.round(ratio * 198)}px`;
				this.reloadLabel.text = `Reloading ${rem.toFixed(1)}s`;
			} else if (this.reloadHost.isVisible) {
				this.reloadHost.isVisible = false;
				this.reloadLabel.isVisible = false;
			}
		}
		const self = inp.selfState;
		if (self) {
			const spec = SHIP_CLASSES[self.shipClass];
			this.className.text = spec.label;
			this.className.isVisible = true;

			const ratio = Math.max(0, Math.min(1, self.hull / spec.hullMax));
			this.hullBar.width = `${Math.round(ratio * 200)}px`;
			this.hullBar.background =
				ratio > 0.6 ? "rgba(90,210,120,0.95)" : ratio > 0.3 ? "rgba(230,180,70,0.95)" : "rgba(220,80,70,0.95)";
			this.hullText.text = `Hull ${Math.max(0, Math.ceil(self.hull))} / ${spec.hullMax}`;

			const spd = Math.hypot(self.velocity.x, self.velocity.z);
			// World units are metres, so `spd` is m/s; ×3.6 gives km/h — the same
			// scale the identification-marker distances (metres) are reported in.
			this.speedText.text = `${(spd * 3.6).toFixed(1)} km/h`;

			this.cargoText.text = `Cargo ${self.cargo} / ${spec.cargoCapacity}`;
		}

		// Heading + wind bearing read off compass roses as glyphs, since a GUI
		// control cannot rotate — the arrow shows the direction the breeze blows
		// TOWARD, and the number gives the exact heading for gunnery.
		if (self) {
			const deg = ((self.heading * 180) / Math.PI + 360) % 360;
			this.bearingText.text = `HDG ${deg.toFixed(0).padStart(3, "0")}°`;
			// Spin the rose so its North aims at true north relative to the bow.
			this.compassRose.rotation = -deg;
			this.compassRose.isVisible = true;
		} else {
			this.compassRose.isVisible = false;
		}
		const windDeg = (Math.atan2(inp.weather.wind.x, inp.weather.wind.z) * 180) / Math.PI;
		this.windGlyph.text = `${arrowFor(windDeg)} wind`;
		this.windText.text = `Wind ${inp.weather.windSpeed.toFixed(0)} m/s`;

		// ---- Compass strip: slide the cardinals against the hull's heading ----
		const headingDeg = self ? ((self.heading * 180) / Math.PI + 360) % 360 : null;
		if (headingDeg === null) {
			for (const tick of this.compassTicks) tick.label.isVisible = false;
			if (this.portWaypoint) this.portWaypoint.isVisible = false;
		} else {
			const half = GameUi.COMPASS_STRIP_W / 2;
			const pxPerDeg = half / GameUi.COMPASS_SPAN_DEG;
			for (const tick of this.compassTicks) {
				// Relative bearing of this point from the bow, wrapped to [-180,180).
				const rel = ((tick.deg - headingDeg + 540) % 360) - 180;
				if (Math.abs(rel) > GameUi.COMPASS_SPAN_DEG) {
					tick.label.isVisible = false;
					continue;
				}
				tick.label.isVisible = true;
				// Offset from the strip's centre: a centre-aligned control slides by
				// its `leftInPixels`, so the cardinals pan past the fixed pointer.
				tick.label.leftInPixels = rel * pxPerDeg;
				// Cardinal points read brighter the closer they are to the bow.
				tick.label.alpha = 1 - Math.abs(rel) / (GameUi.COMPASS_SPAN_DEG * 1.4);
			}
			// Slide the harbour waypoint by the same rule, but off the live bearing to
			// the nearest port; wrap it to the far edge so the player knows to turn
			// around when the port is astern rather than losing the marker entirely.
			if (this.portWaypoint && inp.portBearing !== null) {
				const rel = ((inp.portBearing - headingDeg + 540) % 360) - 180;
				const span = GameUi.COMPASS_SPAN_DEG;
				const clamped = Math.max(-span, Math.min(span, rel));
				this.portWaypoint.isVisible = true;
				this.portWaypoint.leftInPixels = clamped * pxPerDeg;
				this.portWaypoint.alpha = rel > span || rel < -span ? 0.6 : 1;
			} else if (this.portWaypoint) {
				this.portWaypoint.isVisible = false;
			}
		}

		const w = inp.weather;
		if (w.rainIntensity > 0.5 || w.waveAmplitude > 1.7) {
			this.weatherText.text = "Storm — hold on";
			this.weatherText.color = "#ff9b9b";
		} else if (w.waveAmplitude > 1.1) {
			this.weatherText.text = "Choppy seas";
			this.weatherText.color = "#ffe6a8";
		} else {
			this.weatherText.text = "Fair skies";
			this.weatherText.color = "#bfe8c8";
		}

		this.statusText.text = inp.connected ? "◉ Live · synced" : "○ Reconnecting…";
		this.statusText.color = inp.connected ? "#8fe0b0" : "#ff9b9b";

		this.dockPrompt.isVisible = inp.nearestPort !== null;
		if (inp.nearestPort) this.dockText.text = `⚓ ${inp.nearestPort} — press E for market & docks`;

		// ---- Gun + payload indicator -------------------------------------
		// Reflect the bow-relative arc the crosshair is on AND the shot loaded into
		// it, so the captain sees both the gun coming to bear and the kinds of fire
		// riding it before he discharges. Greyed in a harbour — a safe zone.
		{
			const w = WEAPONS[inp.weapon];
			const arcColor =
				inp.weapon === "broadside" ? "#cfe0e8"
				: inp.weapon === "chain" ? "#aeb6bb"
				: inp.weapon === "fire" ? "#ff8a4c"
				: "#ffd27a"; // swivel
			const heated = AMMO[inp.ammo].ignites ? " · hot" : "";
			if (inp.safeZone) {
				this.weaponLabel.text = "☮ Safe harbour — guns run cold";
				this.weaponLabel.color = "#9be8ff";
			} else {
				this.weaponLabel.text = `${w.label} · ${AMMO[inp.ammo].label} — aimed${heated}`;
				this.weaponLabel.color = arcColor;
			}
			this.weaponLabel.isVisible = inp.connected && inp.selfState !== null && inp.selfState.status === "active";
		}

		// ---- Identification markers --------------------------------------
		const selfPos = inp.selfState ? inp.selfState.position : null;
		const seen = new Set<string>();
		for (const st of inp.states) {
			if (st.id === inp.selfId) continue; // own hull gets its own dedicated bar below
			seen.add(st.id);
			let mk = this.markers.get(st.id);
			if (!mk) mk = this.makeMarker(st.id);
			const tier = classify(st);
			const spec = SHIP_CLASSES[st.shipClass];
			const col = tier === "ally" ? "#7fb0ff" : tier === "self" ? "#8fe0b0" : "#e6e6e6";
			const r = Math.max(0, Math.min(1, st.hull / spec.hullMax));
			// Health drives the bar colour (green/amber/red); a sunk hull greys out.
			const hpCol = st.status === "active"
				? r > 0.6 ? "#5ad278" : r > 0.3 ? "#e6b446" : "#dc5046"
				: "rgba(120,120,120,0.7)";
			mk.label.text = `${st.name}  ${Math.max(0, Math.ceil(st.hull))}/${spec.hullMax}`;
			mk.label.color = col;
			const dist = selfPos ? Math.round(Math.hypot(st.position.x - selfPos.x, st.position.z - selfPos.z)) : 0;
			const shownKills = st.kills && st.kills > 0 ? st.kills : this.debugBadgesActive ? 3 : 0;
			mk.sub.text = `${spec.label}  ·  ${dist}m${shownKills > 0 ? `  ·  ⚔ ${shownKills}` : ""}`;
			mk.bar.width = `${Math.round(r * 120)}px`;
			mk.bar.background = hpCol;
			// Anchor tracks the authoritative hull position (snapshots, 20 Hz).
			const anchor = this.anchors.get(st.id);
			if (anchor) anchor.position.set(st.position.x, 6, st.position.z);
		}
		for (const [id] of this.markers) {
			if (!seen.has(id)) this.removeMarker(id);
		}

		// ---- Own floating hull bar ---------------------------------------
		// Your hull was the one ship with no in-world marker; the chase cam hides
		// it, so a bar that tracks the hull makes your own damage legible at a
		// glance and mirrors how every other ship reads.
		if (inp.selfState) {
			if (!this.selfMk) this.selfMk = this.createMarker("__self__");
			const spec = SHIP_CLASSES[inp.selfState.shipClass];
			const r = Math.max(0, Math.min(1, inp.selfState.hull / spec.hullMax));
			const mk = this.selfMk;
			mk.panel.isVisible = true;
			mk.label.text = `You  ${Math.max(0, Math.ceil(inp.selfState.hull))}/${spec.hullMax}`;
			mk.label.color = "#8fe0b0";
			mk.sub.text = `${spec.label}${inp.selfState.kills && inp.selfState.kills > 0 ? `  ·  ⚔ ${inp.selfState.kills}` : ""}`;
			mk.bar.width = `${Math.round(r * 120)}px`;
			mk.bar.background = r > 0.6 ? "#5ad278" : r > 0.3 ? "#e6b446" : "#dc5046";
			const anchor = this.anchors.get("__self__");
			if (anchor) anchor.position.set(inp.selfState.position.x, 7, inp.selfState.position.z);
		} else if (this.selfMk) {
			this.selfMk.panel.isVisible = false;
		}

		// ---- DEV ONLY: sticky sample wreck ahead of the hull ----------------
		if (this.debugWreckActive && inp.selfState) {
			if (!this.debugWreckMk) {
				const anchor = new Mesh("wreck_debug", this.scene);
				anchor.isVisible = false;
				const tag = new Rectangle("wreckmk_debug");
				tag.width = "120px";
				tag.height = "20px";
				tag.color = "transparent";
				tag.background = "rgba(0,0,0,0)";
				tag.thickness = 0;
				this.ui.addControl(tag);
				tag.linkWithMesh(anchor);
				tag.linkOffsetY = -22;
				const lbl = mkText("☠ Wreck · 14", 13, "#b9a67f", true);
				lbl.width = "120px";
				lbl.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
				tag.addControl(lbl);
				this.debugWreckMk = { anchor, panel: tag };
			}
			const p = inp.selfState.position;
			const h = inp.selfState.heading;
			this.debugWreckMk.anchor.position.set(p.x + Math.sin(h) * 55, 2, p.z + Math.cos(h) * 55);
		} else if (!this.debugWreckActive && this.debugWreckMk) {
			this.debugWreckMk.panel.dispose();
			this.debugWreckMk.anchor.dispose();
			this.debugWreckMk = null;
		}

		this.refreshMap(inp);
	}

	private createMarker(id: string): Marker {
		const anchor = new Mesh(`anchor_${id}`, this.scene);
		anchor.isVisible = false;
		this.anchors.set(id, anchor);

		const panel = new Rectangle(`mk_${id}`);
		panel.width = "150px";
		panel.height = "46px";
		panel.color = "transparent";
		panel.background = "rgba(0,0,0,0)";
		panel.thickness = 0;
		this.ui.addControl(panel);
		panel.linkWithMesh(anchor);
		panel.linkOffsetY = -52;

		const s = new StackPanel();
		s.isVertical = true;
		s.width = "100%";
		s.height = "100%";
		s.verticalAlignment = Control.VERTICAL_ALIGNMENT_TOP;
		panel.addControl(s);

		const barHost = new Rectangle();
		barHost.width = "120px";
		barHost.height = "5px";
		barHost.background = "rgba(0,0,0,0.6)";
		barHost.cornerRadius = 2;
		barHost.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		s.addControl(barHost);
		const bar = new Rectangle();
		bar.height = "4px";
		bar.width = "120px";
		bar.color = "transparent";
		bar.background = "#e6e6e6";
		bar.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		bar.cornerRadius = 2;
		barHost.addControl(bar);

		const label = mkText("", 12, "#e6e6e6", true);
		label.width = "150px";
		label.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		s.addControl(label);

		const sub = mkText("", 10, "#a9c6de", false);
		sub.width = "150px";
		sub.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		s.addControl(sub);

		return { panel, bar, label, sub };
	}

	private makeMarker(id: string): Marker {
		const mk = this.createMarker(id);
		this.markers.set(id, mk);
		return mk;
	}

	private removeMarker(id: string) {
		const mk = this.markers.get(id);
		if (mk) {
			mk.panel.dispose();
			this.markers.delete(id);
		}
		const anchor = this.anchors.get(id);
		if (anchor) {
			anchor.dispose();
			this.anchors.delete(id);
		}
	}

	dispose(): void {
		if (this.toastTimer) clearTimeout(this.toastTimer);
		if (this.shieldResetTimer) clearTimeout(this.shieldResetTimer);
		for (const [, mk] of this.markers) mk.panel.dispose();
		this.markers.clear();
		for (const [, a] of this.anchors) a.dispose();
		this.anchors.clear();
		for (const [, p] of this.poiMarkers) {
			p.panel.dispose();
			p.anchor.dispose();
		}
		this.poiMarkers.clear();
		for (const p of this.portMarkers) {
			p.panel.dispose();
			p.anchor.dispose();
		}
		this.portMarkers = [];
		for (const [, w] of this.wreckMarkers) {
			w.panel.dispose();
			w.anchor.dispose();
		}
		this.wreckMarkers.clear();
		this.compassHost.dispose();
		this.compassRoseHost.dispose();
		this.ui.dispose();
	}
}

function mkText(text: string, size: number, color: string, bold: boolean): TextBlock {
	const t = new TextBlock("t", text);
	// Floor the size so labels stay readable over a bright, noisy ocean.
	const s = Math.max(size, 14);
	t.fontSize = `${s}px`;
	t.color = color;
	// Bold every label: weight carries legibility far better than size against
	// the water, and thin 12px text was washing out entirely.
	t.fontWeight = "bold";
	t.height = `${s + 6}px`;
	t.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
	t.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
	// A small, OFFSET drop shadow: enough to lift the glyph off bright water
	// without the soft centered halo that a large blur produces (which read as
	// blurry). Directional offset keeps the letterforms crisp.
	t.shadowBlur = 3;
	t.shadowOffsetX = 2;
	t.shadowOffsetY = 2;
	t.shadowColor = "rgba(0,0,0,0.95)";
	return t;
}

/** Map a heading (deg, 0=N, clockwise) to a 4-way arrow glyph. */
function arrowFor(deg: number): string {
	const d = (deg + 360) % 360;
	if (d >= 315 || d < 45) return "↑";
	if (d < 135) return "→";
	if (d < 225) return "↓";
	return "←";
}
