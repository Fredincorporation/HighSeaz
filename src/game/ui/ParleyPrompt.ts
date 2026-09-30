import { Scene } from "@babylonjs/core";
import { AdvancedDynamicTexture, Button, Control, Rectangle, StackPanel, TextBlock } from "@babylonjs/gui";

/**
 * The parley / surrender prompt — a compact centred panel shown at one of two
 * ends of a demand:
 *
 *   incoming — YOUR hull is being demanded terms by a rival. Accept pays the
 *              cargo toll into their hold and opens a brief truce (they can't
 *              sink you for a few seconds); Decline fights on.
 *   asked    — YOU demanded terms; the target has been asked and the panel shows
 *              a "awaiting their answer" state until it resolves or lapses.
 *
 * Both states carry a countdown and SELF-DISMISS when it runs out, so a lapsed
 * demand never leaves a stuck dialog on either screen (the server independently
 * expires the offer; a late accept/decline is simply refused). It owns a
 * separate fullscreen GUI texture so it never disturbs the in-world markers.
 *
 * Keyboard/gamepad nav (gold focus ring, same language as the pause menu) is
 * driven externally via move()/confirm() from createGame while visible.
 */
export class ParleyPrompt {
	private ui: AdvancedDynamicTexture;
	private root: Rectangle;
	private title: TextBlock;
	private body: TextBlock;
	private countdown: TextBlock;
	private acceptBtn: Button;
	private declineBtn: Button;
	/** Rows the D-pad/arrow focus can land on — empty in the "asked" state. */
	private entries: { btn: Button; run: () => void; base: string }[] = [];
	private selected = -1;
	/** "hidden" | "incoming" (defender) | "asked" (attacker). */
	private mode: "hidden" | "incoming" | "asked" = "hidden";
	/** Wall-clock ms when the current offer/ask lapses on the client. */
	private deadline = 0;

	constructor(
		scene: Scene,
		private handlers: { onAccept: () => void; onDecline: () => void }
	) {
		this.ui = AdvancedDynamicTexture.CreateFullscreenUI("hs-parley", true, scene);

		this.root = new Rectangle("parleyRoot");
		this.root.width = "400px";
		this.root.height = "240px";
		this.root.cornerRadius = 14;
		this.root.background = "rgba(8,14,24,0.96)";
		this.root.color = "rgba(230,192,121,0.7)";
		this.root.thickness = 2;
		this.root.horizontalAlignment = Control.HORIZONTAL_ALIGNMENT_CENTER;
		this.root.verticalAlignment = Control.VERTICAL_ALIGNMENT_CENTER;
		this.root.isVisible = false;
		this.ui.addControl(this.root);

		const stack = new StackPanel("parleyStack");
		stack.isVertical = true;
		stack.width = "100%";
		stack.height = "100%";
		stack.spacing = 8;
		stack.paddingTop = "18px";
		stack.paddingBottom = "18px";
		stack.paddingLeft = "20px";
		stack.paddingRight = "20px";
		this.root.addControl(stack);

		this.title = this.label("PARLEY", 22, "#e6c079", "center", true);
		this.body = this.label("", 14, "#d7e3f2", "center", false);
		this.body.height = "56px";
		this.body.textWrapping = true;
		this.countdown = this.label("", 13, "#8aa3bd", "center", false);

		stack.addControl(this.title);
		stack.addControl(this.body);
		stack.addControl(this.countdown);
		stack.addControl(this.gap(4));

		this.acceptBtn = this.button("Strike colors — pay the toll", () => this.handlers.onAccept(), "#1c4a2c", "#eaf3ff");
		this.declineBtn = this.button("Fight on", () => this.handlers.onDecline(), "#5a2430", "#eaf3ff");
		stack.addControl(this.acceptBtn);
		stack.addControl(this.declineBtn);
	}

	private label(text: string, size: number, color: string, align: "left" | "center", bold: boolean): TextBlock {
		const t = new TextBlock("lbl", text);
		t.fontSize = `${size}px`;
		t.color = color;
		t.fontWeight = bold ? "bold" : "normal";
		t.width = "100%";
		// Explicit height: a vertical StackPanel cannot lay out a percentage/
		// undefined-height child — it overlaps its siblings.
		t.height = `${size + 8}px`;
		t.textHorizontalAlignment = align === "center" ? Control.HORIZONTAL_ALIGNMENT_CENTER : Control.HORIZONTAL_ALIGNMENT_LEFT;
		t.shadowBlur = 3;
		t.shadowColor = "#000";
		return t;
	}

	private gap(px: number): Rectangle {
		const r = new Rectangle("gap");
		r.width = "100%";
		r.height = `${px}px`;
		r.color = "transparent";
		r.background = "transparent";
		return r;
	}

	private button(text: string, onClick: () => void, bg: string, fg: string): Button {
		const btn = Button.CreateSimpleButton("btn", text);
		btn.width = "100%";
		btn.height = "38px";
		btn.cornerRadius = 8;
		btn.background = bg;
		btn.color = fg;
		btn.fontSize = "15px";
		btn.fontWeight = "bold";
		btn.thickness = 1;
		btn.onPointerClickObservable.add(() => onClick());
		this.entries.push({ btn, run: onClick, base: bg });
		return btn;
	}

	/** Paint the gold focus row on `selected`, restoring the rest. */
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

	/** Show the defender's incoming-demand prompt. */
	showIncoming(attackerName: string, demand: number, ttlSeconds: number): void {
		this.mode = "incoming";
		this.title.text = "PARLEY DEMANDED";
		this.body.text = `${attackerName} demands ${Math.round(demand)} cargo to spare your hull.`;
		this.acceptBtn.isVisible = true;
		this.declineBtn.isVisible = true;
		this.root.isVisible = true;
		this.deadline = Date.now() + ttlSeconds * 1000;
		// Focus the safe default (Decline) so an accidental confirm never pays.
		this.selected = 1;
		this.paint();
	}

	/** Show the attacker's "terms demanded, awaiting answer" state (no actions). */
	showAsked(defenderName: string, demand: number, ttlSeconds: number): void {
		this.mode = "asked";
		this.title.text = "TERMS DEMANDED";
		this.body.text = `You demand ${Math.round(demand)} cargo from ${defenderName}. Awaiting their answer…`;
		this.acceptBtn.isVisible = false;
		this.declineBtn.isVisible = false;
		this.root.isVisible = true;
		this.deadline = Date.now() + ttlSeconds * 1000;
		this.selected = -1;
		this.paint();
	}

	hide(): void {
		this.mode = "hidden";
		this.root.isVisible = false;
		this.selected = -1;
		this.paint();
	}

	isVisible(): boolean {
		return this.mode !== "hidden";
	}

	/** Are there actionable rows (incoming state) for the nav to move through? */
	hasActions(): boolean {
		return this.mode === "incoming";
	}

	/** Move the focus ring by `delta` (wraps) — only meaningful while incoming. */
	move(delta: number): void {
		if (this.mode !== "incoming" || this.entries.length === 0) return;
		if (this.selected < 0) this.selected = 0;
		else this.selected = (this.selected + delta + this.entries.length) % this.entries.length;
		this.paint();
	}

	/** Activate the focused row (Enter / A). */
	confirm(): void {
		if (this.mode !== "incoming") return;
		const e = this.entries[this.selected];
		if (e) e.run();
	}

	/** Refresh the countdown each frame; self-dismiss the moment it lapses. */
	tick(): void {
		if (this.mode === "hidden") return;
		const remain = Math.ceil((this.deadline - Date.now()) / 1000);
		if (remain <= 0) {
			this.hide();
			return;
		}
		this.countdown.text = this.mode === "incoming" ? `Answer in ${remain}s or fight on` : `Lapses in ${remain}s`;
	}

	dispose(): void {
		this.ui.dispose();
	}
}
