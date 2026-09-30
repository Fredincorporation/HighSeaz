import { Scene } from "@babylonjs/core";
import { AdvancedDynamicTexture, Button, Control, Rectangle, StackPanel, TextBlock } from "@babylonjs/gui";

/** One row the captain can act on: an owned, afloat hull other than the one they
 *  already steer. "At the helm" hulls are shown as a label, not a button. */
export interface FleetHull {
	shipId: string;
	name: string;
	/** Short display line, e.g. `Brigantine · 312m off`. */
	detail: string;
	/** True when this is the hull the client currently controls. */
	isSelf: boolean;
}

/**
 * The fleet / take-the-helm panel — the "own many, sail one" handover UI. Lists
 * every one of this captain's owned hulls that is afloat; the one under control
 * reads "At the helm", the rest offer "Take the helm" (the old hull drops to
 * auto ghost-fleet mode and the target becomes player-driven).
 *
 * Same full-screen dimmed-overlay convention as the pause menu, and it owns a
 * SEPARATE ADT texture so it never disturbs the in-world markers. Rows rebuild
 * on every open (the fleet changes as hulls sink / are dispatched), so the
 * panel always reflects the latest snapshot. Gold focus ring + move()/confirm()
 * nav match the pause menu.
 */
export class FleetPrompt {
	private ui: AdvancedDynamicTexture;
	private root: Rectangle;
	private stack: StackPanel;
	private entries: { btn: Button; run: () => void; base: string }[] = [];
	private selected = -1;

	constructor(scene: Scene, private handlers: { onSwitch: (shipId: string) => void; onClose: () => void }) {
		this.ui = AdvancedDynamicTexture.CreateFullscreenUI("hs-fleet", true, scene);

		this.root = new Rectangle("fleetRoot");
		this.root.width = "100%";
		this.root.height = "100%";
		this.root.color = "transparent";
		this.root.background = "rgba(3,7,12,0.72)";
		this.root.thickness = 0;
		this.root.isVisible = false;
		this.ui.addControl(this.root);

		// Fixed pixel height: a Rectangle sized around a StackPanel measures to
		// NaN and cascades through the ADT root so the whole overlay draws nothing.
		const panel = new Rectangle("fleetPanel");
		panel.width = "380px";
		panel.height = "600px";
		panel.cornerRadius = 14;
		panel.background = "rgba(8,14,24,0.96)";
		panel.color = "rgba(150,190,225,0.55)";
		panel.thickness = 1;
		panel.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		panel.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
		this.root.addControl(panel);

		this.stack = new StackPanel("fleetStack");
		this.stack.isVertical = true;
		this.stack.width = "100%";
		this.stack.height = "100%";
		this.stack.spacing = 10;
		this.stack.paddingTop = "22px";
		this.stack.paddingBottom = "22px";
		this.stack.paddingLeft = "22px";
		this.stack.paddingRight = "22px";
		panel.addControl(this.stack);
	}

	/** Rebuild the panel for the current fleet and open it. Rows are recomputed
	 *  each open so a hull that just sank or was dispatched reads correctly. */
	show(hulls: FleetHull[]): void {
		for (const child of [...this.stack.children]) child.dispose();
		this.entries = [];
		this.selected = -1;

		this.stack.addControl(this.label("YOUR FLEET", 24, "#eaf3ff", true));
		this.stack.addControl(this.label("Own many, sail one. Take the helm of another hull to drop this one to auto trade.", 12, "#8aa3bd", false, true));
		this.stack.addControl(this.spacer(6));

		if (hulls.length === 0) {
			this.stack.addControl(this.label("Only the hull you're sailing — buy or dispatch more to build a fleet.", 13, "#9fb6cc", false, true));
		}
		for (const h of hulls) {
			if (h.isSelf) {
				this.stack.addControl(this.label(`⚓ ${h.name}  ·  At the helm`, 14, "#e6c079", false, true));
				continue;
			}
			this.stack.addControl(
				this.button(`${h.name}\n${h.detail}`, () => {
					this.handlers.onSwitch(h.shipId);
					this.setVisible(false);
				})
			);
		}
		this.stack.addControl(this.spacer(10));
		this.stack.addControl(this.button("Close", () => this.handlers.onClose()));
		this.root.isVisible = true;
		this.selected = 0;
		this.paint();
	}

	private label(text: string, size: number, color: string, bold: boolean, wrap = false): TextBlock {
		const t = new TextBlock("lbl", text);
		t.fontSize = `${size}px`;
		t.color = color;
		t.fontWeight = bold ? "bold" : "normal";
		t.width = "100%";
		t.height = wrap ? `${size * 2 + 10}px` : `${size + 8}px`;
		t.textWrapping = wrap;
		t.textHorizontalAlignment = Control.HORIZONTAL_ALIGNMENT_LEFT;
		t.shadowBlur = 3;
		t.shadowColor = "#000";
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
		btn.height = "52px";
		btn.cornerRadius = 8;
		btn.background = "rgba(30,60,90,0.95)";
		btn.color = "#eaf3ff";
		btn.fontSize = "14px";
		btn.fontWeight = "bold";
		btn.thickness = 1;
		btn.onPointerClickObservable.add(() => onClick());
		this.entries.push({ btn, run: onClick, base: btn.background });
		return btn;
	}

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

	/** Move the focus ring by `delta` (wraps); no-op when hidden. */
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
		if (!v) {
			this.selected = -1;
			this.paint();
		}
	}

	dispose(): void {
		this.ui.dispose();
	}
}
