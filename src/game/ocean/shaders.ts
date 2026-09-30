/**
 * Shared GLSL for the procedural ocean + sky.
 *
 * A single analytic `skyColor()` function drives BOTH the visible sky dome and
 * the ocean's reflection, so the sea reflects exactly what's overhead without a
 * cubemap render or an HDR asset. Kept as plain strings and fed to Babylon
 * `ShaderMaterial` inline (no .fx / webpack loader needed).
 */

/** Noise + sky functions, prepended to any fragment shader that needs them. */
export const GLSL_COMMON = /* glsl */ `
	precision highp float;

	// Full-sky brightness from a lightning strike (0 in calm weather). Declared
	// here so BOTH the sky dome and the ocean's sky reflection flash together.
	uniform float lightning;

	// Time-of-day tint. Both default to white so midday looks EXACTLY as before;
	// a warm skyTint + amber sunTint shift the whole sky (and its sea reflection)
	// toward golden hour without any other change.
	uniform vec3 skyTint;
	uniform vec3 sunTint;

	float hash(vec2 p) {
		return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453123);
	}

	float vnoise(vec2 p) {
		vec2 i = floor(p);
		vec2 f = fract(p);
		vec2 u = f * f * (3.0 - 2.0 * f);
		float a = hash(i);
		float b = hash(i + vec2(1.0, 0.0));
		float c = hash(i + vec2(0.0, 1.0));
		float d = hash(i + vec2(1.0, 1.0));
		return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
	}

	float fbm(vec2 p) {
		float v = 0.0;
		float a = 0.5;
		for (int i = 0; i < 5; i++) {
			v += a * vnoise(p);
			p *= 2.02;
			a *= 0.5;
		}
		return v;
	}

	// Physically-motivated sky (Preetham-style approximation): a zenith/horizon
	// gradient driven by sun elevation, Mie forward scatter around the sun, a
	// cloud-gated sun disc, crepuscular rays, and a height-plane cloud deck with
	// one-tap sun-side self-shadow that thins out at the horizon. Shared by the
	// dome + the sea so the water reflects exactly what is overhead.
	vec3 skyColor(vec3 dir, vec3 sunDir, float cloudCover, float iTime) {
		vec3 D = normalize(dir);
		vec3 L = normalize(sunDir);
		float h = clamp(D.y, -1.0, 1.0);
		float sd = max(dot(D, L), 0.0);

		// Day factor from sun elevation: low/negative sun => dusk palette, high
		// sun => clean blue. Drives both the gradient endpoints and the warm tint.
		float sunElev = clamp(L.y, 0.0, 1.0);
		float dayF = smoothstep(0.0, 0.35, sunElev);
		float warm = 1.0 - dayF;

		// How much of the sun actually reaches the viewer through the cloud deck.
		float sunVis = clamp(1.0 - cloudCover * 1.15, 0.0, 1.0);

		// Base scattering gradient: deep zenith fading to a pale (day) or warm
		// (dusk) horizon, biased warm on the sun's side of the horizon band.
		vec3 zenith  = mix(vec3(0.05, 0.10, 0.32), vec3(0.10, 0.29, 0.66), dayF);
		vec3 horizon = mix(vec3(0.52, 0.44, 0.44), vec3(0.74, 0.83, 0.93), dayF);
		vec3 sunHorizon = horizon + vec3(0.42, 0.16, -0.06) * warm * pow(sd, 0.7);
		vec3 sky = mix(sunHorizon, zenith, pow(max(h, 0.0), 0.45));

		// Mie forward scatter: the broad glow hugging the sun, warm at dusk, and
		// the tight inner halo + a resolved disc — all attenuated by cloud cover.
		vec3 mieCol = mix(vec3(1.0, 0.55, 0.28), vec3(1.0, 0.96, 0.88), dayF) * sunTint;
		sky += mieCol * pow(sd, 5.0) * 0.30 * (0.35 + 0.65 * sunVis);
		sky += vec3(1.0, 0.86, 0.60) * sunTint * pow(sd, 60.0) * 1.4 * sunVis;
		sky += vec3(1.0, 0.97, 0.90) * sunTint * smoothstep(0.99955, 0.99975, sd) * 16.0 * sunVis;

		// Crepuscular "god" rays: only meaningful under broken cloud (a cover that
		// is neither clear nor solid) and only where the sun is partly visible.
		if (cloudCover > 0.05 && sunVis > 0.02) {
			float theta = acos(clamp(dot(D, L), -1.0, 1.0));
			vec3 upRef = abs(L.y) < 0.99 ? vec3(0.0, 1.0, 0.0) : vec3(1.0, 0.0, 0.0);
			vec3 b1 = normalize(cross(L, upRef));
			vec3 b2 = cross(L, b1);
			float sang = atan(dot(D, b2), dot(D, b1));
			float spoke = fbm(vec2(sang * 3.0 + 17.0, theta * 1.5 - iTime * 0.02));
			float rays = smoothstep(0.5, 0.9, spoke) * exp(-theta * 2.6);
			float rayAmt = cloudCover * (1.0 - cloudCover) * 4.0 * smoothstep(0.0, 0.1, h);
			sky += vec3(1.0, 0.90, 0.72) * sunTint * rays * rayAmt * sunVis * 0.5;
		}

		// Cloud deck: project the view ray onto a flat sheet at height ~1 and
		// sample fbm there. The depth factor blows up near the horizon, so we clamp
		// it and fade coverage out with hFade — that kills the old horizon smear. A
		// second tap offset toward the sun gives cheap self-shadowing (lit vs shaded tops).
		float cover = 0.0;
		if (h > 0.0005) {
			float depth = 1.0 / max(h, 0.06);
			vec2 cp = D.xz * depth * 0.02;
			cp += vec2(iTime * 0.005, iTime * 0.0035);   // wind drift
			float base = fbm(cp);
			vec2 sunXZ = normalize(L.xz + vec2(1e-4, 0.0));
			float shad = fbm(cp - sunXZ * 0.35);
			float d = clamp(base * (1.0 + cloudCover * 1.6) - (1.0 - cloudCover) * 0.55, 0.0, 1.0);
			cover = smoothstep(0.35, 0.75, d);
			float lit = clamp((shad - base) * 2.0 + 0.5 + sd * 0.4, 0.0, 1.0);
			vec3 cloudCol = mix(vec3(0.26, 0.28, 0.34), vec3(0.98, 0.98, 1.0), lit);
			cloudCol += vec3(1.0, 0.72, 0.42) * pow(sd, 6.0) * 0.5;
			cloudCol = mix(cloudCol, cloudCol * vec3(1.05, 0.78, 0.55), warm * 0.5);
			float hFade = smoothstep(0.0, 0.16, h);
			sky = mix(sky, cloudCol, cover * hFade * 0.95);
		}

		// Time-of-day grade, then a global overcast dim so heavy cloud drains the
		// whole atmosphere (not just the cloud pixels) toward a flat grey.
		sky *= skyTint;
		sky *= mix(1.0, 0.6, cloudCover * 0.85);
		// Lightning: a flat overexposure of the whole sky, strongest through the
		// cloud layer. Reads as a bolt illuminating the sky + its reflection.
		sky += vec3(0.75, 0.82, 1.0) * lightning;
		return sky;
	}
`;

/** Gerstner ocean vertex shader — sums 4 waves, builds displaced pos + normal. */
export const OCEAN_VERTEX = /* glsl */ `
	precision highp float;

	attribute vec3 position;
	attribute vec2 uv;

	uniform mat4 world;
	uniform mat4 worldViewProjection;
	uniform float iTime;
	uniform vec2 windDir;   // normalized XZ wind
	uniform float waveAmp;  // 0..~2 from WeatherState.waveAmplitude

	varying vec3 vWorldPos;
	varying vec3 vNormal;
	varying float vCrest;
	varying float vSea;

	// Large-scale sea state: the ocean is not uniformly rough — some patches are
	// calm glass, some are choppy. A pure function of world position so the CPU
	// hull-riding mirror in ShipManager reproduces it exactly (the alternative
	// was the hull bobbing off the real surface in calm/choppy regions).
	float seaState(vec2 p) {
		float m = sin(p.x * 0.0016 + sin(p.y * 0.0013)) * cos(p.y * 0.0011);
		return clamp(0.55 + 0.45 * m, 0.35, 1.25);
	}

	// Set per-vertex in main() and read by addWave: amplitude and slope scaled by
	// the local sea state. Globals (no inout param) because WebGL1 forbids
	// calling a function that mutates its arguments from inside another function.
	float gAmp;
	float gSea;

	void addWave(
		vec3 dir, float steep, float wavelength,
		inout vec3 pos, inout vec3 tangent, inout vec3 binormal
	) {
		float k = 6.2831853 / wavelength;
		float c = sqrt(9.8 / k);
		vec2 d = normalize(dir.xz);
		float f = k * (dot(d, pos.xz) - c * iTime);
		float a = (steep / k) * gAmp;
		float sEff = steep * gSea;
		float wcos = cos(f);
		float wsin = sin(f);
		pos.x += d.x * a * wcos;
		pos.z += d.y * a * wcos;
		pos.y += a * wsin;
		tangent.x += -d.x * d.x * sEff * wsin;
		tangent.y += d.x * sEff * wcos;
		tangent.z += -d.x * d.y * sEff * wsin;
		binormal.x += -d.x * d.y * sEff * wsin;
		binormal.y += d.y * sEff * wcos;
		binormal.z += -d.y * d.y * sEff * wsin;
	}

	void main() {
		vec4 wpos = world * vec4(position, 1.0);
		vec3 pos = wpos.xyz;
		vec3 tangent = vec3(1.0, 0.0, 0.0);
		vec3 binormal = vec3(0.0, 0.0, 1.0);
		float crest = 0.0;

		gSea = seaState(wpos.xz);
		gAmp = waveAmp * gSea;

		// varied directions around the wind for a believable sea
		addWave(vec3(windDir.x, 0.0, windDir.y), 0.22, 120.0, pos, tangent, binormal);
		addWave(vec3(windDir.x, 0.0, windDir.y) + vec3(0.6, 0.0, -0.2), 0.18, 70.0, pos, tangent, binormal);
		addWave(vec3(windDir.x, 0.0, windDir.y) + vec3(-0.5, 0.0, 0.5), 0.14, 42.0, pos, tangent, binormal);
		addWave(vec3(-windDir.y, 0.0, windDir.x), 0.10, 26.0, pos, tangent, binormal);

		crest = pos.y / max(gAmp, 0.0001);
		vCrest = crest;
		vSea = gSea;
		vNormal = normalize(cross(binormal, tangent));
		vWorldPos = pos;
		gl_Position = worldViewProjection * vec4(pos, 1.0);
	}
`;

/** Ocean fragment: fresnel sky reflection + subsurface + sun glint + foam. */
export const OCEAN_FRAGMENT = /* glsl */ `
	${GLSL_COMMON}

	varying vec3 vWorldPos;
	varying vec3 vNormal;
	varying float vCrest;
	varying float vSea;

	uniform float iTime;
	uniform vec3 sunDir;
	uniform vec3 cameraPosition;
	uniform float cloudCover;
	uniform float waveAmp;
	uniform float rain;
	// Atmospheric fog, mirrored from the scene so the sea is veiled by the SAME
	// air as ships and islands (EXP mode: fogColor + fogDensity).
	uniform vec3 fogColor;
	uniform float fogDensity;

	void main() {
		// near-field detail: scroll two FBM ripple layers to perturb the normal.
		// Scaled by the local sea state so calm patches stay glassy and only the
		// choppy regions get micro-ripples.
		float detail = clamp((vSea - 0.35) / 0.9, 0.0, 1.0);
		vec2 duv = vWorldPos.xz * 0.05;
		float n1 = fbm(duv + vec2(iTime * 0.06, -iTime * 0.04));
		float n2 = fbm(duv * 2.1 - vec2(iTime * 0.05, iTime * 0.03));
		vec3 N = normalize(vNormal + vec3((n1 - 0.5) * 0.25, 0.0, (n2 - 0.5) * 0.25) * detail);

		// Rain pocks the surface: two scrolling high-frequency noise fields jitter
		// the normal so the water turns dull and dimpled under the storm — a coarse
		// chop plus a fine spray of drop impacts — instead of staying glassy under
		// the same sun.
		vec2 sd1 = vWorldPos.xz * 0.35 + vec2(iTime * 0.9, iTime * 0.6);
		vec2 sd2 = vWorldPos.xz * 1.30 - vec2(iTime * 1.6, iTime * 1.1);
		N.xz += (vec2(vnoise(sd1), vnoise(sd1 * 1.7 + 5.0)) - 0.5) * 0.20 * rain;
		N.xz += (vec2(vnoise(sd2), vnoise(sd2 + 9.0)) - 0.5) * 0.10 * rain;
		N = normalize(N);

		vec3 V = normalize(cameraPosition - vWorldPos);
		vec3 R = reflect(-V, N);

		// environment reflection = the same sky we draw on the dome
		vec3 reflection = skyColor(R, sunDir, cloudCover, iTime);

		// Patchy water body: large-scale noise picks the local character (deep
		// navy -> teal) and a finer field picks the shallowness (adds green over
		// weed beds and a sandy warm tint over shoals). No two stretches share a
		// colour, and calmer patches read as clearer, shallower water.
		float hue = fbm(vWorldPos.xz * 0.0016);            // very large hue field
		float shoal = smoothstep(0.42, 0.72, vnoise(vWorldPos.xz * 0.004 + 11.0));
		vec3 deep    = mix(vec3(0.010, 0.052, 0.090), vec3(0.020, 0.140, 0.150), hue);
		vec3 shallow = mix(vec3(0.035, 0.240, 0.260), vec3(0.075, 0.360, 0.300), hue);
		vec3 body = mix(deep, shallow, clamp(N.y, 0.0, 1.0));
		body = mix(body, vec3(0.11, 0.30, 0.22), shoal * 0.35);      // greener shallows
		body = mix(body, vec3(0.24, 0.34, 0.28), shoal * shoal * 0.18); // sunlit sand

		// Under rain the water loses its greens and its brightness — a heavy squall
		// flattens the sea to a dull, dark grey regardless of the hue field beneath.
		body = mix(body, vec3(dot(body, vec3(0.34, 0.5, 0.16))), rain * 0.35);
		body *= mix(1.0, 0.72, rain * 0.6);

		// sun glint (Blinn-Phong highlight for sparkle) — the sun's mirror flash is
		// choked by cloud and, on top of that, by rain on the surface.
		vec3 L = normalize(sunDir);
		vec3 H = normalize(L + V);
		float glint = (1.0 - cloudCover * 0.7) * (1.0 - rain * 0.6);
		float spec = pow(max(dot(N, H), 0.0), 220.0) * glint;
		body += vec3(1.0, 0.95, 0.85) * spec * 3.0;

		// Sun glitter: the sun's reflection shatters into thousands of scintillating
		// micro-facets running down the swells instead of sitting as one static glint
		// dot — the shimmering path that reads as bright day on a real, moving ocean.
		// A high-frequency noise field picks WHICH crests flash, and it scrolls with
		// iTime so the whole path twinkles. Choked by cloud and rain like the glint.
		float glitMask = fbm(vWorldPos.xz * 0.5 + vec2(iTime * 0.6, -iTime * 0.4));
		float glitPath = pow(max(dot(R, L), 0.0), 40.0);
		float glitter = glitPath * smoothstep(0.45, 0.85, glitMask) * glint;
		body += vec3(1.0, 0.96, 0.86) * glitter * 1.5;

		// Subsurface translucency: back-lit wave crests glow teal where sunlight
		// shines THROUGH the thin water at the top of a wave. This is the cue that
		// separates glassy flat water from a deep sea you can see light move through,
		// and it is strongest when looking back toward the sun.
		float crestThin = smoothstep(0.35, 1.0, vCrest) * detail;
		float backLit = pow(max(dot(-V, L), 0.0), 3.0);
		body += vec3(0.02, 0.30, 0.34) * crestThin * backLit * (1.0 - rain * 0.7) * 0.5;

		float fresnel = mix(0.02, 1.0, pow(1.0 - max(dot(N, V), 0.0), 5.0));
		vec3 color = mix(body, reflection, fresnel);

		// foam: whitecaps on crests, broken up by noise. Gated by the local sea
		// state (detail) so calm patches get no whitecaps at all.
		float foamMask = fbm(vWorldPos.xz * 0.25 + iTime * 0.1);
		float foam = smoothstep(0.55, 0.95, vCrest * 0.5 + 0.5) * smoothstep(0.4, 0.7, foamMask);
		foam *= detail;
		color = mix(color, vec3(0.92, 0.96, 0.98), foam);

		// Drifting cloud shadows: large soft patches sliding across the sea and
		// darkening the water beneath, so the surface is never uniformly lit.
		// Scaled by cloudCoverage — a clear sky (coverage near 0) casts none, so
		// the calm default is unchanged; a storm roils with moving shade.
		float cloudShadow = fbm(vWorldPos.xz * 0.0006 + vec2(iTime * 0.02, iTime * 0.012));
		float shade = clamp(cloudShadow - (1.0 - cloudCover), 0.0, 1.0);
		color *= mix(1.0, 0.5, shade * 0.7);

		// Atmospheric fog — Babylon's EXP scene fog, mirrored so the sea fades to
		// the SAME colour and at the SAME rate the rest of the world does. The fog
		// lives in the air in FRONT of the water, not painted into its surface:
		// calm = clear horizon (fogDensity ~0), a storm banks the identical veil
		// over sea, hulls and isles at once.
		float vDist = length(cameraPosition - vWorldPos);
		float vFog = 1.0 - exp(-fogDensity * vDist);
		color = mix(color, fogColor, clamp(vFog, 0.0, 1.0));

		gl_FragColor = vec4(color, 1.0);
	}
`;

/** Sky dome fragment — evaluates the shared sky along the view ray. */
export const SKY_VERTEX = /* glsl */ `
	precision highp float;
	attribute vec3 position;
	uniform mat4 world;
	uniform mat4 worldViewProjection;
	varying vec3 vDir;
	void main() {
		vDir = (world * vec4(position, 1.0)).xyz;
		gl_Position = worldViewProjection * vec4(position, 1.0);
	}
`;

export const SKY_FRAGMENT = /* glsl */ `
	${GLSL_COMMON}
	varying vec3 vDir;
	uniform vec3 sunDir;
	uniform float cloudCover;
	uniform float iTime;
	void main() {
		vec3 dir = normalize(vDir);
		gl_FragColor = vec4(skyColor(dir, sunDir, cloudCover, iTime), 1.0);
	}
`;
