import {
	Engine,
	Scene,
	Vector3,
	Color3,
	Color4,
	FreeCamera,
	HemisphericLight,
	DirectionalLight,
} from "@babylonjs/core";
import type { WeatherState, PlayerPublicState, ShipClass, WantedEntry, TradeListing } from "@shared/index";
import { OceanSystem, SUN_DIR } from "../ocean/OceanSystem";
import { WeatherSystem } from "../weather/WeatherSystem";
import { ShipManager } from "../entities/ShipManager";
import { IslandSystem } from "../world/IslandSystem";
import { FortSystem } from "../world/FortSystem";
import { NetworkClient } from "../net/NetworkClient";
import { Wallet } from "../wallet/Wallet";
import { formatUsdg } from "@shared/onchain";
import { PORT_DEFS, PORT_RADIUS, SHIP_CLASSES, WEAPONS, SAIL_GEARS, weaponForAim, AMMO, AMMO_KEYS, type WeaponType, type AmmoType } from "@shared/index";
import { CombatSystem } from "../combat/CombatSystem";
import { Vfx } from "../vfx/VfxLibrary";
import { GameUi } from "../ui/GameUi";
import { DockingMenu } from "../ui/DockingMenu";
import { PauseMenu } from "../ui/PauseMenu";
import { ParleyPrompt } from "../ui/ParleyPrompt";
import { FleetPrompt, type FleetHull } from "../ui/FleetPrompt";
import { SpyglassSystem } from "../ui/SpyglassSystem";
import { MobileControls } from "../ui/MobileControls";
import { InputManager } from "../input/InputManager";
import { AudioSystem } from "../audio/AudioSystem";
import { createPostProcess } from "./postProcess";
import { loadSettings, type GameSettings } from "../settings";

const WS_URL = process.env.NEXT_PUBLIC_WS_URL ?? "ws://localhost:9000";

const DEFAULT_WEATHER: WeatherState = {
	wind: { x: 1, z: 0 },
	windSpeed: 6,
	waveAmplitude: 0.6,
	fogDensity: 0.002,
	rainIntensity: 0,
	cloudCoverage: 0.3,
	lightningFrequency: 0,
};

/**
 * Game-level phase driven by the (React) menu shell around the engine.
 * `joining` is the waiting window between the Set Sail click and the server's
 * `welcome`: the world is decoded and the socket is open, but we haven't been
 * handed a ship yet. The DOM shows a waiting screen over the (still hidden)
 * canvas, which also doubles as a buffer if the server is slow/overloaded.
 */
export type GamePhase = "booting" | "menu" | "joining" | "playing";

export interface GameOpts {
	/** Fired once the first frame has rendered — the loading bar may complete. */
	onReady?: () => void;
	/** Called whenever the booting/menu/playing phase changes. */
	onPhase?: (phase: GamePhase) => void;
	/**
	 * The in-world (Babylon) pause menu asks the DOM shell to open one of its
	 * panels; the game itself never draws settings/help.
	 */
	onRequestOverlay?: (name: "settings" | "howto" | "faucet") => void;
	/**
	 * The in-world pause menu's "Merchant / Shop" button asks the DOM shell to
	 * raise the dedicated Shop page (the game stays paused behind it). The world
	 * never draws the market itself — it lives in React with the store artwork.
	 */
	onOpenShop?: () => void;
	/**
	 * Called whenever a gamepad connects or disconnects, so the DOM settings panel
	 * can show the live controller status without polling the Gamepad API itself.
	 */
	onGamepad?: (status: { connected: boolean; id: string | null }) => void;
	/**
	 * Called whenever the authoritative off-chain ledger changes (purse, cargo,
	 * faction standing, owned goods, ghost fleet), so the DOM Fleet & Ledger panel
	 * updates live instead of polling.
	 */
	onLedger?: (state: PlayerPublicState) => void;
	/**
	 * Called whenever the connected wallet address changes — a silent restore on
	 * reload, a fresh connect, a wallet-side account switch, or a disconnect
	 * (null). The DOM title/shop readout uses this to show the connected account
	 * without the player having to reconnect after every reload.
	 */
	onWallet?: (address: string | null) => void;
}

export interface GameHandle {
	dispose: () => void;
	/** Leave the title screen and join the live world (deferred net.connect). */
	startPlaying: () => void;
	/** Abandon an in-progress join (waiting screen → title): close the socket and
	 *  reset so Set Sail can be pressed again. No-op outside the joining phase. */
	cancelJoin: () => void;
	/** Apply presentation/audio settings; also called once on boot. */
	applySettings: (s: GameSettings) => void;
	/** Prompt the injected wallet (MetaMask/Rabby) to connect and adopt its account
	 *  (title-screen "Connect Wallet" button). Returns the address, or null. */
	connectWallet: () => Promise<string | null>;
	/** Current gamepad state for the settings panel. Reflects the last browser
	 *  `gamepadconnected` event and any pad polled on startup. */
	getGamepadStatus: () => { connected: boolean; id: string | null };
	/** Open the merchant / shop overlay from any menu (ignores port proximity). */
	openShop: () => void;
	/** Close the merchant / shop overlay. */
	closeShop: () => void;
	/** Whether the connected wallet + on-chain hull ownership clear the buy-to-play
	 *  gate. The title "Set Sail" button disables itself when this is false. */
	canPlay: () => { connected: boolean; ownsShip: boolean };
	/** Re-read the on-chain ship count (after connect or a purchase). */
	refreshOwnership: () => Promise<number>;
	/** Live formatted USDG balance of the connected wallet, or null if none. */
	usdgBalance: () => Promise<string | null>;
	/** Buy a hull from the NPC store (connects if needed) and refresh entitlement. */
	buyHull: (shipClass: ShipClass) => Promise<{ tokenId: string }>;
	/** The player's live off-chain ledger (purse, reputation, fleet, owned goods),
	 *  or null before the server has sent one (i.e. until they join the world). */
	getLedger: () => PlayerPublicState | null;
	/** On-chain hulls the connected wallet owns (the fleet count for the ledger view). */
	ownedHullCount: () => number;
	/** Buy an outfitting good with the off-chain cargo purse (fire-and-forget; the
	 *  updated ledger arrives via onLedger). No-op unless the world is live. */
	buyItem: (itemId: string) => void;
	/** Equip / unequip an owned good in its slot (fire-and-forget). */
	equipItem: (itemId: string, equipped: boolean) => void;
}

/**
 * Code-first runtime entry (design spec: procedural world lives in src/game/,
 * the Babylon Editor is used only for lighting/sky/camera polish). Boots the
 * engine + scene, wires the ocean / weather / entity / netcode subsystems, and
 * runs the render loop. This is the scaffold spine the gameplay builds hang off.
 */
export function createGame(canvas: HTMLCanvasElement, opts: GameOpts = {}): GameHandle {
	const engine = new Engine(canvas, true, {
		stencil: true,
		antialias: true,
		adaptToDeviceRatio: true,
		powerPreference: "high-performance",
	});
	const scene = new Scene(engine);
	scene.clearColor = new Color4(0.03, 0.05, 0.08, 1);

	// --- Lighting ----------------------------------------------------------
	const hemi = new HemisphericLight("hemi", new Vector3(0, 1, 0), scene);
	hemi.intensity = 0.55;
	hemi.diffuse = new Color3(0.8, 0.9, 1.0);
	hemi.groundColor = new Color3(0.1, 0.25, 0.3);
	// Sun travels opposite to the sky's sun direction so highlights match.
	const sun = new DirectionalLight("sun", SUN_DIR.scale(-1), scene);
	sun.intensity = 1.6;
	sun.diffuse = new Color3(1.0, 0.95, 0.85);

	// --- Subsystems --------------------------------------------------------
	const ocean = new OceanSystem(scene);
	const weather = new WeatherSystem(scene);
	const ships = new ShipManager(scene);
	const islands = new IslandSystem(scene);
	const vfx = new Vfx(scene);
	const combat = new CombatSystem(vfx, (id) => ships.getPosition(id));
	// The destructible shore forts: geometry built from the shared FORT_DEFS, its
	// section hp driven by the `forts` field on every snapshot.
	const forts = new FortSystem(scene, vfx);
	const net = new NetworkClient(WS_URL);
	const wallet = new Wallet();
	const audio = new AudioSystem();
	// Boot starts on the title (a menu, not the world) → the theme is wanted from
	// the outset. It turns off when we actually enter the world — the server
	// `welcome` sets phase "playing" (via setPhase), not the Set Sail click.
	// Browsers gate audio behind a gesture, so it only actually sounds once the
	// context unlocks (the first click/keypress) — but the intent is seeded now.
	audio.setTheme(true);

	weather.update(DEFAULT_WEATHER);

	// --- Camera ------------------------------------------------------------
	// A FreeCamera we drive manually each frame as a chase cam behind the
	// player's own hull (avoids the mesh-target coupling of FollowCamera).
	const camera = new FreeCamera("chase", new Vector3(0, 10, -26), scene);
	camera.minZ = 0.5;
	camera.maxZ = 20000;
	camera.fov = 0.85;
	scene.activeCamera = camera;

	// Stereo pan for a world-space sound: how far left/right of the view a point
	// sits, so a broadside off the port bow reports out of the left speaker.
	const _camRight = new Vector3(1, 0, 0);
	// View-backward axis (FreeCamera looks down local +Z, so -Z is straight back
	// along the sight line) — the direction the muzzle-recoil kick shoves the cam.
	const _camBack = new Vector3(0, 0, -1);
	function panFor(p: { x: number; y: number; z: number }): number {
		const right = camera.getDirection(_camRight);
		const vx = p.x - camera.position.x;
		const vz = p.z - camera.position.z;
		const l = Math.hypot(vx, vz) || 1;
		return Math.max(-1, Math.min(1, (vx / l) * right.x + (vz / l) * right.z));
	}

	// --- Post-processing filmic grade (needs the active camera) ------------
	const grade = createPostProcess(scene);

	// Weather modulates the sky/sea shader, the fog, and the scene lights — hand
	// it those references now that they all exist.
	weather.bind(ocean, camera, sun, hemi);

	// The Babylon-GUI HUD lives in the same render as the scene, so it must be
	// created once the active camera exists.
	const ui = new GameUi(scene, camera);
	const dock = new DockingMenu(scene, wallet, net);

	// The spyglass (task #145): a client-side "identify before engage" reveal.
	// It narrows the chase cam's FOV while raised and names the most prominent
	// in-range hull on the view axis, reading only from the snapshot the client
	// already has (no new server protocol — the world already culled it to us).
	const spyglass = new SpyglassSystem({
		camera,
		getStates: () => ships.getLatestStates(),
		getSelfId: () => net.selfShipId,
	});

	// --- Input -------------------------------------------------------------
	// Every device (keyboard / gamepad / touch) is abstracted into the
	// InputManager; the render loop reads one unified action frame per tick.
	const input = new InputManager();
	input.onActivity = () => audio.start();
	// Force the menu theme to play as soon as the player interacts ANYWHERE, not
	// just on the (hidden) canvas: the title is full-bleed key art, so the only
	// gesture before Set Sail is a DOM click/keypress. Browsers gate audio behind a
	// user activation, so the FIRST real click/keypress/touch boots the graph — and
	// since wantTheme is already true at boot, audio.start() immediately kicks the
	// theme loop. `once` so the handler detaches after the first activation.
	const unlockAudio = () => audio.start();
	window.addEventListener("pointerdown", unlockAudio, { once: true });
	window.addEventListener("keydown", unlockAudio, { once: true });
	window.addEventListener("touchstart", unlockAudio, { once: true });
	// Surface controller plug/unplug to the DOM shell (the settings panel shows it).
	input.onGamepadChange = (id) => opts.onGamepad?.({ connected: id !== null, id });
	const pause = new PauseMenu(scene, {
		onResume: () => setPaused(false),
		onRestart: () => window.location.reload(),
		onSettings: () => opts.onRequestOverlay?.("settings"),
		onHowTo: () => opts.onRequestOverlay?.("howto"),
		onFaucet: () => opts.onRequestOverlay?.("faucet"),
		// Shop from the pause menu: raise the dedicated DOM Shop page over the
		// (still-paused) world. The in-world dock panel is reserved for the E-key
		// docking flow (bounty/auction/dockside), not the merchant page.
		onShop: () => {
			opts.onOpenShop?.();
		},
		onFleet: () => {
			setPaused(false);
			openFleet();
		},
	});
	const touch = new MobileControls(scene, input);
	touch.setVisible(MobileControls.isTouchDevice());
	ui.onPausePressed = () => setPaused(true);

	// The parley / surrender prompt — a compact centred panel at either end of a
	// demand. Its Accept/Decline rows reuse the same gold-focus nav language as
	// the pause menu; the D-pad/arrow routing lives in the render loop.
	const parley = new ParleyPrompt(scene, {
		onAccept: () => {
			net.parleyAccept();
			parley.hide();
		},
		onDecline: () => {
			net.parleyDecline();
			parley.hide();
			ui.toast("Colours held — fight on.", "#ff9b9b");
		},
	});

	// The fleet / take-the-helm panel — lists this captain's owned afloat hulls
	// so they can hand the current one to the autopilot and sail another. Opened
	// from the pause menu; rows rebuild from the live snapshot each time.
	const fleet = new FleetPrompt(scene, {
		onSwitch: (shipId) => {
			net.switchHull(shipId);
			setPaused(false);
		},
		onClose: () => fleet.setVisible(false),
	});

	/** Compute the owned-hull rows from the latest snapshot and open the panel. */
	function openFleet(): void {
		const addr = net.address?.toLowerCase();
		const self = net.selfShipId;
		const hulls: FleetHull[] = [];
		if (addr) {
			const mine = ships
				.getLatestStates()
				.filter((s) => s.ownerAddress?.toLowerCase() === addr && (s.status === "active" || s.status === "on_auto"));
			for (const s of mine) {
				const spec = SHIP_CLASSES[s.shipClass];
				hulls.push({
					shipId: s.id,
					name: s.name,
					detail: `${spec?.label ?? s.shipClass} · ${s.status === "active" ? "afloat" : "auto"}`,
					isSelf: s.id === self,
				});
			}
		}
		fleet.show(hulls);
	}

	// --- Phase state machine ----------------------------------------------
	// The engine boots and renders the live ocean behind the (React) title menu,
	// but does NOT join the server until startPlaying() — so the world keeps
	// ticking behind the menu without this client being a player yet.
	let phase: GamePhase = "booting";
	let netStarted = false;
	let readyFired = false;
	// Whether engine.runRenderLoop is currently pumping. It runs only while the
	// world is actually on screen (boot first-frame + playing). The title menu is
	// fully covered by key art, so we STOP the loop once the title is revealed —
	// an invisible canvas still costs a full WebGL frame each tick, which is what
	// made the menu drag. startRenderLoop()/stopRenderLoop() below toggle it.
	let loopStarted = false;
	// Headless QA (`?play`) has no wallet to buy a hull, so it bypasses the
	// buy-to-play gate. Never set for a real (no-query) session.
	let freePlayAllowed = false;
	function setPhase(p: GamePhase): void {
		if (phase === p) return;
		phase = p;
		// Menu theme plays everywhere EXCEPT the live world: on while booting/menu
		// (title, loading, shop, fleet, settings, how-to), off once sailing.
		audio.setTheme(p !== "playing");
		// The ocean/wind/rain bed is a WORLD sound — on only while actually sailing,
		// off on every menu, so the selection screen never sounds like the sea.
		audio.setAmbient(p === "playing");
		opts.onPhase?.(p);
	}

	// Paused = THIS player's helm and guns idle. The world keeps ticking on the
	// authoritative server (other players still sail), like an online pause menu.
	let paused = false;
	const lastHelm = { throttle: 0, rudder: 0 };
	// "Under attack" = OUR hull was hit within this window. Manual pause is refused
	// while true (no pausing out of a firefight); the fleet-wipe auto-pause passes a
	// force flag so it still opens when the player has nothing left to sail.
	let lastDamageAt = 0;
	// "Attacking" = WE fired our guns within this window — the signal for the
	// aggressive combat track (Splintered_Timber) vs the defensive/fleeing track
	// (Where_the_Tide_Breaks, keyed on lastDamageAt) once we stop shooting back.
	let lastAttackedAt = 0;
	const ATTACK_WINDOW_MS = 8000;
	function isUnderAttack(): boolean {
		return performance.now() - lastDamageAt < ATTACK_WINDOW_MS;
	}
	function isAttacking(): boolean {
		return performance.now() - lastAttackedAt < ATTACK_WINDOW_MS;
	}
	/** On-chain hulls the connected wallet owns — the buy-to-play entitlement. */
	let ownedShipCount = 0;
	function setPaused(p: boolean, force = false): void {
		if (paused === p) return;
		if (p && !force && isUnderAttack()) {
			ui.toast("Too busy to heave-to — you're under fire!", "#ff9b9b");
			return;
		}
		paused = p;
		pause.setVisible(p);
		// A pause (manual or the forced fleet-wipe one) supersedes the fleet panel.
		if (p) fleet.setVisible(false);
		// Keep the on-screen controls out of the way while the menu is up.
		touch.setVisible(!p && MobileControls.isTouchDevice());
		if (p && net.selfShipId) {
			// Coast to a stop: one neutral helm order, then stop sending.
			net.sendInput({ throttle: 0, rudder: 0 });
			lastHelm.throttle = 0;
			lastHelm.rudder = 0;
		}
	}

	// --- Game-feel: camera shake + hit-stop --------------------------------
	// A hit on OUR hull kicks the chase cam off its smoothed position for a beat
	// and (on a heavy blow) freezes the world clock briefly — the impact "lands".
	// Both are purely local presentation; the authoritative sim is untouched.
	let shake = 0;
	let hitStop = 0;
	function addShake(mag: number): void {
		shake = Math.min(1.4, shake + mag);
	}
	// Broadside recoil (task #140): a short DIRECTIONAL muzzle kick — the chase cam
	// is punched straight back along its own view axis (and the lens dips a touch)
	// then recovers. Distinct from `shake`, which is a random positional wobble for
	// taking a hit; this is the ordered shove of OUR guns firing.
	let muzzleKick = 0;

	// True while the player's hull is inside a port's interaction range; drives
	// both the "Press E to dock" prompt and whether E actually opens the market.
	let nearPort = false;	// Latest off-chain ledger from the server; the HUD panel refreshes from this
	// every frame so the "hold" half tracks live cargo.
	let lastPlayer: PlayerPublicState | null = null;
	// Last fleet-wipe reading, so the auto-pause fires once on the transition, not
	// every frame the player is wiped.
	let wasWiped = false;

	// The gunner aims wherever the chase cam is looking. aimHeading is refreshed
	// every frame from the camera's horizontal forward vector; a click or fire
	// action orders a broadside along it.
	let aimHeading = 0;
	// Player-steered yaw offset (radians) on top of the hull's heading. Moving the
	// mouse turns the view port/starboard WITHOUT turning the hull, so the guns can
	// be brought to bear on a broadside while the ship keeps sailing on. Clamped so
	// you can train the aim nearly abeam but never fully behind the stern.
	let aimYaw = 0;
	const MAX_AIM_YAW = 1.45;
	// Seconds since the last mouse pan. While a broadside aim is being held the
	// player keeps nudging the mouse so this stays near zero; once they let go it
	// grows and the view eases back to the bow. Without this the pan offset is
	// permanent, so steering the hull toward something you had panned onto
	// OVERSHOOTS it — the thing you were looking at slides out of frame as you
	// turn, which is what makes a distant marker (e.g. the sun) appear to "run
	// away" when you drive toward it.
	let aimYawIdle = 0;
	// Wall-clock ms at which the current broadside finishes running out. The server
	// owns the real gate (world.ts: weatherTime - lastFireAt < reload); we mirror it
	// client-side off the hull class's base reloadSeconds so the HUD can show a
	// reload bar and we never spam shots the server would drop. Geared reload bonus
	// is ignored here — the bar is at worst a hair conservative.
	let reloadEndsAt = 0;
	// The weapon the current aim would loose (bow-relative arc), recomputed each
	// frame so the HUD shows chain / swivel / broadside / fire exactly as the
	// server will resolve it. Same shared helper — never a hidden selector.
	let curWeapon: WeaponType = "broadside";
	// The loaded shot — round / chain / grape / heated — cycled by the gunner
	// (X / Z). It rides every fire() so the server composes it with whatever arc
	// the aim has brought to bear; the HUD names both the gun and the payload.
	let curAmmo: AmmoType = "round";
	function weaponForSelfAim(): WeaponType {
		const self = net.selfShipId ? ships.getState(net.selfShipId) : undefined;
		const rel = self ? aimHeading - self.heading : 0;
		return weaponForAim(rel);
	}
	function fireBroadside(): void {
		if (paused || dock.isVisible() || parley.isVisible() || fleet.isVisible()) return;
		if (!net.selfShipId) return;
		// A harbour is neutral ground — guns run cold inside a port's radius, the
		// same rule the server enforces authoritatively, so the click just toasts.
		if (nearPort) {
			ui.toast("Guns run cold in a harbour — this is safe ground.", "#9be8ff");
			return;
		}
		const now = performance.now();
		if (now < reloadEndsAt) return; // still reloading
		const cls = ships.getState(net.selfShipId)?.shipClass;
		curWeapon = weaponForSelfAim();
		// The server bends the class reload by the arc's AND the payload's factor
		// (grape fires fast, heated slow to tend the furnaces), so mirror both here
		// or the bar lies.
		const baseReload = cls ? SHIP_CLASSES[cls].reloadSeconds : 6;
		const reload = Math.max(0.6, baseReload * WEAPONS[curWeapon].reloadFactor * AMMO[curAmmo].reloadFactor);
		net.fire(aimHeading, curAmmo);
		lastAttackedAt = now;
		reloadEndsAt = now + reload * 1000;
		ui.startReload(reload);
		// Recoil (task #140): the guns shove the ship and the view. A full broadside
		// volley punches harder than a swivel/chain; weight both the random shake and
		// the directional kick so the discharge physically "lands" on the camera.
		const heavy = curWeapon === "broadside";
		addShake(heavy ? 0.12 : 0.06);
		muzzleKick = Math.min(1.1, muzzleKick + (heavy ? 0.9 : 0.5));
	}
	const onPointerDown = () => {
		audio.start();
		// Mouse click on the sea fires a broadside. On touch devices the canvas
		// tap is reserved for the stick/buttons, so only fire for a fine pointer.
		if (!paused && !dock.isVisible() && !parley.isVisible() && !fleet.isVisible() && !MobileControls.isTouchDevice()) fireBroadside();
	};
	canvas.addEventListener("pointerdown", onPointerDown);
	// Horizontal mouse movement pans the aim. Only while actually sailing with a
	// fine pointer (mouse), and never through the pause/dock menus, so it can't
	// fight the DOM menu navigation or the mobile stick.
	const onPointerMove = (e: PointerEvent) => {
		if (!netStarted || paused || dock.isVisible() || parley.isVisible() || fleet.isVisible()) return;
		if (e.pointerType !== "mouse") return;
		aimYaw = Math.max(-MAX_AIM_YAW, Math.min(MAX_AIM_YAW, aimYaw + e.movementX * 0.0022));
		aimYawIdle = 0;
	};
	canvas.addEventListener("pointermove", onPointerMove);

	// Spyglass (task #145): V raises / lowers the glass; while it is held [ and ]
	// dial the lens zoom. Blocked while a modal menu owns the keyboard, exactly
	// like the fire / parley actions.
	const onKeySpyglass = (e: KeyboardEvent) => {
		if (e.repeat) return;
		if (!netStarted || paused || dock.isVisible() || parley.isVisible() || fleet.isVisible()) return;
		if (spyglass.active && (e.code === "BracketLeft" || e.key === "[")) {
			spyglass.zoomBy(-0.25);
			return;
		}
		if (spyglass.active && (e.code === "BracketRight" || e.key === "]")) {
			spyglass.zoomBy(0.25);
			return;
		}
		if (e.code === "KeyV" || e.key === "v" || e.key === "V") spyglass.toggle();
	};
	window.addEventListener("keydown", onKeySpyglass);

	// Kinds of fire (task #150): X loads the next shot, Z the previous. The
	// selection is local (like the aim) and rides each fire() to the server,
	// which composes it with the gun the aim has brought to bear.
	const onKeyAmmo = (e: KeyboardEvent) => {
		if (e.repeat) return;
		const fwd = e.code === "KeyX";
		const back = e.code === "KeyZ";
		if (!fwd && !back) return;
		if (!netStarted || paused || dock.isVisible() || parley.isVisible() || fleet.isVisible()) return;
		const i = AMMO_KEYS.indexOf(curAmmo);
		curAmmo = AMMO_KEYS[(i + (fwd ? 1 : AMMO_KEYS.length - 1)) % AMMO_KEYS.length];
		ui.toast(`${AMMO[curAmmo].label} loaded — ${AMMO[curAmmo].hint}`, "#ffd27a");
	};
	window.addEventListener("keydown", onKeyAmmo);

	// --- Net wiring --------------------------------------------------------
	let currentWeather: WeatherState = DEFAULT_WEATHER;
	// The server accepted our join and handed us a ship: we're a live player now.
	// This is the moment to reveal the world — start pumping frames and drop the
	// waiting screen (the canvas flips to visible when phase hits "playing").
	net.onWelcome = () => {
		setPhase("playing");
		startRenderLoop();
	};
	net.onSnapshot = ({ ships: shipStates, weather: w, wrecks, forts: fortStates }) => {
		ships.ingest(shipStates);
		ui.setWrecks(wrecks);
		forts.applyStates(fortStates);
		currentWeather = w;
		weather.update(w);
		audio.setWeather(w);
	};
	net.onCombat = (evt) => {
		combat.onEvent(evt);
		// Mirror each authoritative combat beat with a synthesised, view-panned cue.
		switch (evt.t) {
			case "shot":
				audio.play("cannon", panFor(evt.origin));
				break;
			case "hullImpact":
				audio.play("hullImpact", panFor(evt.point));
				// Stamp a scorch decal on the VICTIM's hull at the impact point (task #141).
				// The mark is parented to the hull root, so it rides her roll/pitch/sink and
				// disposes with her; VfxLibrary caps marks per hull and reuses one texture.
				{
					const root = ships.getHullRoot(evt.targetId);
					if (root) vfx.spawnHullDecal(root, new Vector3(evt.point.x, evt.point.y, evt.point.z));
				}
				// Only OUR hull being hit rattles the camera; a distant duel should
				// not shove the player's view around.
				if (evt.targetId === net.selfShipId) {
					addShake(0.16 + Math.min(0.5, evt.damage * 0.02));
					if (evt.damage >= 16) hitStop = Math.max(hitStop, 0.05);
					// Anchor the "under attack" window on the last hit WE take.
					lastDamageAt = performance.now();
				}
				break;
			case "waterImpact":
				audio.play("splash", panFor(evt.point));
				break;
			case "sunk": {
				const pos = ships.getPosition(evt.shipId);
				if (pos) audio.play("sink", panFor(pos));
				if (evt.shipId === net.selfShipId) {
					addShake(1.2);
					hitStop = Math.max(hitStop, 0.12);
					// Continuation nudge at the moment of sinking. Read the latest snapshot
					// for this captain's OTHER afloat hulls (excluding the one just going
					// down): if there's one, hand the captain straight to the Fleet panel so
					// taking a new helm is one click; if there's none, tell them the wreck is
					// towing to port to repair (the fleet-wipe check raises the pause menu a
					// frame later once nothing is left to sail).
					const addr = net.address?.toLowerCase();
					const others = addr
						? ships
								.getLatestStates()
								.filter(
									(s) =>
										s.ownerAddress?.toLowerCase() === addr &&
										s.id !== evt.shipId &&
										(s.status === "active" || s.status === "on_auto")
								)
						: [];
					if (others.length > 0) {
						ui.toast("She's going down — take the helm of another hull to keep sailing.", "#e6c079");
						openFleet();
					} else {
						ui.toast("She's going down — your hull is being towed to port. Repair her at the dock to sail again.", "#e6c079");
					}
				}
				break;
			}
			case "repair":
				// Tell the captain honestly whether the harbour gave a full refit or just
				// slapped on an emergency patch (they couldn't cover the fee — sunk broke).
				if (evt.shipId === net.selfShipId) {
					ui.toast(
						evt.patched
							? "Emergency patch — she's battered but afloat. Refit her properly once your purse recovers."
							: "Refit complete — she's good as new.",
						evt.patched ? "#ffcf8a" : "#9be8a0"
					);
				}
				break;
			case "muzzleFlash":
				break;
			case "fortImpact":
				forts.impact(evt.fortId, evt.section, evt.point, evt.damage);
				audio.play("hullImpact", panFor(evt.point));
				break;
			case "fortDetonate":
				forts.detonate(evt.fortId, evt.point);
				audio.play("sink", panFor(evt.point));
				// A fort blowing up nearby is a seismic event for the camera.
				{
					const sp = ships.getSelfPosition(net.selfShipId);
					if (sp && Math.hypot(evt.point.x - sp.x, evt.point.z - sp.z) < 260) addShake(1.1);
				}
				break;
		}
	};
	// Thunder lags its own lightning flash: fire the strike sound a beat after the
	// sky lights, distance-jittered so a storm rumbles rather than machine-guns.
	// Suppressed outside the live world — the sky still simulates behind the menus
	// (canvas hidden), but a storm crack in the title screen would break the silence.
	weather.onStrike = () => {
		if (phase !== "playing") return;
		const lag = 250 + Math.random() * 2200;
		setTimeout(() => audio.play("thunder"), lag);
	};
	// An on-chain bounty settled (we were the hunter, or our hull's bounty paid
	// out to someone). Surface the USDG movement to the player.
	net.onBountyClaimed = (p) => {
		const amt = formatUsdg(BigInt(p.amount));
		const mine = wallet.address && p.claimant.toLowerCase() === wallet.address.toLowerCase();
		ui.toast(mine ? `Bounty claimed: ${amt} USDG  tx ${p.txHash.slice(0, 10)}…` : `Bounty #${p.bountyId} settled for ${amt} USDG`, mine ? "#9be8a0" : "#ffd98a");
	};
	// Off-chain ledger update (purse, faction standing, ghost fleet). Refresh the
	// HUD panel; the "hold" half comes from our own hull's live cargo.
	net.onPlayerState = (p) => {
		dock.setPlayer(p.state);
		lastPlayer = p.state;
		opts.onLedger?.(p.state);
	};
	// A buried cache was dug anywhere on the sea: drop its marker for everyone and
	// toast the haul if it was ours.
	net.onPoiClaimed = (p) => {
		ui.markPoiClaimed(p.poiId);
		if (p.shipId === net.selfShipId) ui.toast(`Uncovered a cache: +${p.cargo} cargo`, "#ffd97a");
	};
	// A debris field was dove (by anyone): drop its marker, toast if it was our haul.
	net.onSalvageClaimed = (p) => {
		ui.markWreckGone(p.wreckId);
		if (p.shipId === net.selfShipId) ui.toast(`Salvaged the wreck: +${p.cargo} cargo`, "#b9a67f");
	};
	// A rival listed (or the roster changed): refresh the browsable auction house.
	net.onAuctionList = (list) => dock.setAuctions(list);
	net.onBountyBoard = (wanted) => ui.setWanted(wanted);
	net.onTradeOrders = (orders) => dock.setOrders(orders);
	// The helm handover landed: selfShipId already retargeted in NetworkClient;
	// confirm to the captain and reset the mirrored reload bar for the new hull.
	net.onHelmSwitched = () => {
		reloadEndsAt = 0;
		ui.toast("You have taken the helm.", "#e6c079");
	};

	// --- Parley / surrender --------------------------------------------------
	// A rival demanding OUR hull: show the strike-your-colors prompt (server only
	// routes this to the defender).
	net.onParleyIncoming = (offer) => {
		parley.showIncoming(offer.attackerName, offer.demand, offer.ttlSeconds);
		ui.toast(`${offer.attackerName} demands terms!`, "#ffd98a");
	};
	// OUR demand is pending the target's answer.
	net.onParleyAsked = (msg) => parley.showAsked(msg.defenderName, msg.demand, msg.ttlSeconds);
	// Resolved on either end: close both prompts and report the outcome.
	net.onParleyResolved = (r) => {
		const iAmAttacker = r.attackerShipId === net.selfShipId;
		parley.hide();
		if (r.accepted) {
			ui.toast(
				iAmAttacker
					? `Surrender accepted — took ${Math.round(r.moved)} cargo under truce.`
					: `Paid ${Math.round(r.moved)} cargo toll — truce holds briefly.`,
				"#9be8a0"
			);
		} else {
			ui.toast(iAmAttacker ? "Terms refused — fight on." : "You held your colours — fight on.", "#ff9b9b");
		}
	};
	// A parley action we attempted was refused (out of range, target gone, etc.).
	net.onParleyFailed = (reason) => {
		parley.hide();
		const msg =
			reason === "range"
				? "Out of cannon range to demand terms."
				: reason === "ally"
				? "Cannot demand terms of an ally."
				: reason === "empty"
				? "That hull holds nothing worth demanding."
				: reason === "full"
				? "Your hold is full — no room for a toll."
				: reason === "self"
				? "You cannot parley with yourself."
				: "No one there to answer the demand.";
		ui.toast(msg, "#ff9b9b");
	};

	// Anti-cheat notices from the authoritative Guard: pulse the HUD shield on a
	// blocked input, flash + toast when a hull is flagged for cheating.
	net.onSecurity = (e) => ui.securityEvent(e);

	// --- On-chain actions (wallet) -----------------------------------------
	// Any account change — connect, wallet-side switch, disconnect, or the silent
	// reload restore — rebinds the net address, refreshes the buy-to-play
	// entitlement, and pushes the address up to the DOM. connect()/disconnect()/the
	// provider listeners all route through here, so the single source of truth for
	// "which wallet is live" stays consistent.
	wallet.onAccountsChanged = (addr) => {
		if (addr) net.bindAddress(addr);
		void refreshOwnership().then(() => opts.onWallet?.(addr));
	};
	// Silent restore: if the injected wallet was already approved in a prior visit,
	// adopt its account WITHOUT a popup (eth_accounts never prompts) so the HUD and
	// buy-to-play entitlement reflect the connected wallet on load. A no-op when no
	// wallet is pre-approved — the player then uses the "Connect Wallet" button.
	void wallet.restore();
	// Prompt the injected wallet to connect (user-gesture path from the title/dock),
	// bind it to our runtime ship so the server can settle bounties to us, and toast
	// the result. Returns the address (or null if no wallet / the request rejected).
	async function connectWallet(): Promise<string | null> {
		const addr = await wallet.connect();
		if (addr) ui.toast(`Wallet ${addr.slice(0, 6)}…${addr.slice(-4)} linked`, "#9be8ff");
		return addr;
	}
	/** Re-read the connected wallet's on-chain hull count (the buy-to-play gate). */
	async function refreshOwnership(): Promise<number> {
		ownedShipCount = await wallet.ownedShipCount();
		return ownedShipCount;
	}
	function canPlay(): { connected: boolean; ownsShip: boolean } {
		return { connected: wallet.address !== null, ownsShip: ownedShipCount > 0 };
	}
	/** Live, formatted USDG balance of the connected wallet; null when there is no
	 *  connected/configured wallet to read. Used by the DOM Shop page header. */
	async function usdgBalance(): Promise<string | null> {
		if (!wallet.address || !wallet.isConfigured) return null;
		return formatUsdg(await wallet.usdgBalanceOf(wallet.address));
	}
	/** Buy a hull from the buy-only NPC store on behalf of the connected wallet,
	 *  connecting first if needed, then re-checking the buy-to-play entitlement so
	 *  the title unlocks "Set Sail". Throws a human-readable message on failure. */
	async function buyHull(shipClass: ShipClass): Promise<{ tokenId: string }> {
		if (!wallet.address) {
			const addr = await connectWallet();
			if (!addr) throw new Error("No wallet account chosen.");
		}
		const { tokenId } = await wallet.buyShip(shipClass);
		await refreshOwnership();
		return { tokenId: tokenId.toString() };
	}
	// After a purchase the entitlement changes: re-read ownership so the title's
	// "Set Sail" unlocks (and the buy-to-play guard lets startPlaying through).
	dock.onPurchased = () => {
		void refreshOwnership().then((n) => {
			if (n > 0 && !netStarted) ui.toast("Hull secured — you can set sail.", "#9be8a0");
		});
	};
	// Escrow a live USDG bounty against an owned hull tokenId. This is the demo's
	// headline on-chain moment; the server relayer claims it when the hull sinks.
	async function postBounty(tokenId: string, usdgWhole: string): Promise<string> {
		if (!wallet.address) await connectWallet();
		const r = await wallet.postBounty(BigInt(tokenId), usdgWhole);
		net.notifyBountyPosted(r.bountyId, r.tokenId, wallet.address as string, r.amount);
		ui.toast(`Bounty #${r.bountyId} posted: ${formatUsdg(BigInt(r.amount))} USDG on hull ${r.tokenId}`, "#ffd98a");
		return r.txHash;
	}

	// --- Settings + phase transitions --------------------------------------
	// Presentation-only: volumes hit the audio buses, quality toggles the filmic
	// grade (and lowers the render scale for older GPUs). Called once on boot with
	// the persisted settings and again whenever the DOM settings panel changes.
	function applySettings(s: GameSettings): void {
		audio.setVolumes(s.master, s.sfx, s.ambient);
		const high = s.quality === "high";
		// No master toggle on the pipeline: drop the GPU-heavy passes for "low" and
		// render at a lower internal resolution, while keeping cheap FXAA AA on.
		grade.bloomEnabled = high;
		grade.grainEnabled = high;
		grade.imageProcessingEnabled = high;
		engine.setHardwareScalingLevel(high ? 1 : 1.6);
	}

	// Join the live world. The engine has been rendering behind the title menu the
	// whole time; this is the deferred net handshake the "Set Sail" button triggers.
	function startPlaying(): void {
		if (netStarted) return;
		// Buy-to-play: every new player must be connected and own at least one
		// on-chain hull. Otherwise raise the merchant so they can buy, and stay on
		// the title. `?play` (headless QA, no wallet) bypasses the gate.
		if (!freePlayAllowed && (wallet.address === null || ownedShipCount === 0)) {
			if (wallet.address === null) void connectWallet();
			dock.show();
			ui.toast("Connect your wallet and buy a hull to set sail.", "#ffd98a");
			return;
		}
		netStarted = true;
		// Decode the world (islands + forts) only now, as the canvas is about to
		// become visible. Doing this at boot — behind the hidden title canvas — is
		// what OOM-killed the tab (task #70): ~400 MB of scenery GPU uploads for a
		// scene the player can't see. The ocean/sky/weather are procedural and cheap,
		// so the title still renders the sea behind the menu.
		islands.activate();
		forts.activate();
		// Invoked from the Set Sail click, so this is a valid audio gesture: unlock
		// the mix now rather than waiting for the first canvas tap.
		audio.start();
		net.connect();
		// Enter the WAITING phase, not "playing": the socket is open and the world is
		// decoding, but we render nothing until the server hands us a ship (`welcome`).
		// The DOM shows a waiting screen over the hidden canvas — which also absorbs a
		// slow/overloaded server, since we only reveal the world once it responds.
		setPhase("joining");
	}

	function cancelJoin(): void {
		// Only meaningful while waiting for welcome. Tear the half-open session down
		// and return to the title so the player isn't stuck on the waiting screen.
		if (phase !== "joining") return;
		net.disconnect();
		netStarted = false;
		// Loop is already stopped (we never started it during the wait); go back to
		// the title. The world stays decoded but hidden — re-clicking Set Sail just
		// reconnects (activate() is idempotent).
		setPhase("menu");
	}

	// Boot-time settings (before audio has started, so volumes are stored and
	// picked up on the first gesture).
	applySettings(loadSettings());

	// Auto-join escape hatch for headless verification (there is no human to press
	// "Set Sail" in a screenshot run): `?play` skips straight into the world.
	if (typeof window !== "undefined" && new URLSearchParams(window.location.search).has("play")) {
		freePlayAllowed = true;
		startPlaying();
	}

	// In-browser inspection handle. Exposed UNCONDITIONALLY: the previous
	// `NODE_ENV !== "production"` guard silently dropped it, which meant every
	// QA probe returned `noHandle` and we debugged blind for several rounds.
	// Instrumentation that can vanish is worse than none. Strip before shipping.
	(window as unknown as Record<string, unknown>).__hs = {
		scene,
		engine,
		ships,
		net,
		ocean,
		weather,
		camera,
		islands,
		forts,
		combat,
		wallet,
		dock,
		audio,
		input,
		pause,
		touch,
		setPaused,
		connectWallet,
		postBounty,
		startPlaying,
		applySettings,
		openShop: () => dock.show(),
		canPlay,
		clutterStats: () => ships.clutterStats(),
		islandStats: () => islands.stats(),
		shellStats: () => combat.shellCount(),
		ui,
		parley,
		spyglass,
		// DEV ONLY: force each event-gated panel up so its UI can be eyeballed
		// without orchestrating a real sink / hail / bounty / order.
		debug: {
			wanted: () =>
				ui.setWanted([
					{ tokenId: "17", amount: "25000000", name: "Red Annabel", shipClass: "galleon" },
					{ tokenId: "42", amount: "8000000", name: "Sea Vixen", shipClass: "raider_brig" },
					{ tokenId: "8", amount: "40000000", name: "Iron Leviathan", shipClass: "imperial" },
				] as unknown as WantedEntry[]),
			trade: () => {
				dock.setOrders([
					{ id: "1", seller: "0xaaa", kind: "cargo", qty: 20, price: 15 },
					{ id: "2", seller: "0xbbb", kind: "cargo", qty: 40, price: 32 },
				] as unknown as TradeListing[]);
				dock.show();
			},
			parleyIncoming: () => parley.showIncoming("Black Bess", 12, 20),
			parleyAsked: () => parley.showAsked("Iron Jack", 8, 20),
			wreck: (on = true) => ui.debugWreck(on),
			badges: (on = true) => ui.debugBadges(on),
			fleet: () => openFleet(),
			fortWound: () => forts.debugWound(),
			fortDetonate: () => forts.debugDetonate(),
			hide: () => {
				parley.hide();
				ui.debugWreck(false);
				ui.debugBadges(false);
			},
		},
	};

	// --- Render loop -------------------------------------------------------
	const camPos = new Vector3(0, 10, -26);
	// First frame we learn where the hull actually is, snap the chase cam to its
	// offset instead of easing from the default spot — otherwise it arcs around
	// the ship into position, which reads as the hull spinning on refresh.
	let hasCamInit = false;
	// Previous hull position, used to estimate speed for the FOV cue.
	const lastSelf = new Vector3(0, 0, 0);
	let hasLastSelf = false;
	// Camera bank/roll into turns. We track the hull heading to derive turn RATE,
	// then lean the chase cam's up-vector around the view axis so a hard helm
	// tilts the whole horizon toward the inside of the turn — the missing cue that
	// made steering feel like sliding rather than carving.
	let lastHeading = 0;
	let hasHeading = false;
	let camBank = 0;
	// --- Time of day (Phase 2): a slow golden-hour drift, never night ---------
	// Sun elevation is clamped well above the horizon so the sea never goes dark
	// (true night would re-trigger the "where is the water" complaint). The tint
	// defaults to white at the top of the arc, i.e. the approved midday look.
	let todTime = 0;
	const _sunDir = new Vector3();
	const _skyTint = new Vector3(1, 1, 1);
	const _sunTint = new Vector3(1, 1, 1);
	const _sunWarm = new Color3(1, 1, 1);
	// scratch reused for the "sun opposite" light direction.
	const _lightDir = new Vector3();
	// Render loop guard: a throw inside runRenderLoop used to be swallowed by
	// Babylon and simply stop the loop — the canvas went dark with no console
	// clue. Keep the frame alive and surface the error instead.
	let loopErrCount = 0;
	// A throw in the render loop is otherwise invisible without DevTools. Mirror
	// the first few errors into a DOM banner so a broken HUD/VFX surfaces itself
	// on screen (the canvas keeps rendering because we still swallow the throw).
	function showLoopError(err: unknown): void {
		const id = "hs-loop-error";
		let el = document.getElementById(id);
		if (!el) {
			el = document.createElement("div");
			el.id = id;
			el.style.cssText =
				"position:fixed;left:8px;bottom:44px;z-index:99999;max-width:60vw;" +
				"padding:8px 10px;background:rgba(120,10,10,0.92);color:#fff;font:12px/1.4 monospace;" +
				"border-radius:6px;white-space:pre-wrap;pointer-events:none;";
			document.body.appendChild(el);
		}
		const msg = err instanceof Error ? `${err.name}: ${err.message}\n${err.stack ?? ""}` : String(err);
		el.textContent = `[renderLoop] ${msg}`.slice(0, 600);
	}

	// Sail-gear readout (task #138). GameUi.ts isn't ours to edit, so this is a
	// self-contained DOM label the render loop drives straight from the authoritative
	// `ShipState.gear` the server echoes on every snapshot — the HUD always shows the
	// canonical order, whether it came from a key press or was mirrored off analog.
	let gearEl: HTMLDivElement | null = null;
	function ensureGearHud(): HTMLDivElement | null {
		if (typeof document === "undefined") return null;
		if (gearEl && document.contains(gearEl)) return gearEl;
		gearEl = document.createElement("div");
		gearEl.id = "hs-gear";
		gearEl.style.cssText =
			"position:fixed;left:50%;bottom:120px;transform:translateX(-50%);z-index:60;" +
			"padding:3px 12px;background:rgba(12,18,26,0.5);color:#e6c079;" +
			"font:600 13px/1.3 ui-monospace,monospace;letter-spacing:0.04em;" +
			"border:1px solid rgba(230,192,121,0.3);border-radius:7px;pointer-events:none;" +
			"text-transform:uppercase;opacity:0;transition:opacity 0.2s;";
		document.body.appendChild(gearEl);
		return gearEl;
	}

	// Spyglass HUD toggle (task #145): a small button mirroring the V key for
	// mouse/touch players. Self-contained DOM so GameUi.ts stays untouched; the
	// button reflects the raised/lowered state each frame from spyglass.active.
	let spyglassBtn: HTMLButtonElement | null = null;
	function ensureSpyglassButton(): HTMLButtonElement | null {
		if (typeof document === "undefined") return null;
		if (spyglassBtn && document.contains(spyglassBtn)) return spyglassBtn;
		spyglassBtn = document.createElement("button");
		spyglassBtn.id = "hs-spyglass-btn";
		spyglassBtn.type = "button";
		spyglassBtn.textContent = "Spyglass";
		spyglassBtn.style.cssText =
			"position:fixed;right:16px;bottom:120px;z-index:70;" +
			"padding:6px 12px;background:rgba(12,18,26,0.55);color:#e6c079;" +
			"font:600 12px/1.3 ui-monospace,monospace;letter-spacing:0.05em;" +
			"border:1px solid rgba(230,192,121,0.4);border-radius:8px;" +
			"cursor:pointer;text-transform:uppercase;";
		spyglassBtn.addEventListener("click", () => {
			if (!netStarted || paused || dock.isVisible() || parley.isVisible() || fleet.isVisible()) return;
			spyglass.toggle();
		});
		document.body.appendChild(spyglassBtn);
		return spyglassBtn;
	}
	// Idempotent render-loop control. The loop runs during boot (to produce the
	// first-frame ready signal) and while playing. It is stopped for the menu and
	// the joining wait, so no GPU/CPU is spent rendering an off-screen canvas.
	function startRenderLoop(): void {
		if (loopStarted) return;
		loopStarted = true;
		engine.runRenderLoop(() => {
			try {
				renderFrame();
			} catch (err) {
				if (loopErrCount++ < 3) {
					console.error("[renderLoop] frame threw", err);
					showLoopError(err);
				}
			}
		});
	}
	function stopRenderLoop(): void {
		if (!loopStarted) return;
		loopStarted = false;
		engine.stopRenderLoop();
	}
	startRenderLoop();

		function renderFrame(): void {
			const raw = Math.min(0.05, engine.getDeltaTime() / 1000);
			// Hit-stop: for a few frames after a heavy self-hit, the world clock
			// crawls (but the camera shake still runs on real time) so the impact
			// registers as a beat of near-stillness.
			let dt = raw;
			if (hitStop > 0) {
				hitStop -= raw;
				dt = raw * 0.12;
			}

			// The scene is procedural, so the first rendered frame IS the ready
			// signal: tell the loading overlay to finish and reveal the title.
			if (!readyFired) {
				readyFired = true;
				opts.onReady?.();
			// Reveal the title only if we haven't already been told to play
			// (e.g. an auto-join `?play` used for headless verification). Stop the
			// loop now: the title is full-screen key art, so rendering the hidden
			// ocean behind it is pure waste — and the cause of the menu drag. The
			// loop restarts when the server welcomes us into the world.
			if (!netStarted) {
				setPhase("menu");
				stopRenderLoop();
			}
			}

			// Read one unified action frame (keyboard / gamepad / touch). Consumed
			// every frame so edge state stays clean, but only acted on once the
			// player has joined (before that the DOM title menu owns the screen).
			const inp = input.read();
			if (netStarted) {
				if (inp.pause) setPaused(!paused);
				// Demand surrender terms of the nearest rival PLAYER hull (P / Y button).
				// The server is authoritative on range/state — we pick the nearest
				// foreign active hull and let it refuse with a reason toast.
				if (inp.parley && !paused && !dock.isVisible() && !parley.isVisible() && !fleet.isVisible()) {
					const sp = ships.getSelfPosition(net.selfShipId);
					if (sp && net.address) {
						let best: string | null = null;
						let bestD = Infinity;
						for (const s of ships.getLatestStates()) {
							if (s.status !== "active" || !s.ownerAddress || s.ownerAddress.toLowerCase() === net.address!.toLowerCase()) continue;
							const p = ships.getPosition(s.id);
							if (!p) continue;
							const d = Math.hypot(p.x - sp.x, p.z - sp.z);
							if (d < bestD) {
								bestD = d;
								best = s.id;
							}
						}
						if (best) net.parleyDemand(best);
						else ui.toast("No rival in sight to demand terms of.", "#8aa3bd");
					}
				}
				// In-game menu navigation: the Babylon-GUI menus have no DOM focus of
				// their own, so route D-pad/arrow/A here. A parley prompt (which floats
				// over the world, mid-firefight) takes priority over pause and dock.
				if (parley.isVisible()) {
					if (inp.uiUp) parley.move(-1);
					if (inp.uiDown) parley.move(1);
					if (inp.uiConfirm) parley.confirm();
				} else if (fleet.isVisible()) {
					// The fleet panel (opened from the pause menu, which closed when it
					// opened) is a full-screen modal — route the same gold-focus nav.
					if (inp.uiUp) fleet.move(-1);
					if (inp.uiDown) fleet.move(1);
					if (inp.uiConfirm) fleet.confirm();
				} else if (paused) {
					if (inp.uiUp) pause.move(-1);
					if (inp.uiDown) pause.move(1);
					if (inp.uiConfirm) pause.confirm();
				} else if (dock.isVisible()) {
					// The docking panel is the other DOM-less Babylon menu — route the
					// same D-pad/arrow/A nav to it while it is open.
					if (inp.uiUp) dock.move(-1);
					if (inp.uiDown) dock.move(1);
					if (inp.uiConfirm) dock.confirm();
				}
				if (inp.interact && !paused && !parley.isVisible() && !fleet.isVisible()) {
					if (dock.isVisible()) dock.hide();
					else if (nearPort) dock.show();
				}
				if (inp.fire && !paused && !parley.isVisible() && !fleet.isVisible()) fireBroadside();
				// Sail gear orders (task #138): a discrete edge from keys 1..4 / [ / ]
				// (InputManager). The server mirrors analog throttle into a display gear
				// until an order is given, but a key here makes the captain's choice
				// canonical — it overrides sustained speed AND turn authority on the sim.
				if (inp.gearOrder && !paused && !dock.isVisible() && !fleet.isVisible()) {
					net.sendGear(inp.gearOrder);
				}
			}

			// Gamepad right stick pans the aim (yaw offset) exactly like the mouse does:
			// dt-scaled for a stick feel, clamped to the same abeam limit, and it resets
			// the auto-recenter idle timer while leaned so a held broadside stays on
			// target. Uses wall-clock `raw` so a hit-stop freeze doesn't stall the pan.
			if (netStarted && !paused && !dock.isVisible() && inp.lookX !== 0) {
				aimYaw = Math.max(-MAX_AIM_YAW, Math.min(MAX_AIM_YAW, aimYaw + inp.lookX * 1.7 * raw));
				aimYawIdle = 0;
			}

		// Send helm intent to the authoritative server ONLY when it changes, not
		// every frame. Continuous per-frame sends used to trip the server's input
		// rate-limit, which silently dropped the player's controls.
		if (!paused && net.selfShipId) {
			const docked = dock.isVisible() || fleet.isVisible();
			const throttle = docked ? 0 : inp.throttle;
			const rudder = docked ? 0 : inp.rudder;
			if (throttle !== lastHelm.throttle || rudder !== lastHelm.rudder) {
				net.sendInput({ throttle, rudder });
				lastHelm.throttle = throttle;
				lastHelm.rudder = rudder;
			}
		}

		// Ease the rendered weather toward the latest server snapshot first, then
		// read the SMOOTHED state everywhere downstream so ships, sea, sky and the
		// storm/music/HUD checks all agree on one gradual transition (not a snap).
		weather.ease(dt);
		const wNow = weather.smoothed ?? currentWeather;

		// Advance interpolation / extrapolation / wave bob for every hull.
		ships.update(dt, wNow, net.selfShipId);

		// Drive the procedural sea/sky and keep the sea grid centred on the viewer.
		ocean.update(wNow, dt);
		ocean.follow(camera.position.x, camera.position.z);
		weather.tick(dt);
		islands.update(dt);
		forts.update(dt);
		combat.update(dt);
		parley.tick();

		// Golden-hour drift: a slow arc that swings warmth + sun height without
		// ever reaching night. At the top of the arc the tint is pure white, so the
		// look matches the baked midday exactly; only near the extremes it warms up.
		todTime += dt;
		const arc = 0.5 + 0.5 * Math.sin((todTime / 220) * Math.PI * 2); // 0 low, 1 high
		const elev = 0.22 + arc * 0.45; // 0.22..0.67 -> always daytime
		const az = todTime * 0.018;
		_sunDir.set(Math.sin(az), elev, Math.cos(az)).normalize();
		const warm = 1 - arc; // 0 at noon, 1 at the low end of the arc
		_skyTint.set(1, 1 - warm * 0.14, 1 - warm * 0.32);
		_sunTint.set(1 + warm * 0.2, 1 - warm * 0.08, 1 - warm * 0.38);
		ocean.setTimeOfDay(_sunDir, _skyTint, _sunTint);
		_lightDir.copyFrom(_sunDir);
		_lightDir.scaleInPlace(-1);
		sun.direction.copyFrom(_lightDir);
		_sunWarm.set(1, 1 - warm * 0.12, 1 - warm * 0.34);
		sun.diffuse.copyFrom(_sunWarm);

		// Kick the far-field clutter out once we know where the player actually
		// is. Near clutter is never re-seated — it stays put in world space so it
		// sweeps past the hull, which is what makes speed readable.
		const selfPos = ships.getSelfPosition(net.selfShipId);

		// Chase cam behind the player's own hull.
		const self = selfPos;
		if (self) {
			const h = ships.getSelfHeading(net.selfShipId) ?? 0;
			// Estimate hull speed from the hull's own per-frame travel (the
			// extrapolated visual position, so it is smooth and frame-rate safe).
			let spd = 0;
			if (hasLastSelf) {
				spd = Math.hypot(self.x - lastSelf.x, self.z - lastSelf.z) / Math.max(dt, 1e-4);
			}
			lastSelf.copyFrom(self);
			hasLastSelf = true;

			// Feed the near clutter the hull's real world velocity (heading × speed)
			// so the sea debris parts at the bow and gets shoved aside instead of
			// sailing straight through the deck.
			ships.followClutter(self.x, self.z, Math.sin(h) * spd, Math.cos(h) * spd, dt);

			// A chase cam that tracks the hull EXACTLY is the whole reason the boat
			// reads as stationary: pinned to a fixed screen spot, it has zero
			// relative motion, so only the world moves and the eye concludes the
			// boat is parked. Instead the camera EASES toward its offset with a
			// first-order lag. A lagging follower settles a fixed distance BEHIND a
			// moving target, and that distance grows with speed — so as she picks up
			// way the hull visibly surges forward in frame toward whatever lies
			// ahead, then settles once she is at speed. That is the "boat going to
			// meet the objects" cue the rigid lock was destroying.
			const dist = 30;
			const height = 11;
			const desired = new Vector3(
				self.x - Math.sin(h) * dist,
				self.y + height,
				self.z - Math.cos(h) * dist
			);
			if (!hasCamInit) {
				camPos.copyFrom(desired);
				hasCamInit = true;
			} else {
				// Faster lag (shorter time constant) so the hull is dragged along by a
				// camera that keeps real world speed instead of hovering in lockstep —
				// the small persistent gap is what makes her look like she is driving.
				const k = 1 - Math.exp(-dt / 0.5);
				Vector3.LerpToRef(camPos, desired, k, camPos);
			}
			camera.position.copyFrom(camPos);

			// Camera shake: jitter the ACTUAL camera off its smoothed base position
			// (camPos itself stays clean, so the follow never drifts). Applied before
			// setTarget so the aim recomputes from the shaken position — the view
			// wobbles as well as translates. Decays on real time so it survives hit-stop.
			if (shake > 0.0001) {
				const sx = (Math.random() * 2 - 1) * shake;
				const sy = (Math.random() * 2 - 1) * shake * 0.7;
				camera.position.x += sx;
				camera.position.y += sy;
				shake = Math.max(0, shake - raw * 3.4);
			} else {
				shake = 0;
			}

			// Broadside recoil kick (task #140): shove the cam straight back along its
			// own sight line and dip the lens a touch for a short beat, decaying fast so
			// it reads as the guns' ordered shove, not the random wobble of `shake`. Also
			// applied to the ACTUAL camera only, so the smoothed base (camPos) never drifts.
			if (muzzleKick > 0.0005) {
				const back = camera.getDirection(_camBack);
				const amp = muzzleKick * 0.9;
				camera.position.x += back.x * amp;
				camera.position.y += back.y * amp;
				camera.position.z += back.z * amp;
				muzzleKick *= Math.exp(-raw / 0.09);
			} else {
				muzzleKick = 0;
			}

			// Look FORWARD and slightly down the heading, not down the stern. The
			// hull sits low in frame and a long stretch of sea runs toward the bow,
			// so debris and crests LOOM larger as they approach — looming is the
			// single strongest signal that WE are the thing moving.
			//
			// `look` = hull heading + the mouse-steered yaw offset. The camera still
			// trails the hull on its actual heading, so panning the view swings the
			// aim port/starboard around the ship instead of dragging the whole chase
			// cam sideways — the broadside comes to bear while she holds her course.
			const aimAhead = 70;
			const aimHeight = 1.5;
			// Ease the view back toward the bow once the mouse has been still for a
			// moment, so a stale pan no longer makes steering overshoot the thing you
			// were looking at. Frequent mouse nudges (a firefight) reset aimYawIdle and
			// keep the broadside aim held.
			aimYawIdle += dt;
			if (aimYawIdle > 0.5) aimYaw *= Math.exp(-dt / 2.5);
			const look = h + aimYaw;
			const aim = new Vector3(
				self.x + Math.sin(look) * aimAhead,
				self.y + aimHeight,
				self.z + Math.cos(look) * aimAhead
			);
			camera.setTarget(aim);

			// Bank into the turn: derive the hull's turn RATE from the heading delta
			// (wrapped to the shortest arc), lean the view by that rate, and ease so a
			// flick of the helm doesn't snap the horizon. FreeCamera's rotation.z is
			// roll around the view axis, and setTarget only writes x/y — so setting it
			// AFTER setTarget rolls the framed horizon toward the inside of the turn.
			let dHead = h - lastHeading;
			if (dHead > Math.PI) dHead -= Math.PI * 2;
			else if (dHead < -Math.PI) dHead += Math.PI * 2;
			const turnRate = hasHeading ? dHead / Math.max(dt, 1e-4) : 0;
			lastHeading = h;
			hasHeading = true;
			// BANK_MAX ~ 15deg: enough to read as carving without tilting the sea oddly.
			const BANK_MAX = 0.26;
			let targetBank = -turnRate * 0.5;
			if (targetBank > BANK_MAX) targetBank = BANK_MAX;
			else if (targetBank < -BANK_MAX) targetBank = -BANK_MAX;
			camBank += (targetBank - camBank) * (1 - Math.exp(-dt / 0.35));
			camera.rotation.z = camBank;

			// Guns track the camera's look direction, not the hull's heading, so the
			// player can bring a broadside to bear by steering the view. Same
			// atan2(sin, cos) convention the ship heading and the server solve use.
			aimHeading = Math.atan2(aim.x - camera.position.x, aim.z - camera.position.z);

			// Speed-driven FOV: widening the lens with velocity pushes the frame
			// edges outward (radial optic flow), which the brain reads as speed even
			// when the hull itself barely changes size.
			const targetFov = 0.85 + Math.min(1, spd / 14) * 0.16;
			camera.fov += (targetFov - camera.fov) * (1 - Math.exp(-dt / 0.4));
			// Recoil punch (task #140): a brief lens dip synced to the muzzle kick so
			// the discharge reads as a shove into the frame, then recover.
			if (muzzleKick > 0.0005) camera.fov -= muzzleKick * 0.05;

			// Spyglass (task #145): runs AFTER the speed-FOV easing above so, while
			// raised, it steers the lens down to the telephoto value and refreshes the
			// readout. No-ops when inactive (the loop's own easing owns the FOV then).
			spyglass.update(dt);
		}

		// HUD: pull the authoritative self-state for the readouts. Classification
		// is NPC-for-now; own/alliance tiers light up with ownership (P4/P6).
		// Port proximity is server-authoritative (shared PORT_DEFS gate the off-chain
		// unload/repair), so the prompt and the world markers agree with the rules.
		const selfState = net.selfShipId ? ships.getState(net.selfShipId) : null;
		// Drive the sail-gear readout (task #138) from the authoritative echoed gear.
		let gearEl2 = ensureGearHud();
		if (gearEl2) {
			const g = selfState?.gear;
			gearEl2.textContent = g ? `Sail · ${SAIL_GEARS[g].label}` : "Sail · —";
			gearEl2.style.opacity = selfState ? "1" : "0";
		}
		// Spyglass HUD button (task #145): only present while sailing, and it lights
		// up to mirror the raised state so mouse/touch players see the glass is held.
		const sgBtn = ensureSpyglassButton();
		if (sgBtn) {
			sgBtn.style.opacity = selfState && !paused ? "1" : "0";
			sgBtn.style.pointerEvents = selfState && !paused ? "auto" : "none";
			sgBtn.style.background = spyglass.active ? "rgba(230,192,121,0.85)" : "rgba(12,18,26,0.55)";
			sgBtn.style.color = spyglass.active ? "#0b1018" : "#e6c079";
		}
		let nearestPortName: string | null = null;
		let portBearing: number | null = null;
		if (selfPos) {
			// Nearest harbour by raw distance — used both for the in-range dock
			// prompt and to always point the compass waypoint at where to sail.
			let best = Infinity;
			let nearest: (typeof PORT_DEFS)[number] | null = null;
			for (const p of PORT_DEFS) {
				const d = Math.hypot(p.x - selfPos.x, p.z - selfPos.z);
				if (d < best) {
					best = d;
					nearest = p;
				}
				if (d <= PORT_RADIUS) {
					nearestPortName = p.name;
				}
			}
			if (nearest) {
				// World bearing in the same 0=N degrees frame the compass cardinals use:
				// heading θ is defined by x=sinθ, z=cosθ, so atan2(dx, dz) is the
				// bearing to the target and feeds straight into the strip's rel math.
				portBearing = (Math.atan2(nearest.x - selfPos.x, nearest.z - selfPos.z) * 180) / Math.PI;
			}
		}
		nearPort = nearestPortName !== null;
		curWeapon = weaponForSelfAim();
		ui.update(
			{
				selfId: net.selfShipId,
				selfState,
				states: ships.getLatestStates(),
				weather: wNow,
				connected: net.connected,
				nearestPort: nearestPortName,
				portBearing,
				weapon: curWeapon,
				ammo: curAmmo,
				safeZone: nearPort,
			},
			(s) => (s.id === net.selfShipId ? "self" : "npc")
		);
		if (lastPlayer) ui.setPlayer(lastPlayer, selfState?.cargo ?? 0);

		// --- Combat music: a separate looped bed that takes over the music bus while
		// a fight is live. Aggressive when WE are shooting (Splintered_Timber),
		// defensive when we're only being hit and running (Where_the_Tide_Breaks);
		// it stops once both recency windows lapse (out of danger / fighting ends).
		// The sea shanty yields to it so two songs never play at once. ---
		let combatMode: "none" | "attack" | "flee" = "none";
		if (phase === "playing" && !paused && !dock.isVisible()) {
			if (isAttacking()) combatMode = "attack";
			else if (isUnderAttack()) combatMode = "flee";
		}
		audio.setCombat(combatMode);

		// --- Sea shanties: sing along only when she's driving hard AND the sky is
		// fair. Edge-triggered inside audio, so calling every frame is cheap. ---
		const atFullSpeed = phase === "playing" && !paused && !dock.isVisible() && inp.throttle >= 0.95;
		const stormActive = wNow.rainIntensity > 0.5 || wNow.waveAmplitude > 1.7;
		audio.setMusic(combatMode === "none" && atFullSpeed && !stormActive);

		// --- Fleet wipe: the player owns hulls but NONE are still afloat (all sunk)
		// -> raise the pause menu (forced, past the under-attack block) so the
		// merchant/shop is one click away. Fires only on the transition INTO the
		// wiped state, never while already paused or on the title screen. ---
		if (phase === "playing" && net.address && !paused && !dock.isVisible()) {
			const mine = ships.getLatestStates().filter((s) => s.ownerAddress === net.address);
			const anyUsable = mine.some((s) => s.status === "active" || s.status === "on_auto");
			const wiped = mine.length > 0 && !anyUsable;
			if (wiped && !wasWiped) setPaused(true, true);
			wasWiped = wiped;
		}

		scene.render();
	}

	const onResize = () => engine.resize();
	window.addEventListener("resize", onResize);

	return {
		startPlaying,
		cancelJoin,
		applySettings,
		connectWallet,
		getGamepadStatus: () => input.getGamepadStatus(),
		openShop: () => dock.show(),
		closeShop: () => dock.hide(),
		canPlay,
		refreshOwnership,
		usdgBalance,
		buyHull,
		getLedger: () => lastPlayer,
		ownedHullCount: () => ownedShipCount,
		buyItem: (itemId: string) => net.buyItem(itemId),
		equipItem: (itemId: string, equipped: boolean) => net.equipItem(itemId, equipped),
		dispose() {
			window.removeEventListener("resize", onResize);
			canvas.removeEventListener("pointerdown", onPointerDown);
			canvas.removeEventListener("pointermove", onPointerMove);
			window.removeEventListener("keydown", onKeySpyglass);
			gearEl?.remove();
			spyglassBtn?.remove();
			spyglass.dispose();
			input.dispose();
			wallet.dispose();
			net.disconnect();
			grade.dispose();
			dock.dispose();
			pause.dispose();
			parley.dispose();
			fleet.dispose();
			touch.dispose();
			ui.dispose();
			combat.dispose();
			vfx.dispose();
			ships.dispose();
			islands.dispose();
			forts.dispose();
			ocean.dispose();
			weather.dispose();
			audio.dispose();
			scene.dispose();
			engine.dispose();
		},
	};
}
