/**
 * Client-side settings model + persistence. These are pure presentation/audio
 * preferences (nothing gameplay-authoritative), so they live entirely on the
 * client and persist to localStorage. The React overlay menus read/write this;
 * createGame applies it to the audio mix and render pipeline on boot and on
 * change.
 */
export interface GameSettings {
	/** Master gain, 0..1. */
	master: number;
	/** Combat/SFX bus gain, 0..1. */
	sfx: number;
	/** Ambient bed gain (ocean/wind/rain/gulls), 0..1. */
	ambient: number;
	/** "high" runs the filmic post-process; "low" drops it for older GPUs. */
	quality: "high" | "low";
}

export const DEFAULT_SETTINGS: GameSettings = {
	master: 0.9,
	sfx: 0.9,
	ambient: 0.8,
	quality: "high",
};

const KEY = "hs-settings";

export function loadSettings(): GameSettings {
	if (typeof window === "undefined") return { ...DEFAULT_SETTINGS };
	try {
		const raw = window.localStorage.getItem(KEY);
		if (!raw) return { ...DEFAULT_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<GameSettings>;
		return {
			master: clamp01(parsed.master, DEFAULT_SETTINGS.master),
			sfx: clamp01(parsed.sfx, DEFAULT_SETTINGS.sfx),
			ambient: clamp01(parsed.ambient, DEFAULT_SETTINGS.ambient),
			quality: parsed.quality === "low" ? "low" : "high",
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

export function saveSettings(s: GameSettings): void {
	if (typeof window === "undefined") return;
	try {
		window.localStorage.setItem(KEY, JSON.stringify(s));
	} catch {
		/* storage disabled/full — settings just won't persist */
	}
}

function clamp01(v: unknown, fallback: number): number {
	return typeof v === "number" && v >= 0 && v <= 1 ? v : fallback;
}
