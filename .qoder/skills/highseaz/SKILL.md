---
name: highseaz
description: Project context and conventions for HighSeaz, a multiplayer persistent-ocean 3D naval (ships-only) blockchain game built on Babylon.js + a Node authoritative server + Solidity contracts, targeting the Arbitrum Open House Singapore buildathon on Robinhood Chain. Use for ANY work in the HighSeaz repo — client/scene/ocean/ships, netcode/server, smart contracts (ships, bounties, alliances, auction, loot), wallet/USDG economy, docking UI, or pitch/architecture writing — so gameplay rules, the on-chain vs off-chain line, and stack choices stay consistent.
---

# HighSeaz

## Overview

Multiplayer, persistent open-ocean 3D naval game — Assassin's-Creed-BlackFlag feel but **ships only, never leave the boat**. Client-server (authoritative server, NOT P2P). Blockchain layer on **Robinhood Chain** (an Arbitrum Orbit L2). Submit by **2026-10-04**; demo must show a live on-chain USDG moment.

Read `references/design-spec.md` for confirmed gameplay/economy rules and `references/architecture.md` for repo layout, netcode conventions, contract interfaces, and the on-chain/off-chain line before non-trivial changes.

## Stack (already chosen — do not re-litigate)

- **Client:** Babylon.js v9 (`@babylonjs/core`,`/gui`,`/materials`,`/addons`), **Havok** physics, Next.js app (the repo is the Babylon.js Editor + Next template). Code-first game layer in `src/game/`; editor scene only hosts camera/lights/sky.
- **Ocean/weather:** procedural shader via `@babylonjs/materials` `Ocean`/`Water`/`Sky` + GLSL. NOT a giant mesh. Use the `shader-noise` / `shader-programming-glsl` skills for wave/foam/storm math.
- **Server:** standalone Node process (NOT Next API routes), authoritative tick ~20–30Hz, WebSocket (`ws`). Owns physics/combat/loot.
- **Contracts:** Solidity + **Foundry**. Use installed skills `setup-solidity-contracts` (OpenZeppelin), `solidity-security`, `property-based-testing` (Echidna/Medusa) when writing/auditing.
- **Wallet/value:** viem/wagmi + WalletConnect. **USDG** = Paxos USD stablecoin (real, exogenous — the game prints NOTHING). **Gas = ETH on Robinhood Chain**. Testnet product.
- **Assets:** user-generated; ships/models as GLB. Storage Cloudflare R2. No humanoid characters.

## The hard line: on-chain vs off-chain (state this in any pitch)

- **On-chain ONLY:** ship mint/transfer (ERC-721), rare loot mint, bounty escrow + claim, auction settle, alliance membership (needed trustless for bounty exclusion).
- **Off-chain (DB/Redis):** movement, position, damage, health, cargo counts, repairs, faction reputation, POIs, matchmaking/region, chat/alliance social graph.
- Never block gameplay on chain finality: game state is authoritative in the server/DB; the chain is a settlement layer written async via a relayer.

## Core gameplay facts (short — see references/design-spec.md)

- PvP predation loop: buy ship in USDG → sail → sink others → take their cargo → auction loot for USDG → buy repairs/ship. No NPC quest economy.
- Sunk ≠ burned: hull returns to inventory, repair to reuse; **cargo is always lost on sink** (any ship, NPC or player).
- Own many ships, control ONE at a time; others run **auto mode** and appear as NPC ships.
- Bounties: escrow USDG on a specific ship tokenId; first to sink claims; **declarer + declarer's alliance excluded** (anti alt-ring).
- No land, no crew/humanoids, solo ship operation. Docking = proximity UI menu.
- Approved systems: weather-as-gameplay, faction reputation, POIs/treasure, on-chain ship provenance, auto-trade routes, Kraken world event, bounty chains.

## Working norms

- Match the scope of risk to reversibility; run the Babylon app in the in-app browser (`browser-use`) to visually verify game feel after client changes — type-check passing is not "it works."
- Contracts move real money: default to checks-effects-interactions, reentrancy guards on USDG transfers, and property-based invariant tests for bounty/auction ordering.
- Keep client and server in sync via a single shared protocol-types module; never let message shapes drift.
- Update project memory (`~/.qoder/projects/.../memory/`) when a confirmed design decision changes.

## References

- `references/design-spec.md` — full confirmed gameplay, economy, fleets/alliances/bounties rules.
- `references/architecture.md` — repo/workspace layout, netcode model, contract interfaces, chain/USDG facts, demo scope + judging levers.
