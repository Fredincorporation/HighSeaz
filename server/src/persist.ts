import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Durable OFF-chain world-state storage (#163).
 *
 * The game server is authoritative and pushes each player's ledger over the
 * socket, so the CLIENT never talks to Supabase — only this module does, using
 * the SECRET service-role key. That key lives solely in `server/.env`
 * (untracked; see root .gitignore) and bypasses Postgres RLS.
 *
 * The whole-world `world.serialize()` JSON blob is stored as a single-row
 * snapshot (id = ROW_ID) rather than a normalized schema, which keeps the exact
 * `serialize()/restore()` contract intact and is a zero-risk drop-in over the
 * prior `world-state.json` file. The file is retained by the caller as a local
 * fallback/cache, so gameplay is fully durable even with Supabase env unset.
 *
 * Missing URL/key → `supabaseEnabled` false → every call is a no-op and the
 * caller falls back to the JSON file, exactly as before this feature existed.
 */
const URL = process.env.SUPABASE_URL ?? "";
const KEY = process.env.SUPABASE_SERVICE_ROLE_KEY ?? "";

let client: SupabaseClient | null = null;
if (URL && KEY) {
	try {
		// persistSession:false — this is a server-to-server service connection, not
		// an interactive user; no local session/jwks to keep.
		client = createClient(URL, KEY, { auth: { persistSession: false, autoRefreshToken: false } });
	} catch (err) {
		console.error("[persist] Supabase client init failed:", err instanceof Error ? err.message : err);
		client = null;
	}
}

export const supabaseEnabled = client !== null;

const TABLE = process.env.SUPABASE_WORLD_TABLE ?? "world_snapshots";
const ROW_ID = process.env.SUPABASE_WORLD_ROW ?? "world";

/** Read the stored snapshot blob, or null if disabled / no row yet / on error. */
export async function loadSnapshot(): Promise<string | null> {
	if (!client) return null;
	const { data, error } = await client.from(TABLE).select("data").eq("id", ROW_ID).maybeSingle();
	if (error) {
		console.error("[persist] snapshot load failed:", error.message);
		return null;
	}
	if (!data || data.data == null) return null;
	return typeof data.data === "string" ? (data.data as string) : JSON.stringify(data.data);
}

/** Write the snapshot blob. Returns true on a confirmed upsert, false otherwise. */
export async function saveSnapshot(json: string): Promise<boolean> {
	if (!client) return false;
	const { error } = await client
		.from(TABLE)
		.upsert({ id: ROW_ID, data: json, updated_at: new Date().toISOString() }, { onConflict: "id" });
	if (error) {
		console.error("[persist] snapshot save failed:", error.message);
		return false;
	}
	return true;
}
