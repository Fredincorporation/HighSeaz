# HighSeaz — Confirmed Design Spec

All items below are user-confirmed decisions (as of 2026-09-25). Treat as settled; do not re-open scope unless the user raises it.

## Premise

- Persistent open-ocean multiplayer naval game, ships only. No land gameplay — the player NEVER leaves the boat. No building interiors.
- Islands/ports are landmarks + **proximity-triggered docking UI menu** (buy, repair, mint, bounty board appear as UI near a dock).
- Ship = the player's avatar. **No humanoid characters**: no player figure, no crew on player ships, no crew on NPC ships ("ghost-ship" feel).
- **Solo operation:** one player runs the whole ship (helm + aim + fire all guns). Not crew-co-op.

## Core loop = PvP predation (NOT NPC quests)

- Economic engine is hunting other players for their cargo. Rejected idea: NPC voyage/contract economy ("who pays them?").
- Free-floating world loot is fine: shipwrecks, floating crates, treasure-map x-marks (POIs) — these are world-sourced, no quest-giver.
- Loop: buy a ship (USDG) → sail → sink another player → take their cargo (incl. any USDG on that ship) → auction loot for USDG → buy repairs / a better ship → repeat.

## Sinking & persistence

- **Hull is NOT burned.** When sunk, the ship returns to the owner's inventory; **repair fully** (buy repair items, off-chain cost) to sail again.
- **Cargo is always lost on sink** — plain rule, applies to ANY ship (player-controlled or auto-mode/NPC-looking). Losing cargo is the real stake.
- If a player has no usable ship, they **buy another** with USDG (no free starter/dinghy needed).

## Fleets & auto mode

- A player can **own multiple ships ("fleet")** but **controls ONE at a time**.
- Other owned ships can be **dispatched on "auto mode"**: server-run AI ships that behave/appear as NPC ships to other players.
- Killer use-case: **auto trade routes** — send an auto-ship on a cargo run (passive income) that is genuinely at risk of being sunk en route.

## Alliances & identification

- **Alliance** = social link between friends (off-chain relationship graph is acceptable for membership display).
- On-chain **`AllianceRegistry`** is required ONLY because bounty claim-exclusion must be trustless (see bounties).
- Floating icon hovers over the ships of allied players. Ship identification tiers (client render layer):
  1. Your own ships (incl. your auto-mode ones) → distinct own-ship marker.
  2. Allied players' ships → alliance icon above ship.
  3. Everyone else → reads as an NPC.

## Bounties

- A player escrows **USDG against a specific ship tokenId**; whoever sinks **that exact ship** claims the pot.
- **Anti-exploit (locked):** claimants excluded = the declarer **AND everyone in the declarer's alliance** (kills alt-ring laundering). Hence on-chain AllianceRegistry.
- Bounty is individual, **not** pooled across a fleet. First to sink wins the whole pot.
- **Bounty chains (approved idea):** a claim can itself become a new bounty target → emergent escalating PvP economy. Pure BountyEscrow reuse, no extra server logic.

## Economy (USDG is exogenous real value)

- **USDG = Paxos USD stablecoin.** The game prints NOTHING and has no closed token loop to defend. Players connect a wallet and spend their OWN USDG. In-game earnings are real withdrawable dollars — that is the "why blockchain" answer.
- **Sinks (USDG out of player):** buy ships, buy repair items, buy marketplace goods, fund bounty escrow.
- **Sources (USDG to player):** sell loot/items on the player→player **auction**; claim bounties; rare POI loot minted then auctioned.
- **Marketplace is buy-only** from the NPC merchant: players **cannot sell items to the merchant**. Player→player value flows through the auction.
- Two layers: off-chain soft currency for routine bookkeeping where useful; **USDG + NFTs for real value** (ships, rare loot, bounties, auctions).

## Chain & gas

- **Deploy target = Robinhood Chain (testnet)** — Arbitrum Orbit L2; a buildathon prize is reserved for a Robinhood Chain build.
- **Gas paid in ETH** (not "Arb ETH" — just ETH). USDG is the value currency; ETH is only gas.
- Testnet product: faucet test USDG + test ETH for players/testers.

## Approved additional systems (user said "add them all", minus rejected NPC contracts)

- Weather as a gameplay factor (storms damage hull, currents drift, wind drives sailing) — reuse the VFX.
- Faction reputation (pirate/naval/merchant counters): attacking merchants spawns naval hunts; affects prices.
- Scattered POIs: shipwrecks, crates, treasure x-marks → world loot + discovery.
- On-chain ship provenance: each ShipNFT records kills / bounties-survived / sunk-and-repaired → a battle-hardened hull is worth more.
- Auto trade routes (passive income, at risk).
- Kraken world event (timed boss, legendary loot, players converge) — demo clip.
- Bounty chains (above).

## Explicitly out of scope for the 9-day demo

- Real server meshing (cross-region handoff) — architect for it, demo ONE bounded region.
- Boarding / on-foot / humanoids / interiors / crafting trees / guild-as-org / ambient sea life.
