import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

/**
 * Load `server/.env` into process.env BEFORE any config is read. Imported as the
 * very first line of index.ts so the relayer's `fromEnv()` (which runs at module
 * evaluation) sees the on-chain variables. Uses Node's built-in loader (v20.12+),
 * so no dotenv dependency. The path is resolved relative to THIS compiled module
 * (server/dist or server/src -> ../.env == server/.env), so it works regardless
 * of the process cwd. Missing file is a silent no-op: gameplay stays fully
 * playable with the relayer disabled, exactly as before.
 */
const envPath = fileURLToPath(new URL("../.env", import.meta.url));
if (existsSync(envPath)) {
	process.loadEnvFile(envPath);
	console.log(`[env] loaded ${envPath}`);
} else {
	console.log(`[env] no ${envPath} — using process.env defaults (relayer disabled unless vars are set)`);
}
