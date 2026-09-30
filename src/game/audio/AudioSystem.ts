/**
 * Game audio. Real field recordings (public/audio, CC0 from Freesound) are the
 * primary source; a small procedural Web Audio synth is the fallback for any bed
 * or one-shot whose file failed to load, so the mix never goes silent offline.
 *
 * Continuous beds (ocean/surf, wind, rain, gulls) are built once as looping
 * sources and level-matched every snapshot from the live WeatherState. One-shot
 * SFX (cannon, splash, hull crack, sink, thunder, creak, gull call) fire on the
 * combat bus, stereo-panned to their world position. Browsers gate audio behind
 * a gesture, so everything is created lazily in start().
 */
import { asset } from "../core/assets";

// Sea shanties are full-length songs (~49 MB across 13 tracks) — far too big to
// ship inside the Next bundle, and far too many PCM AudioBuffers to decode into
// a Web Audio graph in this OOM-sensitive build. They live in Cloudflare R2 and
// STREAM into a single <audio> element (MediaElementSource), so memory stays at
// "one file in flight" and playback needs no decode. The base is env-configurable
// so pointing at a custom domain — or a local /audio/shanties mirror for offline
// dev that skips R2 entirely — is a one-line env change, not a code edit.
const SHANTY_BASE = (
	process.env.NEXT_PUBLIC_SHANTY_BASE ?? "https://pub-4399d522d0d140df9830051a19f2e30f.r2.dev/audio/shanties"
).replace(/\/+$/, "");
const SHANTY_FILES = [
	"Ale_at_the_Quay.mp3",
	"Feather_Beds_and_Ale.mp3",
	"Haul_Away_the_Merry_Cheer.mp3",
	"Heave_Away_My_Brave_Lads.mp3",
	"Heave_and_Haul_Away.mp3",
	"Heave_the_Anchor_Home.mp3",
	"Pull_Away_My_Bully_Boys.mp3",
	"Safe_Home_at_Last.mp3",
	"Salt_For_The_Sweet.mp3",
	"Salt_On_The_Dock.mp3",
	"Steady_The_Line.mp3",
	"The_Emerald_Quay.mp3",
	"Tide_and_Timber.mp3",
];

const SAMPLE = {
	ocean: "/audio/ocean_loop.mp3",
	surf: "/audio/surf_loop.mp3",
	wind: "/audio/wind_loop.mp3",
	rain: "/audio/rain_loop.mp3",
	gulls: "/audio/gulls_loop.mp3",
	cannon: "/audio/cannon.mp3",
	splash: "/audio/splash.mp3",
	hull: "/audio/hull_impact.mp3",
	creak: "/audio/creak.mp3",
	thunder: "/audio/thunder.mp3",
	gull: "/audio/gull.mp3",
	// HighSeaz theme: the menu title track. Loops on EVERY screen that isn't the
	// live world (title / loading / shop / fleet / settings / how-to / pause) and
	// stops the moment the player sets sail — see setTheme + the phase setter.
	theme: "/audio/Sails_Against_The_Tide.mp3",
	// Combat music beds (looped, in-world only). "attack" plays while WE are
	// shooting; "flee" while we're being hit and running. Both fade the music bus
	// in place of the shanty playlist while a fight is live.
	attack: "/audio/Splintered_Timber.mp3",
	flee: "/audio/Where_the_Tide_Breaks.mp3",
	// NOTE: the sea shanty playlist is NOT in this map. It streams from R2 via a
	// dedicated <audio> element (SHANTY_BASE/SHANTY_FILES + playNextMusic) rather
	// than being decoded to an AudioBuffer here, precisely so 13 songs never land
	// in PCM memory at once.
};

export class AudioSystem {
	private ctx: AudioContext | null = null;
	private started = false;
	private ready = false;

	private master!: GainNode;
	private combatBus!: GainNode;
	/** Parent of the ambient beds (ocean/wind/rain/gulls) so one slider scales them. */
	private ambientBus!: GainNode;
	/** Parent of the shanty playlist, on master but separate from the SFX/ambient
	 *  sliders so music never rides the combat bus. */
	private musicBus!: GainNode;

	// Shanty playlist state. Music is edge-triggered by the render loop; a
	// generation token invalidates any in-flight track when it stops. The track
	// itself STREAMS through one persistent <audio> element routed into the music
	// bus (never decoded to PCM), so 13 full songs cost one file in flight.
	private wantMusic = false;
	private musicGen = 0;
	private musicIdx = 0;
	private musicEl: HTMLAudioElement | null = null;
	private musicGain: GainNode | null = null;
	/** Base shanty level (pre master); the fade-in rides the musicGain ramp. */
	private static readonly MUSIC_LEVEL = 0.28;

	// Menu theme (title track). Loops one track on every non-world screen; a
	// separate source from the shanty playlist so menu and gameplay music never
	// fight. Desired state is remembered so a mid-frame start() still kicks it in.
	private wantTheme = false;
	private themeSrc: AudioBufferSourceNode | null = null;

	// Combat music (in-world). A single looped source, switched by setCombat on the
	// live "attack"/"flee"/"none" reading from the render loop. Routed on the music
	// bus like the theme, and never simultaneous with the menu theme (theme is off
	// in-world) or the shanty playlist (the render loop gates music off while combat
	// music is wanted). Remembered before-ready so a mid-frame start() picks it up.
	private wantCombat: "none" | "attack" | "flee" = "none";
	private combatSrc: AudioBufferSourceNode | null = null;
	/** Which bed the live combatSrc is playing, so an unchanged mode isn't restarted
	 *  every frame and a switch (attack↔flee) crossfades instead of stuttering. */
	private combatKey: "attack" | "flee" | null = null;

	// Ambient world bed (ocean/surf/wind/rain/gulls) + the periodic gull/creak
	// one-shots. On ONLY in the live world. Edge-triggered by the phase setter so
	// the menus never leak the sea sound — the whole point of hiding the canvas is
	// that the selection screen is not the ocean, so it must not SOUND like it.
	private wantAmbient = false;

	// Latest ambient bed level nodes, ramped from setWeather.
	private windLevel!: GainNode;
	private surfLevel!: GainNode;
	private rainLevel!: GainNode;
	private gullLevel!: GainNode;

	/** Volume targets (0..1) from settings; applied on start() and on change. */
	private vol = { master: 0.9, sfx: 0.9, ambient: 0.8 };

	private buffers = new Map<string, AudioBuffer>();
	private sources: AudioScheduledSourceNode[] = [];
	private ambientTimer: ReturnType<typeof setTimeout> | null = null;

	// Latest weather, so a mid-frame start() still seeds the beds correctly.
	private windSpeed = 6;
	private waveAmp = 0.6;
	private rainIntensity = 0;

	start(): void {
		if (this.started) {
			void this.ctx?.resume();
			return;
		}
		const AC: typeof AudioContext | undefined =
			window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!AC) return;
		const ctx = new AC();
		this.ctx = ctx;
		this.started = true;

		this.master = ctx.createGain();
		this.master.gain.value = this.vol.master;
		this.master.connect(ctx.destination);

		this.combatBus = ctx.createGain();
		this.combatBus.gain.value = this.vol.sfx;
		this.combatBus.connect(this.master);

		this.ambientBus = ctx.createGain();
		// Starts muted: the ambient bed is a WORLD sound, so it only opens up when
		// setAmbient(true) is called on entering the live world. Menus stay silent.
		this.ambientBus.gain.value = this.wantAmbient ? this.vol.ambient : 0;
		this.ambientBus.connect(this.master);

		this.musicBus = ctx.createGain();
		this.musicBus.gain.value = 1;
		this.musicBus.connect(this.master);

		// Persistent shanty streamer: ONE <audio> element routed through a gain into
		// the music bus. createMediaElementSource is called exactly once per element
		// (calling it twice throws), so it lives here at setup, not per track.
		const el = new Audio();
		el.crossOrigin = "anonymous";
		el.preload = "none";
		el.volume = 1;
		const node = ctx.createMediaElementSource(el);
		this.musicGain = ctx.createGain();
		this.musicGain.gain.value = 0;
		node.connect(this.musicGain);
		this.musicGain.connect(this.musicBus);
		this.musicEl = el;

		// If music was requested before the context existed (edge fired while audio
		// was still gated), start it now that we're running off a real gesture.
		if (this.wantMusic) this.playNextMusic();

		void this.build();
	}

	/**
	 * Apply volumes from the settings menu. Stores the targets so a not-yet-started
	 * context picks them up in start(), and ramps the live buses (if audio has
	 * begun) so a slider drag is smooth rather than stepping.
	 */
	setVolumes(master: number, sfx: number, ambient: number): void {
		this.vol.master = Math.max(0, Math.min(1, master));
		this.vol.sfx = Math.max(0, Math.min(1, sfx));
		this.vol.ambient = Math.max(0, Math.min(1, ambient));
		const ctx = this.ctx;
		if (!ctx || !this.started) return;
		const t = ctx.currentTime;
		this.master.gain.setTargetAtTime(this.vol.master, t, 0.03);
		this.combatBus.gain.setTargetAtTime(this.vol.sfx, t, 0.03);
		// Keep the ambient bus at 0 while out of the world, even if the slider moves.
		this.ambientBus.gain.setTargetAtTime(this.wantAmbient ? this.vol.ambient : 0, t, 0.03);
	}

	/** Decode the samples, then wire beds from them (or procedural fallbacks). */
	private async build(): Promise<void> {
		const ctx = this.ctx;
		if (!ctx) return;
		// Decode each distinct URL once and share the AudioBuffer across every SAMPLE
		// key that points at it, so duplicated sources can't each hold their own PCM
		// buffer — a memory hazard in this OOM-sensitive build. In-flight promises are
		// memoised so the parallel map below can't race two decodes of the same URL.
		// (Shanties are NOT decoded here: they stream as full songs via the
		// MediaElementSource wired up in start(), which avoids holding ~60MB of PCM per
		// track in the buffer cache.)
		const decodedByUrl = new Map<string, Promise<AudioBuffer | null>>();
		const decodeOnce = (url: string): Promise<AudioBuffer | null> => {
			let p = decodedByUrl.get(url);
			if (!p) {
				p = (async () => {
					try {
						const res = await fetch(url);
						if (!res.ok) return null;
						return await ctx.decodeAudioData(await res.arrayBuffer());
					} catch {
						/* missing/undecodable -> procedural fallback covers this slot */
						return null;
					}
				})();
				decodedByUrl.set(url, p);
			}
			return p;
		};
		await Promise.all(
			Object.entries(SAMPLE).map(async ([key, url]) => {
				const buf = await decodeOnce(asset(url));
				if (buf) this.buffers.set(key, buf);
			})
		);

		// Surf/sea bed: the two sea loops summed, level-driven by wave amplitude.
		this.surfLevel = ctx.createGain();
		this.surfLevel.gain.value = 0;
		this.surfLevel.connect(this.ambientBus);
		this.bed(["ocean", "surf"], this.surfLevel, "brown", 500, "lowpass");

		// Wind bed.
		this.windLevel = ctx.createGain();
		this.windLevel.gain.value = 0;
		this.windLevel.connect(this.ambientBus);
		this.bed(["wind"], this.windLevel, "brown", 550, "bandpass");

		// Rain bed.
		this.rainLevel = ctx.createGain();
		this.rainLevel.gain.value = 0;
		this.rainLevel.connect(this.ambientBus);
		this.bed(["rain"], this.rainLevel, "white", 1400, "highpass");

		// Gull ambience bed (ducked in storms by applyWeather).
		this.gullLevel = ctx.createGain();
		this.gullLevel.gain.value = 0;
		this.gullLevel.connect(this.ambientBus);
		this.bed(["gulls"], this.gullLevel, "white", 2600, "bandpass");

		this.ready = true;
		this.applyWeather();
		if (this.wantAmbient) this.scheduleAmbient();
		this.startTheme(); // no-op unless setTheme(true) was requested pre-start (menus)
		this.startCombat(); // no-op unless a combat bed was requested pre-start
		void ctx.resume();
	}

	/**
	 * Connect a bed: any present sample loops into `dest`; if none is present a
	 * single procedural noise source (filtered) fills the slot instead.
	 */
	private bed(keys: string[], dest: AudioNode, fallback: "white" | "brown", filterHz: number, filterType: BiquadFilterType): void {
		const ctx = this.ctx as AudioContext;
		let usedSample = false;
		for (const k of keys) {
			const buf = this.buffers.get(k);
			if (!buf) continue;
			this.loop(buf).connect(dest);
			usedSample = true;
		}
		if (!usedSample) {
			const f = ctx.createBiquadFilter();
			f.type = filterType;
			f.frequency.value = filterHz;
			f.connect(dest);
			this.loop(this.noiseBuffer(fallback)).connect(f);
		}
	}

	setWeather(w: { windSpeed: number; waveAmplitude: number; rainIntensity: number }): void {
		this.windSpeed = w.windSpeed;
		this.waveAmp = w.waveAmplitude;
		this.rainIntensity = w.rainIntensity;
		this.applyWeather();
	}

	private applyWeather(): void {
		const ctx = this.ctx;
		if (!ctx || !this.ready) return;
		const t = ctx.currentTime;
		const windN = Math.max(0, Math.min(1, (this.windSpeed - 4) / 18));
		const waveN = Math.max(0, Math.min(1, (this.waveAmp - 0.4) / 1.8));
		const rainN = Math.max(0, Math.min(1, this.rainIntensity));
		// setTargetAtTime gives a smooth ~1s follow so gusts never click.
		this.windLevel.gain.setTargetAtTime(0.1 + windN * 0.5, t, 0.8);
		this.surfLevel.gain.setTargetAtTime(0.16 + waveN * 0.34, t, 0.9);
		this.rainLevel.gain.setTargetAtTime(rainN * 0.32, t, 0.6);
		// Gulls: present in fair weather, gone when it rains.
		this.gullLevel.gain.setTargetAtTime((1 - rainN) * 0.16, t, 1.2);
	}

	/** Fire a one-shot SFX. `pan` is -1..1 (screen-left..right) for stereo. */
	play(kind: "cannon" | "splash" | "hullImpact" | "sink" | "thunder" | "gull" | "creak", pan = 0): void {
		const ctx = this.ctx;
		if (!ctx || !this.ready) return;
		switch (kind) {
			case "cannon": this.one("cannon", pan, 1.0) ?? this.cannon(pan); break;
			case "splash": this.one("splash", pan, 0.9) ?? this.splash(pan); break;
			case "hullImpact": this.one("hull", pan, 0.9) ?? this.hullImpact(pan); break;
			case "gull": this.one("gull", Math.random() * 1.4 - 0.7, 0.5) ?? this.chirp(); break;
			case "creak": this.one("creak", Math.random() * 1.2 - 0.6, 0.35); break;
			case "thunder": this.one("thunder", 0, 0.85) ?? this.rumble(1.6, 0.6); break;
			case "sink":
				this.one("splash", pan, 0.9);
				this.rumble(1.8, 0.7);
				break;
		}
	}

	/**
	 * Edge-triggered music switch. The render loop calls this each frame with
	 * "sailing hard in fair weather"; a real change starts or fades out the
	 * shanty playlist. Turning it on advances to the next tune so repeated
	 * full-speed runs aren't the same song on loop.
	 */
	setMusic(on: boolean): void {
		if (on === this.wantMusic) return;
		this.wantMusic = on;
		if (on) this.playNextMusic();
		else this.stopMusic();
	}

	private stopMusic(): void {
		this.musicGen++;
		const el = this.musicEl;
		const ctx = this.ctx;
		if (el) {
			el.onended = null;
			el.pause();
		}
		if (ctx && this.musicGain) {
			const t = ctx.currentTime;
			this.musicGain.gain.cancelScheduledValues(t);
			this.musicGain.gain.setTargetAtTime(0, t, 0.25);
		}
	}

	/** Stream the next shanty once (not looped); chains to the following track on
	 *  end while music stays wanted. Advances the index so repeated full-speed
	 *  runs cycle through the playlist rather than repeating one tune. */
	private playNextMusic(): void {
		const ctx = this.ctx;
		const el = this.musicEl;
		if (!ctx || !el || !this.musicGain || !this.wantMusic) return;

		const file = SHANTY_FILES[this.musicIdx % SHANTY_FILES.length];
		this.musicIdx++;
		el.src = `${SHANTY_BASE}/${file}`;
		el.currentTime = 0;

		const gen = ++this.musicGen;
		const t = ctx.currentTime;
		this.musicGain.gain.cancelScheduledValues(t);
		this.musicGain.gain.setValueAtTime(0, t);
		this.musicGain.gain.setTargetAtTime(AudioSystem.MUSIC_LEVEL, t, 1.5);
		el.onended = () => {
			if (gen === this.musicGen && this.wantMusic) this.playNextMusic();
		};
		// play() can reject if the browser blocks it; swallow so an unhandled
		// rejection never breaks the render loop — the next re-activation retries.
		el.play().catch(() => {
			/* blocked / not-ready — stay quiet until the next trigger */
		});
	}

	/**
	 * Menu theme switch, edge-triggered by the phase setter (on for every screen
	 * that isn't the live world). Unlike the shanty playlist this is a single
	 * looping track, so it just starts or fades out that loop. The desired state is
	 * remembered even before the context exists and is applied when it becomes ready.
	 */
	setTheme(on: boolean): void {
		if (on === this.wantTheme) return;
		this.wantTheme = on;
		if (!this.ready) return;
		if (on) this.startTheme();
		else this.stopTheme();
	}

	private startTheme(): void {
		const ctx = this.ctx;
		if (!ctx || !this.ready || !this.wantTheme || this.themeSrc) return;
		const buf = this.buffers.get("theme");
		if (!buf) return; // theme file missing/not decoded yet — stay silent
		const src = ctx.createBufferSource();
		src.buffer = buf;
		src.loop = true;
		const g = ctx.createGain();
		g.gain.value = 0;
		g.gain.setTargetAtTime(0.5, ctx.currentTime, 1.2);
		src.connect(g).connect(this.musicBus);
		src.start();
		this.themeSrc = src;
	}

	private stopTheme(): void {
		const src = this.themeSrc;
		const ctx = this.ctx;
		this.themeSrc = null;
		if (!src || !ctx) return;
		try {
			src.stop(ctx.currentTime + 0.8);
		} catch {
			/* already stopped */
		}
	}

	/**
	 * Combat music switch, edge-triggered from the render loop each frame with the
	 * live "attack" / "flee" / "none" reading. A single looped bed plays at a time
	 * on the music bus, in place of the shanty playlist; leaving combat (none) fades
	 * it out. A change of bed (attack↔flee) crossfades — the old source is scheduled
	 * to stop just after the new one ramps up. Remembered before-ready so a mid-frame
	 * start() still kicks it in.
	 */
	setCombat(mode: "none" | "attack" | "flee"): void {
		if (mode === this.wantCombat) return;
		this.wantCombat = mode;
		if (!this.ready) return;
		if (mode === "none") this.stopCombat();
		else this.startCombat();
	}

	private startCombat(): void {
		const ctx = this.ctx;
		if (!ctx || !this.ready || this.wantCombat === "none") return;
		const key = this.wantCombat;
		// Already looping this exact bed — leave it running.
		if (this.combatSrc && this.combatKey === key) return;
		// Different bed (or none playing): stop the old (scheduled, so it crossfades)
		// then start the new one under a fresh source.
		this.stopCombat();
		const buf = this.buffers.get(key);
		if (!buf) return; // file missing/not decoded yet — stay silent
		const src = ctx.createBufferSource();
		src.buffer = buf;
		src.loop = true;
		const g = ctx.createGain();
		g.gain.value = 0;
		g.gain.setTargetAtTime(0.42, ctx.currentTime, 0.8);
		src.connect(g).connect(this.musicBus);
		src.start();
		this.combatSrc = src;
		this.combatKey = key;
	}

	private stopCombat(): void {
		const src = this.combatSrc;
		const ctx = this.ctx;
		this.combatSrc = null;
		this.combatKey = null;
		if (!src || !ctx) return;
		try {
			src.stop(ctx.currentTime + 0.6);
		} catch {
			/* already stopped */
		}
	}

	/**
	 * World-ambient switch, edge-triggered by the phase setter (on only in the live
	 * world). Off fades the whole ambient bus to silence and suspends the periodic
	 * gull/creak one-shots, so the selection/menu screens never sound like the open
	 * sea even though the world keeps ticking invisibly behind them.
	 */
	setAmbient(on: boolean): void {
		if (on === this.wantAmbient) return;
		this.wantAmbient = on;
		const ctx = this.ctx;
		if (!ctx || !this.ready) return;
		this.ambientBus.gain.setTargetAtTime(on ? this.vol.ambient : 0, ctx.currentTime, 0.5);
		if (on) this.scheduleAmbient();
		else if (this.ambientTimer) {
			clearTimeout(this.ambientTimer);
			this.ambientTimer = null;
		}
	}

	/** Play a loaded sample once through the combat bus; returns the node or null. */
	private one(key: string, pan: number, gain: number): AudioBufferSourceNode | null {
		const ctx = this.ctx;
		const buf = this.buffers.get(key);
		if (!ctx || !buf) return null;
		const src = ctx.createBufferSource();
		src.buffer = buf;
		// Slight per-shot pitch detune so repeated hits don't sound identical.
		src.playbackRate.value = 0.94 + Math.random() * 0.12;
		const g = ctx.createGain();
		g.gain.value = gain;
		src.connect(g).connect(this.out(pan));
		src.start();
		return src;
	}

	private out(pan: number): StereoPannerNode {
		const ctx = this.ctx as AudioContext;
		const p = ctx.createStereoPanner();
		p.pan.value = Math.max(-1, Math.min(1, pan));
		p.connect(this.combatBus);
		return p;
	}

	/** Procedural fallback rumble (sink/thunder) when the sample is missing. */
	private rumble(dur: number, level: number): void {
		const ctx = this.ctx as AudioContext;
		const t = ctx.currentTime;
		const dest = this.out(0);
		const src = ctx.createBufferSource();
		src.buffer = this.noiseBuffer("brown");
		const lp = ctx.createBiquadFilter();
		lp.type = "lowpass";
		lp.frequency.setValueAtTime(320, t);
		lp.frequency.exponentialRampToValueAtTime(80, t + dur);
		const g = ctx.createGain();
		g.gain.setValueAtTime(level, t);
		g.gain.exponentialRampToValueAtTime(0.001, t + dur);
		src.connect(lp).connect(g).connect(dest);
		src.start(t);
		src.stop(t + dur + 0.05);
	}

	// ---- Procedural fallbacks (used only when the matching file didn't load) ----

	private cannon(pan: number): void {
		const ctx = this.ctx as AudioContext;
		const t = ctx.currentTime;
		const dest = this.out(pan);
		const sub = ctx.createOscillator();
		sub.type = "sine";
		sub.frequency.setValueAtTime(110, t);
		sub.frequency.exponentialRampToValueAtTime(38, t + 0.18);
		const subG = ctx.createGain();
		subG.gain.setValueAtTime(0.9, t);
		subG.gain.exponentialRampToValueAtTime(0.001, t + 0.3);
		sub.connect(subG).connect(dest);
		sub.start(t);
		sub.stop(t + 0.32);
		const boom = ctx.createBufferSource();
		boom.buffer = this.noiseBuffer("brown");
		const lp = ctx.createBiquadFilter();
		lp.type = "lowpass";
		lp.frequency.value = 260;
		const bg = ctx.createGain();
		bg.gain.setValueAtTime(0.5, t);
		bg.gain.exponentialRampToValueAtTime(0.001, t + 0.5);
		boom.connect(lp).connect(bg).connect(dest);
		boom.start(t);
		boom.stop(t + 0.52);
	}

	private splash(pan: number): void {
		const ctx = this.ctx as AudioContext;
		const t = ctx.currentTime;
		const dest = this.out(pan);
		const src = ctx.createBufferSource();
		src.buffer = this.noiseBuffer("white");
		const lp = ctx.createBiquadFilter();
		lp.type = "lowpass";
		lp.frequency.setValueAtTime(400, t);
		lp.frequency.linearRampToValueAtTime(2600, t + 0.08);
		lp.frequency.exponentialRampToValueAtTime(500, t + 0.6);
		const g = ctx.createGain();
		g.gain.setValueAtTime(0.001, t);
		g.gain.linearRampToValueAtTime(0.5, t + 0.06);
		g.gain.exponentialRampToValueAtTime(0.001, t + 0.7);
		src.connect(lp).connect(g).connect(dest);
		src.start(t);
		src.stop(t + 0.72);
	}

	private hullImpact(pan: number): void {
		const ctx = this.ctx as AudioContext;
		const t = ctx.currentTime;
		const dest = this.out(pan);
		const src = ctx.createBufferSource();
		src.buffer = this.noiseBuffer("white");
		const bp = ctx.createBiquadFilter();
		bp.type = "bandpass";
		bp.frequency.value = 420;
		bp.Q.value = 6;
		const g = ctx.createGain();
		g.gain.setValueAtTime(0.8, t);
		g.gain.exponentialRampToValueAtTime(0.001, t + 0.25);
		src.connect(bp).connect(g).connect(dest);
		src.start(t);
		src.stop(t + 0.27);
	}

	private chirp(): void {
		const ctx = this.ctx as AudioContext;
		const dest = ctx.createGain();
		dest.gain.value = 0.05;
		const pan = ctx.createStereoPanner();
		pan.pan.value = Math.random() * 1.6 - 0.8;
		dest.connect(pan).connect(this.master);
		const notes = 2 + Math.floor(Math.random() * 3);
		let t = ctx.currentTime;
		const base = 2600 + Math.random() * 1400;
		for (let i = 0; i < notes; i++) {
			const o = ctx.createOscillator();
			o.type = "sine";
			const f0 = base * (0.9 + Math.random() * 0.3);
			o.frequency.setValueAtTime(f0, t);
			o.frequency.linearRampToValueAtTime(f0 * 1.35, t + 0.03);
			o.frequency.linearRampToValueAtTime(f0 * 0.9, t + 0.09);
			const g = ctx.createGain();
			g.gain.setValueAtTime(0.0001, t);
			g.gain.linearRampToValueAtTime(1, t + 0.02);
			g.gain.exponentialRampToValueAtTime(0.0001, t + 0.11);
			o.connect(g).connect(dest);
			o.start(t);
			o.stop(t + 0.13);
			t += 0.12 + Math.random() * 0.14;
		}
	}

	/** Occasional gull calls in fair weather and hull creaks in stiff wind. */
	private scheduleAmbient(): void {
		if (!this.ctx) return;
		// Out of the world, stop rescheduling entirely (setAmbient restarts it on entry).
		if (!this.wantAmbient) {
			this.ambientTimer = null;
			return;
		}
		const delay = 3000 + Math.random() * 6000;
		this.ambientTimer = setTimeout(() => {
			if (this.ready && this.wantAmbient) {
				const calm = this.rainIntensity < 0.25;
				if (calm && Math.random() < 0.55) this.play("gull");
				if (this.windSpeed > 14 && Math.random() < 0.4) this.play("creak");
			}
			this.scheduleAmbient();
		}, delay);
	}

	private loop(buffer: AudioBuffer): AudioBufferSourceNode {
		const ctx = this.ctx as AudioContext;
		const src = ctx.createBufferSource();
		src.buffer = buffer;
		src.loop = true;
		src.start();
		this.sources.push(src);
		return src;
	}

	private noiseBuffer(kind: "white" | "brown"): AudioBuffer {
		const ctx = this.ctx as AudioContext;
		const len = ctx.sampleRate * 3;
		const buf = ctx.createBuffer(1, len, ctx.sampleRate);
		const d = buf.getChannelData(0);
		if (kind === "white") {
			for (let i = 0; i < len; i++) d[i] = Math.random() * 2 - 1;
		} else {
			let last = 0;
			for (let i = 0; i < len; i++) {
				const w = Math.random() * 2 - 1;
				last = (last + 0.02 * w) / 1.02;
				d[i] = last * 3.5;
			}
		}
		return buf;
	}

	dispose(): void {
		if (this.ambientTimer) clearTimeout(this.ambientTimer);
		for (const s of this.sources) {
			try { s.stop(); } catch { /* already stopped */ }
		}
		this.sources.length = 0;
		this.themeSrc = null;
		this.combatSrc = null;
		this.combatKey = null;
		this.wantCombat = "none";
		// Tear the shanty streamer down so a StrictMode remount starts a fresh
		// element (the old one is bound to the about-to-close AudioContext).
		this.musicGen++;
		if (this.musicEl) {
			this.musicEl.onended = null;
			this.musicEl.pause();
			this.musicEl.removeAttribute("src");
			this.musicEl.load();
		}
		this.musicEl = null;
		this.musicGain = null;
		void this.ctx?.close();
		this.ctx = null;
		this.started = false;
		this.ready = false;
	}
}
