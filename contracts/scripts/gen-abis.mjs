// Regenerates shared-types/abis.ts from the Foundry build artifacts.
// Run after `forge build`:  node contracts/scripts/gen-abis.mjs
import { readFileSync, writeFileSync } from "node:fs";

const names = [
	"MockUSDG",
	"ShipNFT",
	"LootMint",
	"AllianceRegistry",
	"BountyEscrow",
	"AuctionHouse",
	"ShipStore",
];

let out =
	"// Auto-generated from Foundry artifacts (contracts/out). Do not edit by hand.\n" +
	"// Regenerate with: node contracts/scripts/gen-abis.mjs\n" +
	"/* eslint-disable */\n\n";

for (const n of names) {
	const abi = JSON.parse(readFileSync(`out/${n}.sol/${n}.json`, "utf8")).abi;
	out += `export const ${n}Abi = ${JSON.stringify(abi, null, 2)} as const;\n\n`;
}

writeFileSync("../shared-types/abis.ts", out);
console.log(`wrote shared-types/abis.ts (${out.length} bytes)`);
