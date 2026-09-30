"use client";

import { useEffect, useRef, type RefObject } from "react";

/**
 * Gamepad navigation for the DOM menu overlays (Title / Shop / Settings /
 * How-to). The engine's own InputManager consumes gamepad input for *sailing*
 * (throttle/fire/pause) but only once the player has joined the world, so while
 * a menu is up the pad is otherwise idle — this hook safely reuses it to drive
 * focus. It polls the Gamepad API on its own rAF, translates the D-pad and left
 * stick into focus movement between the overlay's focusable controls, A clicks
 * the focused control, B invokes onBack, and Left/Right adjust a focused slider.
 *
 * It never steals focus until a pad input actually happens, so keyboard/mouse
 * users are unaffected, and it does nothing at all when no pad is connected.
 */

// Standard Gamepad API button indices (Xbox layout).
const BTN = { A: 0, B: 1, LB: 4, RB: 5, UP: 12, DOWN: 13, LEFT: 14, RIGHT: 15 } as const;

const FOCUSABLE = 'button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])';

/** Set a range input's value the React-friendly way: native setter + a bubbling
 *  `input` event, so a controlled <input type="range"> updates its state. */
function setNativeRange(el: HTMLInputElement, value: number): void {
	const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")?.set;
	setter?.call(el, String(value));
	el.dispatchEvent(new Event("input", { bubbles: true }));
}

function getFirstPad(): Gamepad | null {
	if (typeof navigator === "undefined" || !navigator.getGamepads) return null;
	for (const p of navigator.getGamepads()) if (p && p.connected) return p;
	return null;
}

export function useGamepadNav(opts: {
	containerRef: RefObject<HTMLElement | null>;
	enabled: boolean;
	onBack?: () => void;
}): void {
	const { containerRef, enabled, onBack } = opts;
	// Keep the latest onBack in a ref so the effect can depend only on `enabled`
	// (otherwise a new onBack closure each render would restart the rAF poll).
	const onBackRef = useRef(onBack);
	onBackRef.current = onBack;

	useEffect(() => {
		if (!enabled) return;

		let raf = 0;
		let lastStickNav = 0;
		const prev = new Map<number, boolean>();

		const list = (): HTMLElement[] => {
			const c = containerRef.current;
			if (!c) return [];
			return Array.from(c.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(
				(el) => el.offsetParent !== null && !(el as HTMLButtonElement).disabled
			);
		};
		const indexNow = (): number => {
			const a = document.activeElement as HTMLElement | null;
			return a ? list().indexOf(a) : -1;
		};
		const focusIndex = (n: number): void => {
			const items = list();
			if (items.length === 0) return;
			const ni = ((n % items.length) + items.length) % items.length;
			items[ni]?.focus();
		};
		const move = (delta: number): void => {
			const i = indexNow();
			focusIndex((i < 0 ? 0 : i) + delta);
		};
		const activate = (): void => {
			const a = document.activeElement as HTMLElement | null;
			if (!a) {
				focusIndex(0);
				return;
			}
			// Enter/confirm on a slider is a no-op — arrows adjust it instead.
			if (a instanceof HTMLInputElement && a.type === "range") return;
			a.click();
		};
		const nudgeRange = (dir: number): void => {
			const a = document.activeElement as HTMLElement | null;
			if (a instanceof HTMLInputElement && a.type === "range") {
				const min = Number(a.min || "0");
				const max = Number(a.max || "100");
				const step = Number(a.step || "1");
				setNativeRange(a, Math.max(min, Math.min(max, Number(a.value) + dir * step)));
			}
		};
		const horizontal = (dir: number): void => {
			const a = document.activeElement as HTMLElement | null;
			if (a instanceof HTMLInputElement && a.type === "range") nudgeRange(dir);
			else move(dir);
		};

		const pressed = (pad: Gamepad, i: number): boolean => pad.buttons[i]?.pressed ?? false;
		const rising = (pad: Gamepad, i: number): boolean => {
			const now = pressed(pad, i);
			const was = prev.get(i) ?? false;
			prev.set(i, now);
			return now && !was;
		};

		// Keyboard mirror of the D-pad so arrow keys move the selection the same way
		// the pad does. Enter/Space are left to the browser (they natively click the
		// focused <button>), and Left/Right stay native so they adjust a focused
		// range slider. Only Up/Down are intercepted, for vertical traversal.
		const onKeyDown = (e: KeyboardEvent): void => {
			if (e.key === "ArrowDown") {
				e.preventDefault();
				move(1);
			} else if (e.key === "ArrowUp") {
				e.preventDefault();
				move(-1);
			}
		};
		window.addEventListener("keydown", onKeyDown);

		const frame = (): void => {
			const pad = getFirstPad();
			if (pad) {
				if (rising(pad, BTN.A)) activate();
				else if (rising(pad, BTN.B)) onBackRef.current?.();

				// D-pad: vertical moves traverse the list; horizontal traverses or
				// adjusts the focused slider.
				if (rising(pad, BTN.UP)) move(-1);
				else if (rising(pad, BTN.DOWN)) move(1);
				else if (rising(pad, BTN.LEFT)) horizontal(-1);
				else if (rising(pad, BTN.RIGHT)) horizontal(1);

				// Left stick mirrors the D-pad, with a repeat cooldown so holding a
				// direction doesn't blur past dozens of buttons in one frame.
				const now = performance.now();
				if (now - lastStickNav > 220) {
					const ax = pad.axes[0] ?? 0;
					const ay = pad.axes[1] ?? 0;
					if (Math.abs(ay) > 0.5) {
						move(ay > 0 ? 1 : -1);
						lastStickNav = now;
					} else if (Math.abs(ax) > 0.5) {
						horizontal(ax > 0 ? 1 : -1);
						lastStickNav = now;
					}
				}
			}
			raf = requestAnimationFrame(frame);
		};

		raf = requestAnimationFrame(frame);
		return () => {
			cancelAnimationFrame(raf);
			window.removeEventListener("keydown", onKeyDown);
		};
	}, [enabled, containerRef]);
}
