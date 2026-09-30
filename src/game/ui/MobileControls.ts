import { Scene, PointerEventTypes } from "@babylonjs/core";
import { AdvancedDynamicTexture, Button, Control, Rectangle } from "@babylonjs/gui";
import type { InputManager } from "../input/InputManager";

/**
 * On-screen touch controls for phones/tablets: a left virtual thumb-stick that
 * writes throttle/rudder straight into the InputManager, and a right FIRE button
 * that raises a fire edge. Shown only on coarse-pointer (touch) devices — on a
 * desktop the keyboard/gamepad/mouse path is used and this stays hidden.
 *
 * It owns its own fullscreen GUI texture so it never disturbs the world markers,
 * and the stick reads the pointer in GUI-pixel space (which matches the canvas
 * CSS-pixel space) to compute deflection from the base's centre.
 */
const STICK_SIZE = 150;
const KNOB_SIZE = 64;
/** How far the knob trails the finger, as a fraction of the stick radius. */
const KNOB_TRAVEL = 0.42;

export class MobileControls {
	private ui: AdvancedDynamicTexture;
	private root: Rectangle;
	private base: Rectangle;
	private knob: Rectangle;
	private stickActive = false;
	private centerX = 0;
	private centerY = 0;
	private radius = STICK_SIZE / 2;
	private readonly onMove: (ev: { type: number; event: PointerEvent }) => void;
	private readonly onUp: () => void;

	constructor(
		scene: Scene,
		private input: InputManager
	) {
		this.ui = AdvancedDynamicTexture.CreateFullscreenUI("hs-touch", true, scene);

		this.root = new Rectangle("touchRoot");
		this.root.width = "100%";
		this.root.height = "100%";
		this.root.color = "transparent";
		this.root.background = "transparent";
		this.root.thickness = 0;
		// Hidden until createGame confirms a touch device.
		this.root.isVisible = false;
		this.ui.addControl(this.root);

		// ---- Left thumb-stick ----
		this.base = new Rectangle("stickBase");
		this.base.width = `${STICK_SIZE}px`;
		this.base.height = `${STICK_SIZE}px`;
		this.base.cornerRadius = STICK_SIZE / 2;
		this.base.background = "rgba(255,255,255,0.08)";
		this.base.color = "rgba(200,225,255,0.35)";
		this.base.thickness = 2;
		this.base.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		this.base.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
		this.base.paddingLeft = "26px";
		this.base.paddingBottom = "26px";
		this.root.addControl(this.base);

		this.knob = new Rectangle("stickKnob");
		this.knob.width = `${KNOB_SIZE}px`;
		this.knob.height = `${KNOB_SIZE}px`;
		this.knob.cornerRadius = KNOB_SIZE / 2;
		this.knob.background = "rgba(200,225,255,0.35)";
		this.knob.color = "transparent";
		this.knob.thickness = 0;
		this.knob.isHitTestVisible = false; // the base owns the pointer
		this.base.addControl(this.knob);

		this.base.onPointerDownObservable.add(() => {
			// getAbsolutePosition returns the control's top-left in GUI pixel space
			// (== canvas CSS pixels for a fullscreen ADT). The base is fixed-size, so
			// derive the centre/radius from STICK_SIZE rather than the returned point.
			const abs = (this.base as unknown as { getAbsolutePosition: () => { x: number; y: number } }).getAbsolutePosition();
			this.centerX = abs.x + STICK_SIZE / 2;
			this.centerY = abs.y + STICK_SIZE / 2;
			this.radius = STICK_SIZE / 2;
			this.stickActive = true;
		});

		// ---- Right fire button ----
		const fire = Button.CreateSimpleButton("fireBtn", "FIRE");
		fire.width = "96px";
		fire.height = "96px";
		fire.cornerRadius = 48;
		fire.background = "rgba(180,60,50,0.55)";
		fire.color = "#ffe9e6";
		fire.fontSize = "18px";
		fire.fontWeight = "bold";
		fire.thickness = 2;
		fire.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_RIGHT;
		fire.verticalAlignment = Control.VERTICAL_ALIGNMENT_BOTTOM;
		fire.paddingRight = "30px";
		fire.paddingBottom = "30px";
		fire.onPointerDownObservable.add(() => this.input.pressTouchFire());
		this.root.addControl(fire);

		// Track the finger across the whole canvas while the stick is held, and
		// release on any up — so dragging off the base still steers.
		this.onMove = (ev) => {
			if (!this.stickActive) return;
			const pe = ev.event;
			this.applyStick(pe.clientX, pe.clientY);
		};
		this.onUp = () => {
			if (!this.stickActive) return;
			this.stickActive = false;
			this.knob.left = 0;
			this.knob.top = 0;
			this.input.setTouchStick(0, 0);
		};
		scene.onPointerObservable.add((pi) => {
			if (pi.type === PointerEventTypes.POINTERMOVE) this.onMove(pi as unknown as { type: number; event: PointerEvent });
			else if (pi.type === PointerEventTypes.POINTERUP) this.onUp();
		});
	}

	private applyStick(clientX: number, clientY: number): void {
		let dx = clientX - this.centerX;
		let dy = clientY - this.centerY;
		const dist = Math.hypot(dx, dy);
		if (dist > this.radius) {
			dx = (dx / dist) * this.radius;
			dy = (dy / dist) * this.radius;
		}
		this.knob.left = dx * KNOB_TRAVEL;
		this.knob.top = dy * KNOB_TRAVEL;
		// Up on screen is forward: invert Y. No reverse gear, so clamp to [0,1].
		const rudder = Math.max(-1, Math.min(1, dx / this.radius));
		const throttle = Math.max(0, Math.min(1, -dy / this.radius));
		this.input.setTouchStick(throttle, rudder);
	}

	setVisible(v: boolean): void {
		this.root.isVisible = v;
	}

	/** True on touch-first devices (phones/tablets); desktops use keyboard/gamepad. */
	static isTouchDevice(): boolean {
		if (typeof window === "undefined") return false;
		return (
			(window.matchMedia && window.matchMedia("(pointer: coarse)").matches) ||
			"ontouchstart" in window
		);
	}

	dispose(): void {
		this.ui.dispose();
	}
}
