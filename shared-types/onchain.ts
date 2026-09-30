/**
 * HighSeaz on-chain configuration — the small, dependency-free contract-layer
 * facts shared by BOTH the browser wallet and the server relayer. Kept free of
 * `viem` (and any runtime) so both sides can import it; the ABIs it pairs with
 * are auto-generated in ./abis.ts from the Foundry artifacts.
 *
 * Contract ADDRESSES are injected at runtime from the environment (they differ
 * per deployment), never hardcoded here — see deployments/ after `forge script
 * Deploy --broadcast`.
 */

/** USDG (Paxos) is 6-decimal. The game never mints value; it only moves this. */
export const USDG_DECIMALS = 6;

/** Robinhood Chain — an Arbitrum Orbit L2. Gas is paid in ETH; value is USDG. */
export interface ChainConfig {
	name: string;
	id: number;
	rpcUrl: string;
	nativeCurrency: { name: string; symbol: string; decimals: number };
	explorerUrl?: string;
}

/**
 * Testnet descriptor. The chain id / RPC / explorer are read from the
 * environment at runtime so a swap to a fresh rollup instance needs no code
 * change; the fallbacks are the known public Robinhood Chain testnet values.
 */
export const RH_TESTNET: ChainConfig = {
	name: "Robinhood Chain Testnet",
	id: 46630,
	rpcUrl: "https://rpc.testnet.chain.robinhood.com",
	nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
	explorerUrl: "https://explorer.testnet.chain.robinhood.com",
};

/** Deployed settlement-contract addresses (post-deploy; env-injected per side). */
export interface ContractAddresses {
	usdg: `0x${string}`;
	shipNFT: `0x${string}`;
	lootMint: `0x${string}`;
	allianceRegistry: `0x${string}`;
	bountyEscrow: `0x${string}`;
	auctionHouse: `0x${string}`;
	shipStore: `0x${string}`;
}

/** Buy-only NPC hull prices in USDG base units, mirroring Deploy.s.sol.
 *  Set deliberately low "for now" so the buy-to-play loop is easy to demo. */
export const HULL_PRICES: Record<string, bigint> = {
	starter_sloop: 500_000n,
	raider_sloop: 1_000_000n,
	raider_brig: 2_000_000n,
	brigantine: 3_000_000n,
	merchant: 4_000_000n,
	galleon: 6_000_000n,
	war_galleon: 10_000_000n,
	imperial: 20_000_000n,
};

/** Format 6-decimal USDG base units as a human string (e.g. 1250e4 -> "1250.00"). */
export function formatUsdg(base: bigint, dp = 2): string {
	const neg = base < 0n;
	const abs = neg ? -base : base;
	const whole = abs / 10n ** BigInt(USDG_DECIMALS);
	const frac = abs % 10n ** BigInt(USDG_DECIMALS);
	const fracStr = frac.toString().padStart(USDG_DECIMALS, "0").slice(0, dp);
	return `${neg ? "-" : ""}${whole.toString()}${dp > 0 ? "." + fracStr : ""}`;
}

/** Parse a whole/decimal USDG string into 6-decimal base units. */
export function parseUsdg(value: string): bigint {
	const neg = value.trim().startsWith("-");
	const clean = value.replace(/-/g, "");
	const [whole, frac = ""] = clean.split(".");
	const scaled = (frac + "0".repeat(USDG_DECIMALS)).slice(0, USDG_DECIMALS);
	const base = BigInt(whole || "0") * 10n ** BigInt(USDG_DECIMALS) + BigInt(scaled || "0");
	return neg ? -base : base;
}
