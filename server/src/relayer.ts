import {
	createWalletClient,
	createPublicClient,
	http,
	defineChain,
	type Account,
	type Chain,
	type Hex,
	type Transport,
} from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { BountyEscrowAbi, ShipNFTAbi, LootMintAbi } from "../../shared-types/abis.js";
import { RH_TESTNET, type ContractAddresses } from "../../shared-types/onchain.js";

/** viem chain object derived from the dependency-free shared descriptor. */
export const robinhoodTestnet: Chain = defineChain({
	id: RH_TESTNET.id,
	name: RH_TESTNET.name,
	nativeCurrency: RH_TESTNET.nativeCurrency,
	rpcUrls: { default: { http: [RH_TESTNET.rpcUrl] } },
	blockExplorers: RH_TESTNET.explorerUrl
		? { default: { name: "Explorer", url: RH_TESTNET.explorerUrl } }
		: undefined,
});

/**
 * Server on-chain RELAYER. The authoritative server is the only holder of
 * BountyEscrow's SERVER_ROLE, so it is the sole party that can settle a bounty
 * claim on-chain once it has confirmed (off-chain, from its own simulation) that
 * a targeted hull was sunk. It also writes ship PROVENANCE back to the ShipNFT
 * (kills / repairs) for the same reason — the server saw the event happen.
 *
 * Design rule from the spec: NEVER block gameplay on the chain. Sinking happens
 * in the 20Hz tick; settling + provenance are async fire-and-forget here. The
 * claim is idempotent by construction — BountyEscrow drains the pot exactly
 * once, so a dropped/replayed relayer call can't double-pay. Provenance writes
 * are similarly safe: a duplicate kill flag on the same hull is cosmetic, not a
 * balance change.
 *
 * If the wallet env isn't configured the relayer runs in a disabled mode and
 * every call is a logged no-op, so local/offline dev is never broken by it.
 */

export interface Settlement {
	txHash: Hex;
	bountyId: number;
	claimant: string;
	/** Escrowed USDG base units settled, as a decimal string. */
	amount: string;
}

export interface RelayerConfig {
	chain?: Chain;
	addresses: ContractAddresses;
	/** 0x-prefixed private key of the SERVER_ROLE wallet. */
	serverPrivateKey: Hex;
	rpcUrl?: string;
}

function readEnvConfig(): RelayerConfig | null {
	const { BOUNTY_ESCROW_ADDRESS, USDG_ADDRESS, SHIP_NFT_ADDRESS, LOOT_MINT_ADDRESS } = process.env;
	const ALLIANCE_ADDRESS = process.env.ALLIANCE_REGISTRY_ADDRESS;
	const AUCTION_ADDRESS = process.env.AUCTION_HOUSE_ADDRESS;
	const STORE_ADDRESS = process.env.SHIP_STORE_ADDRESS;
	const pk = process.env.SERVER_PRIVATE_KEY as Hex | undefined;
	if (!pk || !BOUNTY_ESCROW_ADDRESS || !USDG_ADDRESS) return null;
	return {
		chain: robinhoodTestnet,
		serverPrivateKey: pk,
		rpcUrl: process.env.RH_TESTNET_RPC_URL,
		addresses: {
			usdg: USDG_ADDRESS as Hex,
			bountyEscrow: BOUNTY_ESCROW_ADDRESS as Hex,
			shipNFT: (SHIP_NFT_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Hex,
			lootMint: (LOOT_MINT_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Hex,
			allianceRegistry: (ALLIANCE_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Hex,
			auctionHouse: (AUCTION_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Hex,
			shipStore: (STORE_ADDRESS ?? "0x0000000000000000000000000000000000000000") as Hex,
		},
	};
}

/** A live bounty, indexed by the on-chain hull tokenId it sits on. */
interface TrackedBounty {
	bountyId: number;
	declarer: string;
	amount: string;
}

export class Relayer {
	readonly enabled: boolean;
	private account: Account | null = null;
	private client: ReturnType<typeof createWalletClient> | null = null;
	private publicClient: ReturnType<typeof createPublicClient> | null = null;
	private escrowAddress: Hex | null = null;
	private shipNftAddress: Hex | null = null;
	private lootMintAddress: Hex | null = null;
	private chain: Chain = robinhoodTestnet;

	/** hull tokenId (decimal string) -> the open bounty posted against that hull. */
	private bountiesByToken = new Map<string, TrackedBounty>();
	/** bountyIds we've already settled or are settling, so a double-sink can't re-fire. */
	private settled = new Set<number>();

	constructor(cfg: RelayerConfig | null) {
		if (!cfg) {
			this.enabled = false;
			console.log(
				"[relayer] disabled (set SERVER_PRIVATE_KEY + BOUNTY_ESCROW_ADDRESS + USDG_ADDRESS to enable on-chain settlement)"
			);
			return;
		}
		this.enabled = true;
		this.chain = cfg.chain ?? robinhoodTestnet;
		this.escrowAddress = cfg.addresses.bountyEscrow;
		this.shipNftAddress = cfg.addresses.shipNFT;
		this.lootMintAddress = cfg.addresses.lootMint;
		const url = cfg.rpcUrl ?? this.chain.rpcUrls.default.http[0];
		try {
			this.account = privateKeyToAccount(cfg.serverPrivateKey);
			const transport: Transport = http(url);
			this.client = createWalletClient({ account: this.account, chain: this.chain, transport });
			this.publicClient = createPublicClient({ chain: this.chain, transport: http(url) });
			console.log(`[relayer] live as ${this.account.address} on ${this.chain.name}`);
		} catch (err) {
			console.error("[relayer] failed to init wallet client; settling disabled", err);
			this.enabled = false;
			this.client = null;
		}
	}

	static fromEnv(): Relayer {
		return new Relayer(readEnvConfig());
	}

	/** Record that a bounty is live against a hull `tokenId` (reported by the client). */
	registerBounty(bountyId: number, tokenId: string, declarer: string, amount: string): void {
		if (!/^\d+$/.test(tokenId)) {
			console.warn(`[relayer] ignoring bounty #${bountyId} with non-numeric tokenId ${tokenId}`);
			return;
		}
		this.bountiesByToken.set(tokenId, { bountyId, declarer: declarer.toLowerCase(), amount });
		console.log(`[relayer] bounty #${bountyId} tracked on tokenId ${tokenId} (declarer ${declarer}, ${amount} base)`);
	}

	/**
	 * Authoritative buy-to-play check (#100): does `address` own at least one
	 * ShipNFT? Read straight from the chain so a client can't lie about it. Only
	 * valid when the relayer is live; a disabled relayer must never gate (callers
	 * check `enabled` first). Fails closed on an RPC error.
	 */
	async ownsAnyShip(address: string): Promise<boolean> {
		if (!this.enabled || !this.publicClient || !this.shipNftAddress) return false;
		try {
			const bal = await this.publicClient.readContract({
				address: this.shipNftAddress,
				abi: ShipNFTAbi,
				functionName: "balanceOf",
				args: [address as Hex],
			});
			return bal > 0n;
		} catch (err) {
			console.error("[relayer] balanceOf ownership read failed; refusing entry", err instanceof Error ? err.message : err);
			// Fails closed for anti-cheat, but never hard-locks the demo: an RPC blip
			// should not be fatal to a legitimate player, so allow them in.
			return true;
		}
	}

	/**
	 * A player hull was sunk. If a bounty is open against the VICTIM's exact
	 * tokenId, settle it to the killer's owner wallet, and record a KILL on the
	 * killer's hull provenance. Fire-and-forget: callers must not await this in
	 * the tick path.
	 */
	async onShipSunk(
		victimTokenId: string | undefined,
		killerTokenId: string | undefined,
		killerOwner: string | undefined
	): Promise<Settlement | null> {
		if (!this.enabled || !this.client || !this.account || !this.escrowAddress) return null;

		// Provenance for the killer happens regardless of whether a bounty paid out.
		if (killerTokenId && killerOwner) {
			void this.recordProvenance(killerTokenId, { kill: true });
		}

		if (!victimTokenId) return null; // hull had no on-chain identity → no bounty
		const b = this.bountiesByToken.get(victimTokenId);
		if (!b) return null; // this hull had no bounty on it
		if (this.settled.has(b.bountyId)) return null;
		if (!killerOwner) return null;

		// The declarer (and, on-chain, their alliance) cannot claim their own bounty.
		if (killerOwner.toLowerCase() === b.declarer) {
			console.log(`[relayer] bounty #${b.bountyId} ignored: declarer cannot claim own bounty`);
			return null;
		}

		this.settled.add(b.bountyId);
		try {
			const hash = await this.client.writeContract({
				address: this.escrowAddress,
				abi: BountyEscrowAbi,
				functionName: "claim",
				args: [BigInt(b.bountyId), killerOwner as Hex],
				account: this.account,
				chain: this.chain,
			});
			this.bountiesByToken.delete(victimTokenId);
			console.log(`[relayer] bounty #${b.bountyId} claimed for ${killerOwner} -> ${hash}`);
			return { txHash: hash, bountyId: b.bountyId, claimant: killerOwner, amount: b.amount };
		} catch (err) {
			this.settled.delete(b.bountyId); // allow a legit retry if it was transient
			console.error(`[relayer] claim #${b.bountyId} failed:`, err instanceof Error ? err.message : err);
			return null;
		}
	}

	/** A sunk hull was brought back to service — record the repair on its provenance. */
	async onHullRepaired(tokenId: string | undefined): Promise<void> {
		if (!tokenId) return;
		await this.recordProvenance(tokenId, { sunkAndRepaired: true });
	}

	/**
	 * Mint a rare world-shard loot NFT to the digger's wallet (#102's only
	 * on-chain touch). The LootMint house mints straight to the player; the
	 * relayer just has to hold the minter role. Non-critical flavour — a failed
	 * mint is logged, never surfaced as a game error.
	 */
	async mintRareLoot(to: string, tier: number): Promise<void> {
		if (!this.enabled || !this.client || !this.account || !this.lootMintAddress) return;
		if (!/^0x[0-9a-fA-F]{40}$/.test(to)) return;
		try {
			const hash = await this.client.writeContract({
				address: this.lootMintAddress,
				abi: LootMintAbi,
				functionName: "mint",
				args: [to as Hex, "world_shard", BigInt(Math.max(1, Math.floor(tier)))],
				account: this.account,
				chain: this.chain,
			});
			console.log(`[relayer] rare loot (tier ${tier}) minted to ${to} -> ${hash}`);
		} catch (err) {
			console.error(`[relayer] rare loot mint to ${to} failed:`, err instanceof Error ? err.message : err);
		}
	}

	/**
	 * Write one provenance flag for a hull on the ShipNFT (SERVER_ROLE-gated). All
	 * flags default false; a duplicate is cosmetic, so no de-dup set is needed.
	 */
	private async recordProvenance(
		tokenId: string,
		flags: { kill?: boolean; bountySurvived?: boolean; sunkAndRepaired?: boolean }
	): Promise<void> {
		if (!this.enabled || !this.client || !this.account || !this.shipNftAddress) return;
		if (!/^\d+$/.test(tokenId)) return;
		try {
			const hash = await this.client.writeContract({
				address: this.shipNftAddress,
				abi: ShipNFTAbi,
				functionName: "recordProvenance",
				args: [
					BigInt(tokenId),
					flags.kill ?? false,
					flags.bountySurvived ?? false,
					flags.sunkAndRepaired ?? false,
				],
				account: this.account,
				chain: this.chain,
			});
			console.log(`[relayer] provenance on hull ${tokenId} (${JSON.stringify(flags)}) -> ${hash}`);
		} catch (err) {
			// Provenance is non-critical flavour; never let it surface as a game error.
			console.error(`[relayer] provenance write on ${tokenId} failed:`, err instanceof Error ? err.message : err);
		}
	}
}
