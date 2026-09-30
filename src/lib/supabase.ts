"use client";

import { createClient, type SupabaseClient } from "@supabase/supabase-js";

/**
 * Browser Supabase client — used ONLY for the Web3 auth session (sign-in with a
 * wallet signature). The game's authoritative off-chain persistence still lives on
 * the :9000 server (which talks to Supabase with the service-role key); the client
 * never touches the world_snapshots table directly. This session exists so the
 * login is a real Supabase identity (RLS-ready) rather than just a raw wallet.
 *
 * Reads NEXT_PUBLIC_* (public values), so it is safe to ship in the bundle. If the
 * env is unset (Supabase not configured) `supabase` is null and sign-in no-ops.
 */
const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
const anonKey = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;

export const supabase: SupabaseClient | null =
	url && anonKey ? createClient(url, anonKey) : null;

/**
 * Exchange the connected injected wallet (window.ethereum) for a Supabase auth
 * session via the Web3 provider: Supabase asks the wallet to `personal_sign` a
 * one-time message, verifies it server-side, and issues a JWT keyed on the address.
 * MUST be called from a user gesture (it opens the wallet's signature popup).
 *
 * On a successful auth it also REGISTERS the wallet in the `players` table: if the
 * address isn't there yet it's inserted and `isNew` is true (a genuinely first-time
 * player — this is what gates the cinematic intro, so "first time" is global across
 * every device/browser, not per-localStorage). A returning wallet returns isNew=false.
 *
 * Returns null when Supabase isn't configured or the signature was declined (no
 * session). Never throws — a failed auth/insert must not block gameplay.
 */
export async function signInWithWallet(
	addressHint?: string,
	statement = "Sign in to HighSeaz"
): Promise<{ address: string; isNew: boolean } | null> {
	if (!supabase) return null;
	try {
		const { data, error } = await supabase.auth.signInWithWeb3({ chain: "ethereum", statement });
		if (error || !data.session) {
			if (error) console.warn("[supabase] web3 sign-in failed:", error.message);
			return null;
		}
		const meta = data.session.user.user_metadata as { provider_address?: string } | undefined;
		const addr = (addressHint ?? meta?.provider_address ?? "").toLowerCase();
		if (!addr) return { address: "", isNew: false };

		// First-seen check + register. `players` RLS lets an authenticated user read
		// and insert their own address row (see the SQL in the project notes).
		const { data: existing, error: selErr } = await supabase.from("players").select("address").eq("address", addr).maybeSingle();
		if (selErr) console.warn("[supabase] players select failed:", selErr.message);
		if (existing) return { address: addr, isNew: false };

		const { error: insErr } = await supabase.from("players").insert({ address: addr });
		// A concurrent duplicate (unique/PK clash) means someone just registered it —
		// treat as returning so the intro doesn't double-fire.
		if (insErr) {
			console.warn("[supabase] players insert failed:", insErr.message);
			return { address: addr, isNew: false };
		}
		return { address: addr, isNew: true };
	} catch (err) {
		console.warn("[supabase] web3 sign-in threw:", err);
		return null;
	}
}
