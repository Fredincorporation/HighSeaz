/**
 * Testnet faucets surfaced from the title + pause menus. These open in a small
 * popup (window.open with explicit size), never the same tab — leaving the game
 * would drop the WebSocket session, so funding always opens beside it. The URLs
 * are fixed constants; `opener = null` stops the opened page reaching back.
 */
export const FAUCETS = [
	{ label: "Robinhood Chain ETH", note: "Testnet gas for signing on-chain buys.", url: "https://faucet.testnet.chain.robinhood.com/" },
	{ label: "USDG (Global Dollar)", note: "Testnet USDG to buy a hull or post a bounty.", url: "https://faucet.paxos.com/" },
] as const;

export function openFaucetPopup(url: string): void {
	const w = window.open(url, "_blank", "popup=yes,width=920,height=780,scrollbars=yes,resizable=yes");
	if (w) w.opener = null;
}
