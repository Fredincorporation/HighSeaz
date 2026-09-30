import { MeshBuilder, ShaderMaterial, Vector2, Vector3, Mesh, Scene } from "@babylonjs/core";
import type { WeatherState } from "@shared/index";
import { OCEAN_VERTEX, OCEAN_FRAGMENT, SKY_VERTEX, SKY_FRAGMENT } from "./shaders";
import { renderWaveAmp } from "./waveAmp";

/** Sun azimuth/elevation shared by sky, ocean glint and the scene light. */
export const SUN_DIR = new Vector3(-0.45, 0.42, -0.6).normalize();

/** Neutral tint = the approved daytime look, unchanged. */
const WHITE = new Vector3(1, 1, 1);

/**
 * Procedural sea + sky built on custom GLSL (not WaterMaterial/SkyMaterial).
 *
 * The ocean is a camera-following, densely tessellated grid displaced by 4
 * Gerstner waves with analytic normals, fresnel sky reflection, sun glint and
 * noise-broken whitecap foam. Waves are anchored in WORLD space, so sliding the
 * grid under the camera never makes them swim. The dome and the reflection both
 * call the same `skyColor()`, giving consistent sky-on-water for free.
 */
export class OceanSystem {
	public readonly mesh: Mesh;
	public readonly skyMesh: Mesh;
	private ocean: ShaderMaterial;
	private sky: ShaderMaterial;

	constructor(private scene: Scene) {
		// --- Sky dome (shared analytic sky) --------------------------------
		this.sky = new ShaderMaterial(
			"skyMat",
			scene,
			{ vertexSource: SKY_VERTEX, fragmentSource: SKY_FRAGMENT },
			{
				attributes: ["position"],
				uniforms: ["world", "worldViewProjection", "sunDir", "cloudCover", "iTime", "lightning", "skyTint", "sunTint"],
				samplers: [],
			}
		);
		this.sky.backFaceCulling = false;
		this.sky.disableDepthWrite = true;
		this.sky.setVector3("sunDir", SUN_DIR);
		this.sky.setFloat("cloudCover", 0.3);
		this.sky.setFloat("iTime", 0);
		this.sky.setFloat("lightning", 0);
		this.sky.setVector3("skyTint", WHITE);
		this.sky.setVector3("sunTint", WHITE);
		this.skyMesh = MeshBuilder.CreateSphere("skyDome", { diameter: 18000, sideOrientation: Mesh.BACKSIDE }, scene);
		this.skyMesh.material = this.sky;
		this.skyMesh.isPickable = false;
		// The dome writes no depth and sits ~9000 units out, so the ordinary
		// LESS depth test keeps nearer geometry (sea, hulls) in front of it
		// wherever it exists and lets the dome fill only the empty sky above.
		// follow() re-centres it on the camera every frame.

		// --- Sea grid (follows the camera) ---------------------------------
		this.ocean = new ShaderMaterial(
			"oceanMat",
			scene,
			{ vertexSource: OCEAN_VERTEX, fragmentSource: OCEAN_FRAGMENT },
			{
				attributes: ["position", "uv"],
				uniforms: [
					"world",
					"worldViewProjection",
					"cameraPosition",
					"iTime",
					"windDir",
					"waveAmp",
					"sunDir",
					"cloudCover",
					"rain",
					"lightning",
					"skyTint",
					"sunTint",
					"fogColor",
					"fogDensity",
				],
				samplers: [],
			}
		);
		this.ocean.setVector3("sunDir", SUN_DIR);
		this.ocean.setVector2("windDir", new Vector2(1, 0));
		this.ocean.setFloat("waveAmp", 0.6);
		this.ocean.setFloat("cloudCover", 0.3);
		this.ocean.setFloat("rain", 0);
		this.ocean.setFloat("iTime", 0);
		this.ocean.setFloat("lightning", 0);
		this.sky.setFloat("lightning", 0);
		this.ocean.setVector3("skyTint", WHITE);
		this.ocean.setVector3("sunTint", WHITE);
		// Seed from the scene's current atmosphere so the very first frame matches
		// the ships/islands; update() keeps the mirror every frame.
		this.ocean.setVector3("fogColor", new Vector3(this.scene.fogColor.r, this.scene.fogColor.g, this.scene.fogColor.b));
		this.ocean.setFloat("fogDensity", this.scene.fogMode === Scene.FOGMODE_NONE ? 0 : this.scene.fogDensity);

		// 1600-unit patch at 200 subdivisions => dense near-field waves.
		this.mesh = MeshBuilder.CreateGround(
			"sea",
			{ width: 1600, height: 1600, subdivisions: 200, updatable: false },
			scene
		);
		this.mesh.material = this.ocean;
		this.mesh.isPickable = false;
		this.mesh.alwaysSelectAsActiveMesh = true;
	}

	private time = 0;

	/** Keep the sea grid + dome centred on the viewer (world-space waves stay put). */
	follow(x: number, z: number): void {
		this.mesh.position.x = x;
		this.mesh.position.z = z;
		this.skyMesh.position.set(x, 0, z);
	}

	/** Set the shared lightning overexposure (0..1). Sky + sea reflection flash. */
	setLightning(v: number): void {
		this.ocean.setFloat("lightning", v);
		this.sky.setFloat("lightning", v);
	}

	/**
	 * Time-of-day. Drives the sun direction (sky + sea glint) and the warm/cool
	 * tint of the whole atmosphere. All three default to the baked midday look,
	 * so leaving this unset changes nothing visually.
	 */
	setTimeOfDay(sunDir: Vector3, skyTint: Vector3, sunTint: Vector3): void {
		this.ocean.setVector3("sunDir", sunDir);
		this.sky.setVector3("sunDir", sunDir);
		this.ocean.setVector3("skyTint", skyTint);
		this.sky.setVector3("skyTint", skyTint);
		this.ocean.setVector3("sunTint", sunTint);
		this.sky.setVector3("sunTint", sunTint);
	}

	update(weather: WeatherState, dt: number): void {
		this.time += dt;
		const wlen = Math.hypot(weather.wind.x, weather.wind.z) || 1;
		this.ocean.setFloat("iTime", this.time);
		this.ocean.setVector2("windDir", new Vector2(weather.wind.x / wlen, weather.wind.z / wlen));
		this.ocean.setFloat("waveAmp", renderWaveAmp(weather.waveAmplitude));
		this.ocean.setFloat("cloudCover", weather.cloudCoverage);
		this.ocean.setFloat("rain", weather.rainIntensity);
		this.sky.setFloat("cloudCover", weather.cloudCoverage);
		this.sky.setFloat("iTime", this.time);
		// Mirror the live scene atmosphere (set upstream by WeatherSystem.applyFog)
		// so the sea is veiled by exactly the same fog as ships and islands.
		const fc = this.scene.fogColor;
		this.ocean.setVector3("fogColor", new Vector3(fc.r, fc.g, fc.b));
		this.ocean.setFloat("fogDensity", this.scene.fogMode === Scene.FOGMODE_NONE ? 0 : this.scene.fogDensity);
	}

	dispose(): void {
		this.mesh.dispose();
		this.skyMesh.dispose();
		this.ocean.dispose();
		this.sky.dispose();
	}
}
