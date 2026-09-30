# HighSeaz

A multiplayer, persistent open-ocean 3D naval game — ships only, you never leave the
boat. Client–server with an **authoritative Node game server** (not P2P), a browser
Babylon.js client, and a blockchain settlement layer on **Robinhood Chain** (an
Arbitrum Orbit L2) using real **USDG**.

## Stack

- **Client:** Babylon.js v9 (`@babylonjs/core` `/gui` `/materials` `/addons`) + Havok
  physics, inside a Next.js (App Router) app. The game layer is code-first in
  `src/game/`; the editor scene only hosts camera/lights/sky.
- **Server:** standalone Node process (`server/`), authoritative ~20 Hz tick over
  WebSocket (`ws`). Owns movement, combat, loot, economy.
- **Contracts:** Solidity + Foundry (`contracts/`), deployed to Robinhood Chain
  testnet (chainId **46630**).
- **Wallet / value:** viem + an injected browser wallet (MetaMask / Rabby) for
  on-chain signing; Supabase Web3 auth for the login session. Gas is ETH on Robinhood
  Chain; the stablecoin is USDG (exogenous — the game mints nothing).
- **Assets:** served from Cloudflare R2 (`public/` is the local fallback).

## The hard line: on-chain vs off-chain

- **On-chain ONLY:** ship mint/transfer (ERC-721), rare-loot mint, bounty escrow +
  claim, auction settle, alliance membership.
- **Off-chain (Supabase / server):** movement, position, damage, health, cargo,
  repairs, reputation, POIs, matchmaking, chat/social graph.
- Gameplay **never blocks on chain finality** — the server is authoritative and the
  chain is written asynchronously via a relayer.

## Repository layout

```
src/            Next.js app + Babylon game client
  app/          React shell (page.tsx, menu/, layout.tsx)
  game/         engine: ocean, weather, entities, net, combat, ui, wallet, core
  lib/          supabase.ts (Web3 auth + players registration)
server/         authoritative Node game server + on-chain relayer + Supabase persist
shared-types/   wire protocol + ABIs + on-chain constants (imported by both sides)
contracts/      Solidity + Foundry (src, test, script/Deploy.s.sol, scripts/gen-abis.mjs)
deployments/    addresses.json — the LIVE deployed addresses (never hand-edit)
public/         local asset tree (models, audio, textures…) — served from R2 in prod
scripts/        upload-to-r2.mjs
```

## Prerequisites

- Node 18+ and npm (workspaces).
- An injected EVM wallet (MetaMask or Rabby) with **Robinhood Chain testnet** added
  (chainId 46630, RPC `https://rpc.testnet.chain.robinhood.com`) for on-chain play.
- [Foundry](https://book.getfoundry.sh/) only if you edit/deploy contracts.
- A Supabase project (Auth → **Web3 Wallet** provider enabled; a `players` table with
  RLS for wallet registration / intro gating).

## Configuration

Copy the templates and fill them in. Only `NEXT_PUBLIC_*` reach the browser; secrets
live server-side only.

```
cp .env.example .env.local            # client (public values + Supabase URL/anon key)
cp server/.env.example server/.env    # server (relayer + Supabase service_role key)
cp contracts/.env.example contracts/.env   # only if deploying
```

- Client reads `NEXT_PUBLIC_*` **at dev-server start** — restart `:3000` after edits.
- `deployments/addresses.json` holds the live contract addresses; populate the client
  `NEXT_PUBLIC_*_ADDRESS` vars from it.
- The on-chain **relayer** stays a disabled no-op until `server/.env` has
  `SERVER_PRIVATE_KEY` + `USDG_ADDRESS` + `BOUNTY_ESCROW_ADDRESS`. Gameplay is fully
  playable without it.

## Running

```bash
npm install                 # root + workspaces (use --legacy-peer-deps if peers clash)

npm run dev                 # client  → http://localhost:3000
npm run dev:server          # server  → ws://localhost:9000 (authoritative tick)
```

Contracts (Foundry):

```bash
cd contracts
forge test                              # unit + invariant tests
node scripts/gen-abis.mjs               # regenerate shared-types/abis.ts after edits
forge script script/Deploy.s.sol --rpc-url <RH_RPC> --broadcast   # writes deployments/addresses.json
```

Assets → R2 (optional; falls back to `public/` locally):

```bash
npm run assets:upload       # needs R2_* creds in .env.local (CLI-only, not NEXT_PUBLIC)
```

## Deploying

- **Frontend (Next.js):** deploys cleanly to **Vercel** (or any Node/edge host). Set
  the `NEXT_PUBLIC_*` env vars there.
- **Game server:** **cannot** run on Vercel. It's a long-lived process with a ~20 Hz
  tick and persistent WebSocket connections — serverless/edge functions don't support
  that. Host it on a persistent-process service (Fly.io, Railway, Render, or a VPS)
  and point the client's `NEXT_PUBLIC_WS_URL` at its `wss://` URL.
- **Contracts** live on Robinhood Chain; **Supabase** and **Cloudflare R2** are
  external managed services.

So: Vercel hosts the web client, but the real-time server is a separate deployment.

## Security

- Never commit `.env*` (gitignored) or any private key. The server's `SERVER_PRIVATE_KEY`
  (the `SERVER_ROLE` signer) and the Supabase `service_role` key are server-only.
- Rotate any key that has ever been pasted into a chat or CI log before a public demo.
