import { Scene } from "@babylonjs/core";
import { AdvancedDynamicTexture, Button, Control, Rectangle, StackPanel, TextBlock } from "@babylonjs/gui";

/**
 * The pause menu — a full-screen dimmed overlay with a centred panel, the
 * convention players expect from an AAA game. Opened with Esc (keyboard), Start
 * (gamepad) or the on-screen pause icon (touch); closed by Resume or the same
 * toggle. It owns a SEPARATE fullscreen GUI texture from the HUD so it never
 * disturbs the in-world markers, and its dim backdrop absorbs pointer events so
 * a click that opens/closes the menu doesn't also fire a broadside.
 *
 * This is a MENU, not a single-player freeze: the world is authoritative on the
 * server, so other players keep sailing. Pausing only stops THIS player's helm
 * and gunnery input (createGame handles that) and shows the panel.
 */
export class PauseMenu {
	private ui: AdvancedDynamicTexture;
	private root: Rectangle;
	/** Navigable action rows, in on-screen order, for gamepad/keyboard focus. */
	private entries: { btn: Button; run: () => void; base: string }[] = [];
	private selected = -1;

	constructor(
		scene: Scene,
		private handlers: {
			onResume: () => void;
			onRestart: () => void;
			onSettings?: () => void;
			onHowTo?: () => void;
			onShop?: () => void;
			onFleet?: () => void;
			onFaucet?: () => void;
		}
	) {
		this.ui = AdvancedDynamicTexture.CreateFullscreenUI("hs-pause", true, scene);

		// Full-screen dim backdrop. `isHitTestVisible` (default true) means it
		// swallows clicks, so nothing reaches the canvas behind it.
		this.root = new Rectangle("pauseRoot");
		this.root.width = "100%";
		this.root.height = "100%";
		this.root.color = "transparent";
		this.root.background = "rgba(3,7,12,0.72)";
		this.root.thickness = 0;
		this.root.isVisible = false;
		this.ui.addControl(this.root);

		// Explicit pixel height: a Rectangle sized "auto"/"adaptive" around a
		// vertical StackPanel measures to NaN, and that NaN cascades through the
		// ADT's root layout so the WHOLE overlay draws nothing (same trap as the
		// HUD). A fixed height keeps every child measurable.
		const panel = new Rectangle("pausePanel");
		panel.width = "340px";
		panel.height = "720px";
		panel.cornerRadius = 14;
		panel.background = "rgba(8,14,24,0.96)";
		panel.color = "rgba(150,190,225,0.55)";
		panel.thickness = 1;
		panel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		panel.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
		this.root.addControl(panel);

		const stack = new StackPanel("pauseStack");
		stack.isVertical = true;
		stack.width = "100%";
		stack.height = "100%";
		stack.spacing = 10;
		stack.paddingTop = "22px";
		stack.paddingBottom = "22px";
		stack.paddingLeft = "22px";
		stack.paddingRight = "22px";
		panel.addControl(stack);

		stack.addControl(this.label("PAUSED", 26, "#eaf3ff", "center", true));
		stack.addControl(this.label("Sail, trade, or sink — the sea waits.", 13, "#8aa3bd", "center", false));
		stack.addControl(this.spacer(6));

		stack.addControl(this.button("Resume", () => this.handlers.onResume()));
		stack.addControl(this.button("Merchant / Shop", () => this.handlers.onShop?.()));
		stack.addControl(this.button("Fleet / Take the helm", () => this.handlers.onFleet?.()));
		stack.addControl(this.button("How to Play", () => this.handlers.onHowTo?.()));
		stack.addControl(this.button("Testnet Faucet", () => this.handlers.onFaucet?.()));
		stack.addControl(this.button("Settings", () => this.handlers.onSettings?.()));
		stack.addControl(this.button("Restart", () => this.handlers.onRestart()));
		stack.addControl(this.spacer(10));

		// Controls legend — kept short and device-honest (keyboard + gamepad).
		stack.addControl(this.label("CONTROLS", 13, "#c9d6e6", "left", true));
		stack.addControl(this.legend("Sail", "W / S  ·  Left stick"));
		stack.addControl(this.legend("Steer", "A / D  ·  Left stick"));
		stack.addControl(this.legend("Look", "Mouse  ·  Right stick"));
		stack.addControl(this.legend("Fire", "Space / Click  ·  RT / A"));
		stack.addControl(this.legend("Dock", "E  ·  X button"));
		stack.addControl(this.legend("Pause", "Esc  ·  Start"));
		stack.addControl(this.legend("Menu", "↑↓ + Enter  ·  D-pad + A"));
	}

	private label(text: string, size: number, color: string, align: "left" | "center", bold: boolean): TextBlock {
		const t = new TextBlock("lbl", text);
		t.fontSize = `${size}px`;
		t.color = color;
		t.fontWeight = bold ? "bold" : "normal";
		t.width = "100%";
		// Explicit height: a vertical StackPanel cannot lay out a child whose
		// height is percentage/undefined — it overlaps its siblings.
		t.height = `${size + 8}px`;
		t.textHorizontalAlignment = align === "center" ? Control.HORIZONTAL_ALIGNMENT_CENTER : Control.HORIZONTAL_ALIGNMENT_LEFT;
		t.shadowBlur = 3;
		t.shadowColor = "#000";
		return t;
	}

	private legend(action: string, keys: string): TextBlock {
		const t = new TextBlock("lg", `${action}:  ${keys}`);
		t.fontSize = "12px";
		t.color = "#9fb6cc";
		t.width = "100%";
		t.height = "20px";
		t.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		return t;
	}

	private spacer(px: number): Rectangle {
		const r = new Rectangle("sp");
		r.width = "100%";
		r.height = `${px}px`;
		r.color = "transparent";
		r.background = "transparent";
		return r;
	}

	private button(text: string, onClick: () => void): Button {
		const btn = Button.CreateSimpleButton("btn", text);
		btn.width = "100%";
		btn.height = "40px";
		btn.cornerRadius = 8;
		btn.background = "rgba(30,60,90,0.95)";
		btn.color = "#eaf3ff";
		btn.fontSize = "16px";
		btn.fontWeight = "bold";
		btn.thickness = 1;
		btn.onPointerClickObservable.add(() => onClick());
		this.entries.push({ btn, run: onClick, base: btn.background });
		return btn;
	}

	/** Paint the gold focus row (same language as the DOM menus) on `i`, dim the rest. */
	private paint(): void {
		for (let i = 0; i < this.entries.length; i++) {
			const e = this.entries[i];
			if (i === this.selected) {
				e.btn.background = "#e6c079";
				e.btn.color = "#0a1526";
			} else {
				e.btn.background = e.base;
				e.btn.color = "#eaf3ff";
			}
		}
	}

	/** Move the focus ring by `delta` (wraps); no-op when the menu is hidden. */
	move(delta: number): void {
		if (!this.root.isVisible || this.entries.length === 0) return;
		if (this.selected < 0) this.selected = 0;
		else this.selected = (this.selected + delta + this.entries.length) % this.entries.length;
		this.paint();
	}

	/** Activate the focused row (Enter / A). */
	confirm(): void {
		if (!this.root.isVisible) return;
		const e = this.entries[this.selected];
		if (e) e.run();
	}

	isVisible(): boolean {
		return this.root.isVisible;
	}

	setVisible(v: boolean): void {
		this.root.isVisible = v;
		// (Re)opening starts focus on the first row (Resume); closing clears the ring.
		this.selected = v ? 0 : -1;
		this.paint();
	}

	dispose(): void {
		this.ui.dispose();
	}
}
