// Upload the whole public/ asset tree to a Cloudflare R2 bucket.
//
// R2 is S3-compatible, so this uses the plain AWS SDK — no Cloudflare SDK. The
// bucket ALREADY serves the sea shanties from its public dev URL, so the app can
// point at it by setting NEXT_PUBLIC_ASSET_BASE (see src/game/core/assets.ts).
//
// Credentials come from ENVIRONMENT ONLY (never hardcode, never commit):
//   R2_ACCESS_KEY_ID      R2_SECRET_ACCESS_KEY      R2_BUCKET      [R2_ACCOUNT_ID]
//   # or the full URL directly: R2_ENDPOINT=https://<account>.r2.cloudflarestorage.com
//
// Usage:
//   node scripts/upload-to-r2.mjs            # upload everything
//   node scripts/upload-to-r2.mjs --dry-run  # list keys + content-types only
//   node scripts/upload-to-r2.mjs models forts  # only these top-level prefixes
import { readdirSync, statSync, readFileSync } from "node:fs";
import { join, posix, relative, sep, extname } from "node:path";
import { S3Client, PutObjectCommand, HeadObjectCommand } from "@aws-sdk/client-s3";

const ROOT = "public";
const args = process.argv.slice(2);
const DRY = args.includes("--dry-run");
const ONLY = args.filter((a) => !a.startsWith("--"));

const CONTENT_TYPES = {
	".glb": "model/gltf-binary",
	".gltf": "model/gltf+json",
	".png": "image/png",
	".jpg": "image/jpeg",
	".jpeg": "image/jpeg",
	".webp": "image/webp",
	".svg": "image/svg+xml",
	".mp3": "audio/mpeg",
	".ogg": "audio/ogg",
	".wav": "audio/wav",
	".json": "application/json",
	".txt": "text/plain; charset=utf-8",
	".3dl": "text/plain; charset=utf-8",
	".env": "application/octet-stream",
	".babylon": "application/octet-stream",
	".babylonbinarymeshdata": "application/octet-stream",
	".material": "application/octet-stream",
	".fx": "application/octet-stream",
};

function contentTypeFor(file) {
	return CONTENT_TYPES[extname(file).toLowerCase()] ?? "application/octet-stream";
}

/** Recursively collect every file under `dir`, returning {abs, key} pairs. */
function walk(dir) {
	const out = [];
	for (const entry of readdirSync(dir)) {
		const abs = join(dir, entry);
		if (statSync(abs).isDirectory()) out.push(...walk(abs));
		else out.push(abs);
	}
	return out;
}

const account = process.env.R2_ACCOUNT_ID;
const endpoint =
	process.env.R2_ENDPOINT ??
	(account ? `https://${account}.r2.cloudflarestorage.com` : undefined);
const bucket = process.env.R2_BUCKET;

if (!DRY && (!endpoint || !bucket || !process.env.R2_ACCESS_KEY_ID || !process.env.R2_SECRET_ACCESS_KEY)) {
	console.error(
		"Missing R2 config. Set R2_ENDPOINT (or R2_ACCOUNT_ID), R2_BUCKET, R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY in your environment."
	);
	process.exit(1);
}

const s3 = new S3Client({
	region: "auto",
	endpoint,
	credentials: {
		accessKeyId: process.env.R2_ACCESS_KEY_ID ?? "",
		secretAccessKey: process.env.R2_SECRET_ACCESS_KEY ?? "",
	},
});

const all = walk(ROOT).map((abs) => ({
	abs,
	key: relative(ROOT, abs).split(sep).join(posix.sep), // POSIX keys, mirrors public/ paths
}));
const files = ONLY.length ? all.filter((f) => ONLY.some((p) => f.key === p || f.key.startsWith(p + "/"))) : all;

const CACHE_CONTROL = "public, max-age=31536000, immutable";
let done = 0;
let bytes = 0;
const started = Date.now();

async function uploadOne(f) {
	const body = readFileSync(f.abs);
	await s3.send(
		new PutObjectCommand({
			Bucket: bucket,
			Key: f.key,
			Body: body,
			ContentType: contentTypeFor(f.abs),
			CacheControl: CACHE_CONTROL,
		})
	);
	done++;
	bytes += body.length;
	if (done % 10 === 0 || done === files.length) {
		const mb = (bytes / 1e6).toFixed(1);
		console.log(`  ${done}/${files.length} files  (${mb} MB)`);
	}
}

// Small concurrency pool so the ~130 files (big GLBs included) upload in seconds.
async function pool(items, worker, limit = 8) {
	let i = 0;
	const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
		while (i < items.length) {
			const idx = i++;
			await worker(items[idx]);
		}
	});
	await Promise.all(runners);
}

console.log(`R2 upload → bucket "${bucket ?? "(dry-run)"}" @ ${endpoint ?? "(dry-run)"}`);
console.log(`${files.length} files under ${ROOT}/ ${ONLY.length ? `(filter: ${ONLY.join(", ")})` : ""}${DRY ? " [DRY RUN]" : ""}`);

if (DRY) {
	for (const f of files) console.log(`  ${f.key}  →  ${contentTypeFor(f.abs)}`);
	console.log("Dry run complete — nothing uploaded.");
	process.exit(0);
}

await pool(files, uploadOne, 8);

// Verify one representative object round-trips with the right content-type.
try {
	const sample = files.find((f) => f.key.endsWith(".glb")) ?? files[0];
	const head = await s3.send(new HeadObjectCommand({ Bucket: bucket, Key: sample.key }));
	console.log(`\nVerified ${sample.key}: content-type=${head.ContentType}, size=${head.ContentLength}`);
} catch (e) {
	console.warn("Verification HEAD failed:", e?.message ?? e);
}

console.log(`Done. Uploaded ${done} files (${(bytes / 1e6).toFixed(1)} MB) in ${((Date.now() - started) / 1000).toFixed(1)}s.`);
console.log(`Set NEXT_PUBLIC_ASSET_BASE=${(endpoint ?? "").replace(".r2.cloudflarestorage.com", ".r2.dev") || "https://<your-r2-public-url>"} to serve from R2.`);
