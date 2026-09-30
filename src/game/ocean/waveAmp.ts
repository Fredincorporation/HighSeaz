/**
 * Single source of truth for the wave amplitude the ocean SHADER draws and the
 * hull-riding math in ShipManager both use. They MUST read the same number or
 * the ship detaches from the surface it is supposed to float on.
 *
 * The server's WeatherState.waveAmplitude climbs to ~2.2 in a storm. Because a
 * Gerstner wave's vertical throw is `steep / k * amp`, that peak makes the
 * long-period swell (120-unit wavelength) tower many times a small hull's
 * freeboard, so a ship sitting in a trough reads as "swallowed by the sea".
 * We leave calm/moderate seas untouched (they sit below the cap) and clamp only
 * the storm crest so a squall still looks dramatic but never drowns the boat.
 */
export const MAX_RENDER_WAVE_AMP = 1.0;

export function renderWaveAmp(waveAmplitude: number): number {
	return Math.min(MAX_RENDER_WAVE_AMP, Math.max(0.2, waveAmplitude));
}
