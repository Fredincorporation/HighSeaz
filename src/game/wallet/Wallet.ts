import {
	createPublicClient,
	createWalletClient,
	custom,
	http,
	defineChain,
	decodeEventLog,
	keccak256,
	toBytes,
	type Address,
	type Hex,
	type Log,
} from "viem";
import {
	AuctionHouseAbi,
	AllianceRegistryAbi,
	BountyEscrowAbi,
	MockUSDGAbi,
	ShipNFTAbi,
	ShipStoreAbi,
} from "@shared/abis";
import { RH_TESTNET, parseUsdg, formatUsdg } from "@shared/onchain";

/**
 * Browser wallet layer backed by an INJECTED EIP-1193 provider (MetaMask / Rabby /
 * any browser wallet). The player installs a wallet, and this class is a thin viem
 * signer that talks to `window.ethereum` directly: connect() requests accounts, and
 * every on-chain write routes through that provider. Server-authoritative settlement
 * (bounty claims) stays the RELAYER's job; the client never holds the SERVER_ROLE.
 *
 * With no injected wallet present, connect()/restore() resolve to null so the HUD
 * shows "no wallet" and gameplay stays playable (the spec's rule: never block play
 * on the chain). A connected wallet is additionally exchanged for a Supabase auth
 * session via signInWithWeb3 (see src/lib/supabase.ts) — that session is separate
 * from this on-chain signer.
 */

const ADDR = {
	usdg: (process.env.NEXT_PUBLIC_USDG_ADDRESS ?? "") as Address,
	bountyEscrow: (process.env.NEXT_PUBLIC_BOUNTY_ESCROW_ADDRESS ?? "") as Address,
	shipStore: (process.env.NEXT_PUBLIC_SHIP_STORE_ADDRESS ?? "") as Address,
	shipNft: (process.env.NEXT_PUBLIC_SHIP_NFT_ADDRESS ?? "") as Address,
	auctionHouse: (process.env.NEXT_PUBLIC_AUCTION_HOUSE_ADDRESS ?? "") as Address,
	allianceRegistry: (process.env.NEXT_PUBLIC_ALLIANCE_REGISTRY_ADDRESS ?? "") as Address,
};
const RPC_URL = process.env.NEXT_PUBLIC_RH_RPC_URL ?? RH_TESTNET.rpcUrl;

const chain = defineChain({
	id: RH_TESTNET.id,
	name: RH_TESTNET.name,
	nativeCurrency: RH_TESTNET.nativeCurrency,
	rpcUrls: { default: { http: [RPC_URL] } },
	blockExplorers: RH_TESTNET.explorerUrl ? { default: { name: "Explorer", url: RH_TESTNET.explorerUrl } } : undefined,
});

/** Minimal EIP-1193 shape an injected browser wallet (window.ethereum) satisfies. */
interface Eip1193Provider {
	request: (a: { method: string; params?: unknown[] | object }) => Promise<unknown>;
	on?: (event: string, listener: (...args: never[]) => void) => void;
	removeListener?: (event: string, listener: (...args: never[]) => void) => void;
}

declare global {
	interface Window {
		ethereum?: Eip1193Provider;
	}
}

/** Decode the first log from `emitter` matching `eventName`, or null. */
function findEvent(
	logs: Log[],
	emitter: Address,
	abi: Parameters<typeof decodeEventLog>[0]["abi"],
	eventName: string
): { args: Record<string, unknown> } | null {
	for (const log of logs) {
		if (log.address.toLowerCase() !== emitter.toLowerCase()) continue;
		try {
			const decoded = decodeEventLog({
				abi,
				data: log.data,
				topics: log.topics as [Hex, ...Hex[]],
			}) as { eventName: string; args: Record<string, unknown> };
			if (decoded.eventName === eventName) return decoded;
		} catch {
			/* not this ABI's event — keep scanning */
		}
	}
	return null;
}

export interface BountyResult {
	bountyId: number;
	tokenId: string;
	amount: string;
	txHash: Hex;
}

/** A decoded snapshot of one on-chain auction (from the public `auctions` getter). */
export interface AuctionState {
	nft: Address;
	tokenId: bigint;
	seller: Address;
	endsAt: bigint;
	highestBidder: Address;
	highestBid: bigint;
	settled: boolean;
	open: boolean;
}

export class Wallet {
	address: Address | null = null;
	readonly configured = Boolean(ADDR.usdg && ADDR.bountyEscrow);

	private publicClient = createPublicClient({ chain, transport: http(RPC_URL) });
	private account: Address | null = null;
	/** The injected EIP-1193 provider (window.ethereum). All signing routes through
	 *  it; null until connect()/restore() latches a wallet. */
	private ethProvider: Eip1193Provider | null = null;
	/** Notified on any account change (connect, wallet-side switch, disconnect).
	 *  createGame wires this to rebind the net address, refresh the buy-to-play
	 *  entitlement, and push the new address up to the DOM. */
	public onAccountsChanged: ((addr: Address | null) => void) | null = null;
	/** Whether the accountsChanged/chainChanged listeners are already bound. */
	private listening = false;
	private handleAccountsChanged = (accounts: unknown): void => {
		const list = (accounts as string[] | undefined) ?? [];
		const addr = list[0] as Address | undefined;
		if (addr) this.setAccount(addr);
		else this.detach();
	};
	private handleChainChanged = (): void => {
		void this.ensureChain();
	};

	/** The injected provider, or null when no browser wallet is installed. */
	private injected(): Eip1193Provider | null {
		if (typeof window === "undefined") return null;
		return window.ethereum ?? null;
	}

	/** Subscribe to wallet-side account/chain switches once (idempotent). */
	private bindListeners(eth: Eip1193Provider): void {
		if (this.listening || !eth.on) return;
		this.listening = true;
		eth.on("accountsChanged", this.handleAccountsChanged as (...args: never[]) => void);
		eth.on("chainChanged", this.handleChainChanged as (...args: never[]) => void);
	}

	/** Adopt `addr` as the live account and notify once if it actually changed. */
	private setAccount(addr: Address): void {
		const changed = this.account !== addr;
		this.account = addr;
		this.address = addr;
		if (changed) this.onAccountsChanged?.(addr);
	}

	/** Prompt the injected wallet to connect (eth_requestAccounts) and adopt the
	 *  chosen account. Returns the address, or null if no wallet / the request was
	 *  rejected. This is the user-gesture path (the title "Connect Wallet" button). */
	async connect(): Promise<Address | null> {
		const eth = this.injected();
		if (!eth) {
			this.onAccountsChanged?.(null);
			return null;
		}
		this.ethProvider = eth;
		this.bindListeners(eth);
		const accounts = (await eth.request({ method: "eth_requestAccounts" })) as string[] | undefined;
		const addr = accounts?.[0] as Address | undefined;
		if (!addr) return null;
		void this.ensureChain();
		this.setAccount(addr);
		return addr;
	}

	/** Silent restore: reuse an already-granted connection (eth_accounts never
	 *  prompts) so a returning player is signed back in without a popup. Returns
	 *  null when nothing is pre-approved (never throws). */
	async restore(): Promise<Address | null> {
		const eth = this.injected();
		if (!eth) return null;
		try {
			const accounts = (await eth.request({ method: "eth_accounts" })) as string[] | undefined;
			const addr = accounts?.[0] as Address | undefined;
			if (!addr) return null;
			this.ethProvider = eth;
			this.bindListeners(eth);
			this.setAccount(addr);
			return addr;
		} catch {
			return null;
		}
	}

	/** No wallet account: clear the signer and notify once. (An injected provider
	 *  can't be force-disconnected; we just drop our reference to the account.) */
	detach(): void {
		const had = this.account !== null;
		this.account = null;
		this.address = null;
		if (had) this.onAccountsChanged?.(null);
	}

	get isConfigured(): boolean {
		return this.configured;
	}

	/** Both the ship token and the auction house must be set to trade player->player. */
	get isAuctionConfigured(): boolean {
		return Boolean(ADDR.shipNft && ADDR.auctionHouse);
	}

	/** The AllianceRegistry must be configured to form/join alliances. */
	get isAllianceConfigured(): boolean {
		return Boolean(ADDR.allianceRegistry);
	}

	disconnect(): void {
		this.detach();
	}

	/** Drop the provider reference + listeners (called on engine dispose). */
	dispose(): void {
		const eth = this.ethProvider;
		if (eth?.removeListener && this.listening) {
			eth.removeListener("accountsChanged", this.handleAccountsChanged as (...args: never[]) => void);
			eth.removeListener("chainChanged", this.handleChainChanged as (...args: never[]) => void);
			this.listening = false;
		}
		this.ethProvider = null;
		this.onAccountsChanged = null;
	}

	/** The injected provider, or a thrown "no wallet" for a write attempt made
	 *  before a wallet was connected. */
	private requireProvider(): Eip1193Provider {
		if (!this.ethProvider) throw new Error("No injected wallet (install MetaMask/Rabby and connect)");
		return this.ethProvider;
	}

	/** Live USDG balance (base units) of the connected account. */
	async usdgBalanceOf(account: Address): Promise<bigint> {
		return this.publicClient.readContract({
			address: ADDR.usdg,
			abi: MockUSDGAbi,
			functionName: "balanceOf",
			args: [account],
		});
	}

	/** How many ship NFTs the connected account owns on-chain. This is the
	 *  entitlement the buy-to-play gate checks: zero means "no hull, go to the
	 *  merchant". Returns 0 if no wallet/ship-NFT is configured (never throws, so
	 *  the menu can poll it safely). */
	async ownedShipCount(): Promise<number> {
		if (!this.account || !ADDR.shipNft) return 0;
		try {
			const bal: bigint = await this.publicClient.readContract({
				address: ADDR.shipNft,
				abi: ShipNFTAbi,
				functionName: "balanceOf",
				args: [this.account],
			});
			return Number(bal);
		} catch {
			return 0;
		}
	}

	/** Escrow a USDG bounty against `tokenId`. Approves the escrow for the amount
	 *  first (only when needed), posts the bounty, and reads the authoritative
	 *  bountyId back from the emitted BountyPosted log.
	 */
	async postBounty(tokenId: bigint, usdgWhole: string): Promise<BountyResult> {
		const from = this.requireAccount();
		const amount = parseUsdg(usdgWhole);
		const escrow = ADDR.bountyEscrow;
		await this.ensureAllowance(ADDR.usdg, escrow, amount, from);

		const walletClient = await createWalletClient({ chain, transport: custom(this.requireProvider() as never) });
		const hash = await walletClient.writeContract({
			account: from,
			chain,
			address: escrow,
			abi: BountyEscrowAbi,
			functionName: "postBounty",
			args: [tokenId, amount],
		});
		const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
		const evt = findEvent(receipt.logs, escrow, BountyEscrowAbi, "BountyPosted");
		if (!evt) throw new Error("BountyPosted log not found");
		return {
			bountyId: Number(evt.args.bountyId ?? 0),
			tokenId: (evt.args.tokenId ?? tokenId).toString(),
			amount: (evt.args.amount ?? amount).toString(),
			txHash: hash,
		};
	}

	/** Buy a hull from the buy-only NPC store; returns the minted tokenId. */
	async buyShip(shipClass: string): Promise<{ tokenId: bigint; txHash: Hex }> {
		const from = this.requireAccount();
		const store = ADDR.shipStore;
		const price: bigint = await this.publicClient.readContract({
			address: store,
			abi: ShipStoreAbi,
			functionName: "priceOf",
			args: [keccak256(toBytes(shipClass))],
		});
		await this.ensureAllowance(ADDR.usdg, store, price, from);
		const walletClient = await createWalletClient({ chain, transport: custom(this.requireProvider() as never) });
		const hash = await walletClient.writeContract({
			account: from,
			chain,
			address: store,
			abi: ShipStoreAbi,
			functionName: "buyShip",
			args: [shipClass],
		});
		const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
		const evt = findEvent(receipt.logs, store, ShipStoreAbi, "ShipPurchased");
		if (!evt) throw new Error("ShipPurchased log not found");
		return { tokenId: (evt.args.tokenId as bigint) ?? 0n, txHash: hash };
	}

	private requireAccount(): Address {
		if (!this.account) throw new Error("Wallet not connected");
		return this.account;
	}

	// ---- Auction house: the only player->player USDG path -------------------

	/** Read a live auction straight from the chain. */
	async auctionState(auctionId: bigint): Promise<AuctionState> {
		const a = (await this.publicClient.readContract({
			address: ADDR.auctionHouse,
			abi: AuctionHouseAbi,
			functionName: "auctions",
			args: [auctionId],
		})) as unknown as AuctionState;
		return a;
	}

	/** USDG credited to `account` and claimable via withdraw(). */
	async withdrawableOf(account: Address): Promise<bigint> {
		return this.publicClient.readContract({
			address: ADDR.auctionHouse,
			abi: AuctionHouseAbi,
			functionName: "withdrawable",
			args: [account],
		});
	}

	/** Deposit a hull we own into the auction house for `durationSec` seconds.
	 *  Approves the house to move that tokenId first, then reads the auctionId
	 *  back from the AuctionCreated log.
	 */
	async createShipAuction(tokenId: bigint, durationSec: number): Promise<{ auctionId: bigint; txHash: Hex }> {
		const from = this.requireAccount();
		const house = ADDR.auctionHouse;
		const nft = ADDR.shipNft;

		const owner: Address = await this.publicClient.readContract({
			address: nft,
			abi: ShipNFTAbi,
			functionName: "ownerOf",
			args: [tokenId],
		});
		if (owner.toLowerCase() !== from.toLowerCase()) throw new Error("You no longer own that hull");

		const approved: Address = await this.publicClient.readContract({
			address: nft,
			abi: ShipNFTAbi,
			functionName: "getApproved",
			args: [tokenId],
		});
		if (approved.toLowerCase() !== house.toLowerCase()) {
			const wc = await createWalletClient({ chain, transport: custom(this.requireProvider() as never) });
			const hash = await wc.writeContract({
				account: from,
				chain,
				address: nft,
				abi: ShipNFTAbi,
				functionName: "approve",
				args: [house, tokenId],
			});
			await this.publicClient.waitForTransactionReceipt({ hash });
		}

		const endsAt = BigInt(Math.floor(Date.now() / 1000) + durationSec);
		const wc = await createWalletClient({ chain, transport: custom(this.requireProvider() as never) });
		const hash = await wc.writeContract({
			account: from,
			chain,
			address: house,
			abi: AuctionHouseAbi,
			functionName: "createAuction",
			args: [nft, tokenId, endsAt],
		});
		const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
		const evt = findEvent(receipt.logs, house, AuctionHouseAbi, "AuctionCreated");
		if (!evt) throw new Error("AuctionCreated log not found");
		return { auctionId: (evt.args.auctionId as bigint) ?? 0n, txHash: hash };
	}

	/** Bid `usdgWhole` on `auctionId` (approving the house for that amount first). */
	async placeBid(auctionId: bigint, usdgWhole: string): Promise<{ txHash: Hex }> {
		const from = this.requireAccount();
		const amount = parseUsdg(usdgWhole);
		await this.ensureAllowance(ADDR.usdg, ADDR.auctionHouse, amount, from);
		const wc = await createWalletClient({ chain, transport: custom(this.requireProvider() as never) });
		const hash = await wc.writeContract({
			account: from,
			chain,
			address: ADDR.auctionHouse,
			abi: AuctionHouseAbi,
			functionName: "bid",
			args: [auctionId, amount],
		});
		await this.publicClient.waitForTransactionReceipt({ hash });
		return { txHash: hash };
	}

	/** Settle an ended auction (anyone may call; winner gets the hull, seller +
	 *  fee recipient get credited `withdrawable` balances).
	 */
	async settleAuction(auctionId: bigint): Promise<{ txHash: Hex }> {
		const from = this.requireAccount();
		const wc = await createWalletClient({ chain, transport: custom(this.requireProvider() as never) });
		const hash = await wc.writeContract({
			account: from,
			chain,
			address: ADDR.auctionHouse,
			abi: AuctionHouseAbi,
			functionName: "settle",
			args: [auctionId],
		});
		await this.publicClient.waitForTransactionReceipt({ hash });
		return { txHash: hash };
	}

	/** Claim all credited USDG (sale proceeds / outbid refunds). */
	async withdrawProceeds(): Promise<{ txHash: Hex; amount: bigint }> {
		const from = this.requireAccount();
		const amount = await this.withdrawableOf(from);
		if (amount === 0n) throw new Error("Nothing to withdraw");
		const wc = await createWalletClient({ chain, transport: custom(this.requireProvider() as never) });
		const hash = await wc.writeContract({
			account: from,
			chain,
			address: ADDR.auctionHouse,
			abi: AuctionHouseAbi,
			functionName: "withdraw",
			args: [],
		});
		await this.publicClient.waitForTransactionReceipt({ hash });
		return { txHash: hash, amount };
	}

	// ---- Alliance registry: the trustless backing for bounty exclusion -------
	//
	// Forming an alliance is the ONLY player-side piece; BountyEscrow resolves the
	// "exclude the declarer AND their whole alliance" rule LIVE on-chain at claim
	// time (it reads AllianceRegistry.allianceOf), so there is no server message to
	// send here — once members join, settlement exclusion just works.

	/** Which alliance (id) the connected account belongs to, or 0 if none. Reads
	 *  0 without throwing so the UI can poll it safely. */
	async myAlliance(): Promise<number> {
		if (!this.account || !ADDR.allianceRegistry) return 0;
		try {
			const id: bigint = await this.publicClient.readContract({
				address: ADDR.allianceRegistry,
				abi: AllianceRegistryAbi,
				functionName: "allianceOf",
				args: [this.account],
			});
			return Number(id);
		} catch {
			return 0;
		}
	}

	/** Head-count of an alliance (0 if none configured). Never throws. */
	async allianceSize(allianceId: number): Promise<number> {
		if (!ADDR.allianceRegistry || allianceId <= 0) return 0;
		try {
			const n: bigint = await this.publicClient.readContract({
				address: ADDR.allianceRegistry,
				abi: AllianceRegistryAbi,
				functionName: "memberCount",
				args: [BigInt(allianceId)],
			});
			return Number(n);
		} catch {
			return 0;
		}
	}

	/** Create a new alliance (becomes its leader); returns the new allianceId. */
	async createAlliance(): Promise<{ allianceId: number; txHash: Hex }> {
		const from = this.requireAccount();
		const wc = await createWalletClient({ chain, transport: custom(this.requireProvider() as never) });
		const hash = await wc.writeContract({
			account: from,
			chain,
			address: ADDR.allianceRegistry,
			abi: AllianceRegistryAbi,
			functionName: "createAlliance",
			args: [],
		});
		const receipt = await this.publicClient.waitForTransactionReceipt({ hash });
		const evt = findEvent(receipt.logs, ADDR.allianceRegistry, AllianceRegistryAbi, "AllianceCreated");
		if (!evt) throw new Error("AllianceCreated log not found");
		return { allianceId: Number(evt.args.allianceId ?? 0), txHash: hash };
	}

	/** Join an existing alliance by id. */
	async joinAlliance(allianceId: number): Promise<{ txHash: Hex }> {
		const from = this.requireAccount();
		const wc = await createWalletClient({ chain, transport: custom(this.requireProvider() as never) });
		const hash = await wc.writeContract({
			account: from,
			chain,
			address: ADDR.allianceRegistry,
			abi: AllianceRegistryAbi,
			functionName: "join",
			args: [BigInt(allianceId)],
		});
		await this.publicClient.waitForTransactionReceipt({ hash });
		return { txHash: hash };
	}

	/** Leave the alliance we currently belong to. */
	async leaveAlliance(allianceId: number): Promise<{ txHash: Hex }> {
		const from = this.requireAccount();
		const wc = await createWalletClient({ chain, transport: custom(this.requireProvider() as never) });
		const hash = await wc.writeContract({
			account: from,
			chain,
			address: ADDR.allianceRegistry,
			abi: AllianceRegistryAbi,
			functionName: "leave",
			args: [BigInt(allianceId)],
		});
		await this.publicClient.waitForTransactionReceipt({ hash });
		return { txHash: hash };
	}

	private async ensureAllowance(token: Address, spender: Address, needed: bigint, owner: Address): Promise<void> {
		const allowance: bigint = await this.publicClient.readContract({
			address: token,
			abi: MockUSDGAbi,
			functionName: "allowance",
			args: [owner, spender],
		});
		if (allowance >= needed) return;
		const walletClient = await createWalletClient({ chain, transport: custom(this.requireProvider() as never) });
		const hash = await walletClient.writeContract({
			account: owner,
			chain,
			address: token,
			abi: MockUSDGAbi,
			functionName: "approve",
			args: [spender, needed],
		});
		await this.publicClient.waitForTransactionReceipt({ hash });
	}

	/** Best-effort chain assertion. An injected wallet may be on another network, and
	 *  a custom Orbit testnet may not be added to it — so we attempt the switch and
	 *  swallow any rejection rather than failing the read/write (the player can add
	 *  Robinhood Chain manually if a write lands on the wrong chain). */
	private async ensureChain(): Promise<void> {
		const eth = this.ethProvider;
		if (!eth) return;
		const idHex = `0x${chain.id.toString(16)}`;
		try {
			await eth.request({ method: "wallet_switchEthereumChain", params: [{ chainId: idHex }] });
		} catch {
			/* unsupported by the embedded provider — the dashboard chain config wins */
		}
	}
}

export { formatUsdg };
