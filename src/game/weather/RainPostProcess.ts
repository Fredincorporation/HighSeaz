import { AbstractEngine, Camera, Effect, PostProcess, Vector2 } from "@babylonjs/core";

/**
 * Screen-space streak rain, replacing the old splash-blob ParticleSystem.
 *
 * The old rain was thousands of soft `water_impact.png` sprites — at speed they
 * read as floating gobs, not weather. This is a full-screen post pass that draws
 * parallaxed, wind-slanted streaks procedurally and darkens/desaturates the
 * frame like a squall, with a soft vignette for "water on the lens". It shares
 * the same `intensity` scalar the ParticleSystem did, so WeatherSystem just
 * drives it instead of an emit rate.
 *
 * Attached to the camera AFTER the DefaultRenderingPipeline so it composites
 * over the graded image (crisp streaks, not bloomed). It is created on demand
 * and disposed when the rain stops, so calm weather pays zero GPU cost.
 */
Effect.ShadersStore["rainFragmentShader"] = /* glsl */ `
	precision highp float;

	varying vec2 vUV;
	uniform sampler2D textureSampler;
	uniform float iTime;
	uniform float intensity;
	uniform vec2 res;
	uniform float slant;

	float rnd(vec2 p) {
		return fract(sin(dot(p, vec2(12.9898, 78.233))) * 43758.5453);
	}
	float vnoise(vec2 p) {
		vec2 i = floor(p);
		vec2 f = fract(p);
		vec2 u = f * f * (3.0 - 2.0 * f);
		float a = rnd(i);
		float b = rnd(i + vec2(1.0, 0.0));
		float c = rnd(i + vec2(0.0, 1.0));
		float d = rnd(i + vec2(1.0, 1.0));
		return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
	}
	float fbm(vec2 p) {
		float v = 0.0;
		float a = 0.5;
		for (int i = 0; i < 3; i++) {
			v += a * vnoise(p);
			p *= 2.0;
			a *= 0.5;
		}
		return v;
	}

	// One layer of falling streaks. Each cell holds a thin, elongated line whose
	// x-jitter and phase are hashed from the cell; the vertical term is squared so
	// the smear stretches into a long raindrop trail, then sheared by 'slant' for
	// wind. 'thick' is the core width/brightness and 'len' the trail length — low
	// len + high thick = a long, bright near drop; high len + low thick = a short,
	// faint far spatter. pow() sharpens the core so it stays a fine line.
	float layer(vec2 uv, float tiling, float speed, float len, float thick) {
		uv.x += (iTime - uv.y * 0.5) * slant * 9.0;
		vec2 p = uv * tiling;
		float i = floor(p.x);
		float j = floor(p.y);
		vec2 g = fract(p);
		float rx = rnd(vec2(i, j * 0.231));
		float ry = rnd(vec2(i * 1.7, j * 0.981));
		float xd = g.x - rx;
		float yd = g.y - ry - mod(iTime * speed, 1.0);
		yd = yd - floor(yd);
		return pow(max(thick / (abs(xd) + yd * yd * len + 0.0001), 0.0), 1.4);
	}

	void main() {
		vec3 base = texture2D(textureSampler, vUV).rgb;
		float aspect = res.x / max(res.y, 1.0);
		vec2 auv = vec2(vUV.x * aspect, vUV.y);

		// Sheeting: rain is never uniform. Large soft cells drift across the frame
		// on the wind, gusting density so squalls ROLL past in bands instead of
		// every pixel raining equally — the single biggest fix over a flat wash.
		vec2 drift = auv * vec2(2.2, 1.6) + vec2(iTime * 0.05 * (0.5 + slant * 6.0), -iTime * 0.06);
		float sheet = smoothstep(0.28, 0.82, fbm(drift));
		float dens = intensity * (0.55 + 1.05 * sheet);

		// Three parallax depth layers. The NEAR layer is deliberately sparse, large
		// and fast (low tiling, long trail, bright core) — a few fat drops whipping
		// past the lens is what sells real rain; the far layers fill in the fine
		// spatter. Without the near layer rain reads as flat static, not weather.
		float far  = layer(auv, 34.0, 2.4, 0.34, 0.010);
		float mid  = layer(auv, 19.0, 3.6, 0.24, 0.013);
		float near = layer(auv, 8.5, 6.0, 0.13, 0.022);
		float r = far + 1.15 * mid + 1.7 * near;
		r = min(r * dens, 1.7);

		// Rain is water IN FRONT of the scene: each streak slightly occludes (a cool
		// grey smear over the base), then a bright leading core catches the sky. The
		// net read is translucent falling water, not glowing additive lines.
		vec3 col = mix(base, vec3(0.60, 0.68, 0.80), clamp(r, 0.0, 1.0) * 0.55);
		col += vec3(0.72, 0.80, 0.92) * pow(clamp(r, 0.0, 1.7), 1.5) * 0.16;

		// Squall mood: drain colour toward grey and dim the frame, scaled by the
		// sheeting so the whole view darkens as a gust rolls over.
		float gloom = clamp(dens, 0.0, 1.0);
		col = mix(col, vec3(dot(col, vec3(0.299, 0.587, 0.114))), gloom * 0.28);
		col *= (1.0 - gloom * 0.24);

		// Soft vignette reads as water beading on the lens.
		float vig = smoothstep(1.25, 0.30, length(vUV - vec2(0.5)));
		col *= mix(1.0, vig, intensity * 0.4);

		gl_FragColor = vec4(col, 1.0);
	}
`;

export class RainPostProcess {
	private pp: PostProcess | null = null;
	private iTime = 0;
	private intensity = 0;
	private slant = 0;
	private res = new Vector2(1, 1);

	constructor(private engine: AbstractEngine, private camera: Camera) {}

	private ensure(): void {
		if (this.pp) return;
		this.pp = new PostProcess(
			"rain",
			"rain",
			["iTime", "intensity", "res", "slant"],
			null,
			1.0,
			this.camera
		);
		this.pp.onApply = (effect: Effect) => {
			effect.setFloat("iTime", this.iTime);
			effect.setFloat("intensity", this.intensity);
			effect.setVector2("res", this.res);
			effect.setFloat("slant", this.slant);
		};
	}

	/** Attach (compile) the pass, or detach and release it when the rain stops. */
	setEnabled(on: boolean): void {
		if (on) this.ensure();
		else if (this.pp) {
			this.pp.dispose(this.camera);
			this.pp = null;
		}
	}

	update(dt: number, intensity: number, slant: number): void {
		this.iTime += dt;
		this.intensity = intensity;
		this.slant = slant;
		this.res.set(this.engine.getRenderWidth(), this.engine.getRenderHeight());
	}

	dispose(): void {
		this.setEnabled(false);
	}
}
