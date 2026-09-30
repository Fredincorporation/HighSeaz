import { SAIL_GEAR_ORDER, type SailGear } from "@shared/index";

/**
 * Unified player input. Abstracts three physical devices — keyboard, gamepad and
 * touch — into one small set of game ACTIONS, so the rest of the game never
 * inspects raw keys/buttons:
 *
 *   throttle   0..1   sail set (a sailing hull has no reverse gear, so no negative)
 *   rudder    -1..1   tiller, left negative / right positive
 *   fire      edge    one broadside order this frame
 *   pause     edge    toggle the pause menu this frame
 *   interact  edge    open/close the dock menu this frame
 *   gearOrder SailGear  edge — a discrete sail ORDER chosen this frame (1..4 / [ ])
 *
 * Continuous channels (helm) are the LATEST of whichever device is active; the
 * discrete edges are OR-ed across devices. Touch UI writes into this class via
 * setTouchStick/pressTouch*; the Gamepad API is polled in read() each frame.
 *
 * Gamepad plug/unplug events are surfaced to the UI via onGamepadChange so the
 * settings panel can show the currently-connected pad (if any) and let players
 * see that their controller is being picked up. The browser's Gamepad API is
 * polled in `pollGamepad()` each frame; the `gamepadconnected`/`gamepad-
 * disconnected` window events fire the callback.
 */

export interface FrameInput {
	throttle: number;
	rudder: number;
	fire: boolean;
	pause: boolean;
	interact: boolean;
	/** Demand surrender terms of the nearest rival player hull in range (P / Y). */
	parley: boolean;
	/**
	 * A discrete sail ORDER chosen THIS frame (edge), or null when the captain did
	 * not change gear. Keys 1..4 pick Stop/Half/Full/Travel outright; [ and ] cycle
	 * down/up the ladder. The consumer (createGame) sends `net.sendGear(gearOrder)`
	 * only when this is non-null, so the canonical order is explicit, not held.
	 */
	gearOrder: SailGear | null;
	/** Right-stick horizontal deflection (-1..1, deadzoned) for camera look/pan. */
	lookX: number;
	/** Menu-navigation edges: D-pad / arrow keys move, A / Enter confirms. These
	 *  are read by the in-game (Babylon GUI) pause menu, which has no pointer-only
	 *  keyboard focus of its own; the DOM meta-menus use their own gamepad hook. */
	uiUp: boolean;
	uiDown: boolean;
	uiConfirm: boolean;
}

/** Analog deadzone so a resting/centred stick reads as zero, not drift. */
const DEADZONE = 0.15;

function applyDeadzone(v: number): number {
	return Math.abs(v) < DEADZONE ? 0 : v;
}

export class InputManager {
	private keys = new Set<string>();
	/** One-shot flags set by touch buttons, consumed by the next read(). */
	private touchFire = false;
	private touchPause = false;
	private touchInteract = false;
	private touchStick = { throttle: 0, rudder: 0 };
	/** Previous-frame held state for the discrete channels, so we can emit edges. */
	private prevFireHeld = false;
	private prevPauseHeld = false;
	private prevInteractHeld = false;
	private prevParleyHeld = false;
	private prevUpHeld = false;
	private prevDownHeld = false;
	private prevConfirmHeld = false;
	/**
	 * The sail ladder position the [ / ] cycle keys move through (index into
	 * SAIL_GEAR_ORDER). Starts at "half" — the easy cruise default — so a captain
	 * who only ever taps [ / ] gets a sensible sequence even before touching 1..4.
	 */
	private gearIndex = 1;
	/** Held-state of the gear keys last frame, so 1..4 / [ ] fire only on the press. */
	private prevGearKeys = new Set<string>();
	private disposed = false;
	/** Human-readable id of the first connected pad, kept fresh by the browser
	 *  gamepad events so the settings panel can show it without polling. */
	private padId: string | null = null;
	/** Fired whenever a pad connects or disconnects (with the new id, or null). */
	public onGamepadChange: ((id: string | null) => void) | null = null;

	private readonly onPadConnected = (e: GamepadEvent) => {
		this.padId = e.gamepad.id || "Gamepad";
		this.onGamepadChange?.(this.padId);
	};
	private readonly onPadDisconnected = () => {
		// The event doesn't say WHICH pad left; re-poll the remaining ones so a
		// multi-pad setup keeps reporting a live device instead of going blank.
		const pad = this.pollGamepad();
		const next = pad ? pad.id || "Gamepad" : null;
		if (next !== this.padId) {
			this.padId = next;
			this.onGamepadChange?.(next);
		}
	};

	private readonly onKeyDown = (e: KeyboardEvent) => {
		const k = e.key.toLowerCase();
		// Space is the fire trigger; arrows pan the aim / navigate menus. Stop both
		// from scrolling the page. Enter is left native so DOM buttons still activate.
		if (k === " " || k === "arrowup" || k === "arrowdown") e.preventDefault();
		if (!this.keys.has(k)) this.onActivity?.();
		this.keys.add(k);
	};
	private readonly onKeyUp = (e: KeyboardEvent) => {
		this.keys.delete(e.key.toLowerCase());
	};
	/** Losing focus leaves keys stuck "down" — clear them so the helm centres. */
	private readonly onBlur = () => this.keys.clear();

	/** Fired the first time any input arrives in a session (to unlock audio). */
	public onActivity: (() => void) | null = null;

	constructor() {
		if (typeof window !== "undefined") {
			window.addEventListener("keydown", this.onKeyDown);
			window.addEventListener("keyup", this.onKeyUp);
			window.addEventListener("blur", this.onBlur);
			window.addEventListener("gamepadconnected", this.onPadConnected);
			window.addEventListener("gamepaddisconnected", this.onPadDisconnected);
			// A pad already plugged in before this manager existed won't fire an
			// event, so seed the current state once up front.
			const pad = this.pollGamepad();
			if (pad) this.padId = pad.id || "Gamepad";
		}
	}

	/** Current controller state for the settings panel. `connected` is true only
	 *  while a pad is present; `id` is the browser-reported device name. */
	getGamepadStatus(): { connected: boolean; id: string | null } {
		return { connected: this.padId !== null, id: this.padId };
	}

	/** Called by the mobile virtual stick with its current -1..1 deflection. */
	setTouchStick(throttle: number, rudder: number): void {
		this.touchStick.throttle = throttle;
		this.touchStick.rudder = rudder;
	}

	pressTouchFire(): void {
		this.touchFire = true;
		this.onActivity?.();
	}
	pressTouchPause(): void {
		this.touchPause = true;
		this.onActivity?.();
	}
	pressTouchInteract(): void {
		this.touchInteract = true;
		this.onActivity?.();
	}

	/** Sample every device and return this frame's action state. Call once/frame. */
	read(): FrameInput {
		// --- Continuous helm: keyboard, then gamepad, then touch (last wins) ---
		let throttle = this.keys.has("w") ? 1 : 0;
		let rudder = (this.keys.has("d") ? 1 : 0) - (this.keys.has("a") ? 1 : 0);

		let fireHeld = this.keys.has(" ");
		let pauseHeld = this.keys.has("escape");
		let interactHeld = this.keys.has("e");
		let parleyHeld = this.keys.has("p");

		// Camera look/pan (right stick) + menu nav (D-pad / arrows, A / Enter).
		let lookX = 0;
		let upHeld = this.keys.has("arrowup");
		let downHeld = this.keys.has("arrowdown");
		let confirmHeld = this.keys.has("enter");

		const pad = this.pollGamepad();
		if (pad) {
			// Chrome only exposes a pad via getGamepads() AFTER the user presses a
			// button on it, and can miss the `gamepadconnected` event entirely. Poll
			// the id here so the settings panel lights "Connected" the moment the pad
			// is actually feeding input, not only when the event happened to fire.
			const id = pad.id || "Gamepad";
			if (this.padId !== id) {
				this.padId = id;
				this.onGamepadChange?.(id);
			}
			// Left stick: Y up = forward (invert + clamp to no-reverse), X = rudder.
			const y = applyDeadzone(pad.axes[1] ?? 0);
			const x = applyDeadzone(pad.axes[0] ?? 0);
			if (y !== 0) throttle = Math.max(0, -y);
			if (x !== 0) rudder = x;
			// Right trigger (7) or A (0) fires; Start (9) pauses; X (2) interacts.
			if (btn(pad, 7) || btn(pad, 0)) fireHeld = true;
			if (btn(pad, 9)) pauseHeld = true;
			if (btn(pad, 2)) interactHeld = true;
			// Y (3) demands surrender terms of the nearest rival (parity with P).
			if (btn(pad, 3)) parleyHeld = true;
			// Right stick X pans the camera (createGame folds it into aimYaw like the
			// mouse). Menu nav: D-pad up/down (12/13) or, as a convenience, the left
			// stick Y, plus A (0) to confirm — consumed only while the pause menu is up.
			lookX = applyDeadzone(pad.axes[2] ?? 0);
			if (btn(pad, 12)) upHeld = true;
			if (btn(pad, 13)) downHeld = true;
			if (btn(pad, 0)) confirmHeld = true;
		}

		if (this.touchStick.throttle !== 0 || this.touchStick.rudder !== 0) {
			throttle = this.touchStick.throttle;
			rudder = this.touchStick.rudder;
		}
		if (this.touchFire) fireHeld = true;
		if (this.touchPause) pauseHeld = true;
		if (this.touchInteract) interactHeld = true;

		// --- Sail gear ORDERS (task #138) ------------------------------------
		// 1..4 pick Stop/Half/Full/Travel outright; [ and ] walk the ladder. Only
		// fires on the transition into a press, so holding a key doesn't spam orders.
		let gearOrder: SailGear | null = null;
		const gearKeys = ["1", "2", "3", "4", "[", "]"];
		for (const gk of gearKeys) {
			if (!this.keys.has(gk) || this.prevGearKeys.has(gk)) continue;
			if (gk >= "1" && gk <= "4") {
				this.gearIndex = Number(gk) - 1;
			} else if (gk === "]") {
				this.gearIndex = Math.min(SAIL_GEAR_ORDER.length - 1, this.gearIndex + 1);
			} else if (gk === "[") {
				this.gearIndex = Math.max(0, this.gearIndex - 1);
			}
			gearOrder = SAIL_GEAR_ORDER[this.gearIndex] ?? null;
		}
		// Snapshot which gear keys are down now, for next frame's edge test.
		this.prevGearKeys = new Set(gearKeys.filter((k) => this.keys.has(k)));

		const frame: FrameInput = {
			throttle,
			rudder,
			fire: fireHeld && !this.prevFireHeld,
			pause: pauseHeld && !this.prevPauseHeld,
			interact: interactHeld && !this.prevInteractHeld,
			parley: parleyHeld && !this.prevParleyHeld,
			gearOrder,
			lookX,
			uiUp: upHeld && !this.prevUpHeld,
			uiDown: downHeld && !this.prevDownHeld,
			uiConfirm: confirmHeld && !this.prevConfirmHeld,
		};

		this.prevFireHeld = fireHeld;
		this.prevPauseHeld = pauseHeld;
		this.prevInteractHeld = interactHeld;
		this.prevParleyHeld = parleyHeld;
		this.prevUpHeld = upHeld;
		this.prevDownHeld = downHeld;
		this.prevConfirmHeld = confirmHeld;
		// Touch one-shots clear after being folded into this frame.
		this.touchFire = false;
		this.touchPause = false;
		this.touchInteract = false;
		return frame;
	}

	/** First connected, non-disconnected gamepad, or null. */
	private pollGamepad(): Gamepad | null {
		if (typeof navigator === "undefined" || !navigator.getGamepads) return null;
		const pads = navigator.getGamepads();
		for (const p of pads) if (p && p.connected) return p;
		return null;
	}

	dispose(): void {
		if (this.disposed) return;
		this.disposed = true;
		if (typeof window !== "undefined") {
			window.removeEventListener("keydown", this.onKeyDown);
			window.removeEventListener("keyup", this.onKeyUp);
			window.removeEventListener("blur", this.onBlur);
			window.removeEventListener("gamepadconnected", this.onPadConnected);
			window.removeEventListener("gamepaddisconnected", this.onPadDisconnected);
		}
	}
}

/** Whether a gamepad button index is currently held (safe if absent). */
function btn(pad: Gamepad, index: number): boolean {
	return pad.buttons[index]?.pressed ?? false;
}
