import {
	Scene,
	Color3,
	Vector3,
	Camera,
	DirectionalLight,
	HemisphericLight,
	ParticleSystem,
	Texture,
	DynamicTexture,
	Color4,
} from "@babylonjs/core";
import type { WeatherState } from "@shared/index";
import type { OceanSystem } from "../ocean/OceanSystem";
import { RainPostProcess } from "./RainPostProcess";

// Unit vectors reused every frame to project the wind onto the camera.
const _RIGHT = new Vector3(1, 0, 0);
const _FWD = new Vector3(0, 0, 1);

/**
 * Weather-as-gameplay, now live on the client. WeatherState is ONE authoritative
 * scalar set shared by physics (server) and these VFX; here the scalars drive:
 *   rainIntensity   -> screen-space streak rain pass + a fog/wave bump (gloom)
 *   windSpeed       -> sea spray thrown up near the bow in fresh winds
 *   lightningFreq   -> scheduled strikes that flash the sky/sea + scene lights
 *   cloudCoverage   -> (handled in the sky shader, passed through by OceanSystem)
 * The whole system idles at emitRate 0 in calm weather, so clear-sky default is
 * visually identical to before this class existed.
 */
export class WeatherSystem {
	private tex: Texture;
	private rainPP: RainPostProcess | null = null;
	private spray: ParticleSystem;
	private sprayEmitter: Vector3;

	// Bound lazily from createGame once the other subsystems exist.
	private ocean: OceanSystem | null = null;
	private camera: Camera | null = null;
	private sunBase = 1.6;
	private hemiBase = 0.55;
	private sun: DirectionalLight | null = null;
	private hemi: HemisphericLight | null = null;

	private w: WeatherState | null = null;
	/** Latest server snapshot. `w` (what we render) eases toward this each frame,
	 *  so ~20Hz snapshots that step become a slow, realistic visual transition. */
	private target: WeatherState | null = null;
	private lightning = 0;
	private nextBolt = 0;
	/** Fired at the instant a bolt lights up (before its ~1/10s decay). */
	onStrike?: () => void;

	constructor(private scene: Scene) {
		scene.fogMode = Scene.FOGMODE_EXP;
		scene.fogColor = new Color3(0.6, 0.7, 0.8);

		// Sea spray: a fine, low mist blown off the waves in fresh wind. Uses a
		// soft radial sprite (generated below) — NOT the splash-crown `water_impact`
		// texture, which read as floating gobs in the sky.
		this.tex = WeatherSystem.softSprite(scene);
		this.sprayEmitter = new Vector3(0, 0, 0);
		this.spray = new ParticleSystem("spray", 1200, scene);
		this.spray.particleTexture = this.tex;
		this.spray.emitter = this.sprayEmitter;
		this.spray.minEmitBox = new Vector3(-16, 0, -2);
		this.spray.maxEmitBox = new Vector3(16, 2.5, 12);
		this.spray.color1 = new Color4(0.86, 0.93, 1.0, 0.16);
		this.spray.color2 = new Color4(0.8, 0.88, 1.0, 0.09);
		this.spray.colorDead = new Color4(1, 1, 1, 0.0);
		this.spray.minSize = 0.5;
		this.spray.maxSize = 1.7;
		this.spray.minLifeTime = 0.6;
		this.spray.maxLifeTime = 1.4;
		this.spray.emitRate = 0;
		// Standard (alpha) blend, not additive: spray is white water haze, and ADD
		// made it glow like explosions.
		this.spray.blendMode = ParticleSystem.BLENDMODE_STANDARD;
		this.spray.gravity = new Vector3(0, -3.5, 0);
		// Mostly a low horizontal drift with a little lift — it clings to the sea
		// surface instead of rocketing up into the sky.
		this.spray.direction1 = new Vector3(-1.5, 1.2, -1.5);
		this.spray.direction2 = new Vector3(1.5, 3.0, 1.5);
		this.spray.minEmitPower = 1.5;
		this.spray.maxEmitPower = 4;
		this.spray.updateSpeed = 0.014;
		this.spray.start();
	}

	/** A 64px soft white radial dot — the correct shape for fine sea mist. */
	private static softSprite(scene: Scene): DynamicTexture {
		const size = 64;
		const dt = new DynamicTexture("spraySoft", { width: size, height: size }, scene, false);
		const ctx = dt.getContext();
		const g = ctx.createRadialGradient(size / 2, size / 2, 0, size / 2, size / 2, size / 2);
		g.addColorStop(0, "rgba(255,255,255,0.95)");
		g.addColorStop(0.45, "rgba(255,255,255,0.4)");
		g.addColorStop(1, "rgba(255,255,255,0)");
		ctx.fillStyle = g;
		ctx.fillRect(0, 0, size, size);
		dt.update();
		dt.hasAlpha = true;
		return dt;
	}

	/** Give weather handles on the things it modulates. Called once from createGame. */
	bind(ocean: OceanSystem, camera: Camera, sun: DirectionalLight, hemi: HemisphericLight): void {
		this.ocean = ocean;
		this.camera = camera;
		this.sun = sun;
		this.hemi = hemi;
		this.sunBase = sun.intensity;
		this.hemiBase = hemi.intensity;
		// Created attached to the camera but idle (no pass) until the first rain.
		this.rainPP = new RainPostProcess(this.scene.getEngine(), camera);
	}

	/** Scalar ingest (kept from the original contract; server-authoritative). */
	update(weather: WeatherState): void {
		// Do NOT apply the snapshot directly — that is what made the weather snap.
		// Store it as a target; ease() walks the rendered state toward it over a
		// realistic minutes-long time constant. The first sample is adopted whole
		// so there is no visible slide at boot.
		if (!this.w) {
			this.w = { ...weather, wind: { ...weather.wind } };
			this.target = this.w;
			this.applyFog();
		} else {
			this.target = weather;
		}
	}

	/** The smoothed weather the rest of the world should read (falls back to the
	 *  raw target before the first tick). Used by createGame for ocean/ship/HUD. */
	get smoothed(): WeatherState | null {
		return this.w ?? this.target;
	}

	/** Fog from the current (smoothed) state, so haze eases with the swell. */
	private applyFog(): void {
		const w = this.w;
		if (!w) return;
		// Aerial haze. The server's fogDensity was authored for EXP2 (a wall); under
		// the gentler EXP mode we scale it down so distant islands survive to the
		// horizon rather than vanishing, but keep it high enough to READ as real
		// atmospheric perspective — the far sea and distant isles should fade into
		// a soft blue-grey veil, not sit in airless clarity. Rain gloom thickens it
		// back toward a squall.
		const gloom = Math.max(0, Math.min(1, w.rainIntensity));
		this.scene.fogDensity = w.fogDensity * 0.3 * (1 + gloom * 1.5);
		this.scene.fogColor = Color3.Lerp(
			new Color3(0.55, 0.66, 0.8),
			new Color3(0.28, 0.31, 0.36),
			gloom
		);
	}

	/**
	 * Ease the rendered weather toward the latest snapshot. Called first in the
	 * render loop so everything downstream (ships, ocean, rain, lightning, HUD)
	 * sees the same gradual transition. Time constant ~20s: calm->storm takes the
	 * better part of a minute and drains just as slowly — no weather whiplash.
	 */
	ease(dt: number): void {
		const w = this.w;
		const t = this.target;
		if (!w || !t) return;
		const k = 1 - Math.exp(-dt / 20);
		w.windSpeed += (t.windSpeed - w.windSpeed) * k;
		w.waveAmplitude += (t.waveAmplitude - w.waveAmplitude) * k;
		w.fogDensity += (t.fogDensity - w.fogDensity) * k;
		w.rainIntensity += (t.rainIntensity - w.rainIntensity) * k;
		w.cloudCoverage += (t.cloudCoverage - w.cloudCoverage) * k;
		w.lightningFrequency += (t.lightningFrequency - w.lightningFrequency) * k;
		w.wind.x += (t.wind.x - w.wind.x) * k;
		w.wind.z += (t.wind.z - w.wind.z) * k;
		this.applyFog();
	}

	/** Per-frame: advance particles, spray, and the lightning scheduler. */
	tick(dt: number): void {
		const w = this.w;
		if (!w) return;

		// Rain: drive the screen-space streak pass (and re-seed the spray at the
		// sea surface AHEAD of the ship). The pass attaches itself while it rains
		// and releases when it stops, so calm weather pays no GPU cost.
		if (this.camera) {
			const fwd = this.camera.getDirection(_FWD);
			this.sprayEmitter.copyFrom(this.camera.position);
			this.sprayEmitter.x += fwd.x * 20;
			this.sprayEmitter.z += fwd.z * 20;
			// Sit the box on the waterline, not at the (airborne) camera height, so
			// spray reads as blown off the waves rather than hanging in the sky.
			this.sprayEmitter.y = 0.5;
		}
		const rain = Math.max(0, Math.min(1, w.rainIntensity));
		if (this.rainPP) {
			// Wind slant: project the world wind onto the camera's right axis, so
			// the streaks lean with the weather and swing as the bow turns.
			let slant = 0;
			if (this.camera) {
				const right = this.camera.getDirection(_RIGHT);
				const wl = Math.hypot(w.wind.x, w.wind.z) || 1;
				slant = ((w.wind.x / wl) * right.x + (w.wind.z / wl) * right.z) * (0.06 + rain * 0.12);
			}
			this.rainPP.setEnabled(rain > 0.01);
			this.rainPP.update(dt, rain, slant);
		}

		// Sea spray ramps in once there is real wind; a fine haze, not a wall.
		const wind = Math.max(0, (w.windSpeed - 6) / 10);
		this.spray.emitRate = Math.min(1, wind) * 220;

		// Lightning: schedule the next strike when the storm calls for one, then
		// let the flash decay fast. Frequency is strikes-per-second-ish (0..1).
		if (w.lightningFrequency > 0) {
			this.nextBolt -= dt;
			if (this.nextBolt <= 0) {
				this.lightning = 1;
				this.onStrike?.();
				// Mean gap shrinks as frequency climbs, with jitter so it is not a
				// metronome. At freq=1 a bolt roughly every ~1.5s.
				const mean = 0.4 + (1.4 / Math.max(0.0001, w.lightningFrequency)) * 0.3;
				this.nextBolt = mean * (0.4 + Math.random() * 1.2);
			}
		} else {
			this.nextBolt = 0;
		}

		// Exponential decay: a strike is a hard flash then ~1/10s of afterglow.
		this.lightning *= Math.exp(-dt / 0.14);
		if (this.lightning < 0.001) this.lightning = 0;

		// Drive the shared sky/sea flash uniform and punch the scene lights.
		this.ocean?.setLightning(this.lightning);
		if (this.sun) this.sun.intensity = this.sunBase + this.lightning * 6;
		if (this.hemi) this.hemi.intensity = this.hemiBase + this.lightning * 2.5;
	}

	dispose(): void {
		this.rainPP?.dispose();
		this.spray.dispose();
		this.tex.dispose();
	}
}
