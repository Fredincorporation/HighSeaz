/**
 * Single source of truth for asset URLs.
 *
 * Game assets are referenced as root-relative paths ("/models/…", "/vfx/…",
 * "/audio/…", "/lut/…" …) so the Babylon loaders, textures and <audio> elements
 * all resolve against either:
 *   - the empty base (default) → Next.js serves them from `public/` at
 *     `:3000`, which keeps local/offline dev working with zero setup, or
 *   - `NEXT_PUBLIC_ASSET_BASE` (e.g. the Cloudflare R2 public dev bucket
 *     `https://pub-4399d522d0d140df9830051a19f2e30f.r2.dev`) → every asset is
 *     fetched from the CDN instead.
 *
 * The sea shanties already stream from R2 unconditionally (see AudioSystem's
 * SHANTY_BASE); this generalises the same idea to the rest of the library so the
 * whole `public/` tree can be served from the bucket once uploaded — the
 * repo-light / user-generated-model origin the design calls for. Set the env var
 * AFTER running `npm run assets:upload`; leaving it blank safely falls back to
 * local files.
 */

// Trailing slashes would double up with the leading slash on every path.
const RAW_BASE = process.env.NEXT_PUBLIC_ASSET_BASE ?? "";
export const ASSET_BASE = RAW_BASE.replace(/\/+$/, "");

/** Prefix a root-relative asset path with the configured base (no-op when local). */
export function asset(path: string): string {
	if (!ASSET_BASE) return path;
	return `${ASSET_BASE}${path.startsWith("/") ? path : `/${path}`}`;
}
