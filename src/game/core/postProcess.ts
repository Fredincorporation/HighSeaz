import { DefaultRenderingPipeline, Scene, ImageProcessingConfiguration, Color4 } from "@babylonjs/core";
import { applyColorGrade } from "./colorGrade";

/**
 * Filmic grade that turns the raw render into a "game frame": ACES tone mapping,
 * bloom for the sun/sky glints and foam, plus light vignette + grain. This is
 * the single highest-impact-per-hour visual upgrade in the pass.
 */
export function createPostProcess(scene: Scene): DefaultRenderingPipeline {
	scene.imageProcessingConfiguration.toneMappingEnabled = true;
	scene.imageProcessingConfiguration.toneMappingType = ImageProcessingConfiguration.TONEMAPPING_ACES;
	scene.imageProcessingConfiguration.exposure = 1.15;
	scene.imageProcessingConfiguration.contrast = 1.25;

	const pipeline = new DefaultRenderingPipeline("grade", true, scene, [scene.activeCamera!]);

	pipeline.bloomEnabled = true;
	pipeline.bloomThreshold = 0.75;
	pipeline.bloomWeight = 0.35;
	pipeline.bloomKernel = 64;
	pipeline.bloomScale = 0.5;

	pipeline.imageProcessingEnabled = true;

	pipeline.fxaaEnabled = true;

	pipeline.grainEnabled = true;
	pipeline.grain.intensity = 5;
	pipeline.grain.animated = true;

	pipeline.imageProcessing.vignetteEnabled = true;
	pipeline.imageProcessing.vignetteWeight = 2.4;
	pipeline.imageProcessing.vignetteColor = new Color4(0, 0, 0, 0);

	// Warm tropical grade (task #142): a `.3dl` split-tone LUT layered on top of
	// the ACES result — warm/yellow highlights, deep cyan shadows for the
	// sun-soaked Caribbean read. Additive and revertible (see colorGrade.ts);
	// gated to the "high" preset automatically because it lives in the
	// image-processing pass, which createGame disables on "low".
	applyColorGrade(pipeline, scene);

	return pipeline;
}
