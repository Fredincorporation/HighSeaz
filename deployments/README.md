# deployments/

`addresses.json` is written by the deploy script and is the single source of
truth for which settlement contracts a running server + client talk to.

## Flow

1. Deploy the settlement layer to Robinhood Chain testnet:

   ```bash
   cd contracts
   cp .env.example .env            # fill RH_TESTNET_RPC_URL + PRIVATE_KEY
   forge script script/Deploy.s.sol --rpc-url "$RH_TESTNET_RPC_URL" \
     --broadcast --verify
   ```

   This grants `SERVER_ROLE` (mint / status / bounty claims) to `SERVER_ADDRESS`,
   makes `ShipStore` a minter, prices all eight hulls, and writes
   `addresses.json` here. If `USDG_ADDRESS` is unset it deploys `MockUSDG` and
   funds the server so the bounty demo works out of the box.

2. Point the server relayer at it — copy the relevant fields into
   `server/.env` (`*_ADDRESS` + `SERVER_PRIVATE_KEY` + `RH_TESTNET_RPC_URL`).

3. Point the browser wallet at it — copy the public fields into `.env.local`
   (`NEXT_PUBLIC_*_ADDRESS` + `NEXT_PUBLIC_RH_RPC_URL`).

`addresses.json` currently holds anvil/simulate addresses from a `forge script`
run without a live `--broadcast`; replace it by broadcasting against the real
testnet. Do not hand-edit.

## What touches the chain (and what does not)

On-chain ONLY: ship mint/transfer, rare-loot mint, bounty escrow + claim,
auction settle, alliance membership. Everything else — movement, damage, health,
cargo, repairs, reputation, POIs — is off-chain server/DB state. Gameplay is
NEVER blocked on finality: sinks resolve in the 20Hz tick, and the relayer
settles the matching USDG bounty claim asynchronously.
