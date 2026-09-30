// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Script, console} from "forge-std/Script.sol";
import {MockUSDG} from "../src/MockUSDG.sol";
import {ShipNFT} from "../src/ShipNFT.sol";
import {LootMint} from "../src/LootMint.sol";
import {AllianceRegistry} from "../src/AllianceRegistry.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";
import {AuctionHouse} from "../src/AuctionHouse.sol";
import {ShipStore} from "../src/ShipStore.sol";

/// @title Deploy
/// @notice Stand-up of the whole HighSeaz settlement layer on Robinhood Chain
///         (testnet) in one transaction batch, with every trust boundary wired:
///           - the game server is granted SERVER_ROLE so it is the ONLY party that
///             can mint/advance live state and settle bounties;
///           - the ShipStore is granted SERVER_ROLE on ShipNFT so it can issue the
///             hulls it sells (buy-only economy);
///           - all eight hull classes get a USDG price (6-decimal base units).
/// @dev Reads config from env so nothing sensitive is committed:
///        USDG_ADDRESS   (optional) live testnet USDG; if unset a MockUSDG is
///                       deployed and the server is funded for the demo.
///        SERVER_ADDRESS (optional) the authoritative server's hot wallet;
///                       defaults to the deployer for a local run.
///        FEE_RECIPIENT  (optional) auction fee wallet; defaults to the deployer.
///        REVENUE_WALLET (optional) ship-store proceeds wallet; defaults to deployer.
///      Run with `forge script script/Deploy.s.sol --rpc-url $RH_TESTNET_RPC_URL
///      --broadcast` (add --verify once the explorer keys are set).
contract Deploy is Script {
    /// @dev Robinhood Chain testnet id; the live RPC (rpc.testnet.chain.robinhood.com)
    ///      reports 46630 via eth_chainId. Mirrors shared-types RH_TESTNET.id.
    uint256 internal constant RH_CHAIN_ID = 46630;

    function run() external {
        address deployer = msg.sender;
        address server = vm.envOr("SERVER_ADDRESS", deployer);
        address feeRecipient = vm.envOr("FEE_RECIPIENT", deployer);
        address revenueWallet = vm.envOr("REVENUE_WALLET", deployer);
        address usdgAddress = vm.envOr("USDG_ADDRESS", address(0));

        vm.startBroadcast();

        MockUSDG usdg;
        if (usdgAddress == address(0)) {
            usdg = new MockUSDG();
            console.log("No USDG_ADDRESS set - deployed MockUSDG faucet");
        } else {
            usdg = MockUSDG(payable(usdgAddress));
            console.log("Using provided USDG at", usdgAddress);
        }

        ShipNFT ships = new ShipNFT();
        LootMint loot = new LootMint();
        AllianceRegistry alliances = new AllianceRegistry();
        BountyEscrow bounty = new BountyEscrow(usdg, alliances);
        AuctionHouse auction = new AuctionHouse(usdg, feeRecipient, 250); // 2.5%
        ShipStore store = new ShipStore(usdg, ships, revenueWallet);

        // --- wire the trust boundaries ---
        bytes32 SERVER = keccak256("SERVER_ROLE");
        ships.grantRole(SERVER, server);
        loot.grantRole(SERVER, server);
        bounty.grantRole(SERVER, server);
        // The store must be able to mint the hulls it sells.
        ships.grantRole(SERVER, address(store));

        // Price every hull class in USDG (6-decimal base units). Set deliberately
        // low "for now" so the buy-to-play loop is easy to demo/afford.
        store.setPrice("starter_sloop", 5e5);
        store.setPrice("raider_sloop", 1e6);
        store.setPrice("raider_brig", 2e6);
        store.setPrice("brigantine", 3e6);
        store.setPrice("merchant", 4e6);
        store.setPrice("galleon", 6e6);
        store.setPrice("war_galleon", 10e6);
        store.setPrice("imperial", 20e6);

        // Demo float so the server can showcase a live on-chain USDG bounty.
        if (usdgAddress == address(0)) {
            usdg.mint(server, 10_000e6);
        }

        vm.stopBroadcast();

        _emit(deployer, server, usdg, ships, loot, alliances, bounty, auction, store);
        _writeDeployments(usdg, ships, loot, alliances, bounty, auction, store);
    }

    function _emit(
        address deployer,
        address server,
        MockUSDG usdg,
        ShipNFT ships,
        LootMint loot,
        AllianceRegistry alliances,
        BountyEscrow bounty,
        AuctionHouse auction,
        ShipStore store
    )
        internal
        pure
    {
        console.log("=== HighSeaz settlement layer ===");
        console.log("deployer     ", deployer);
        console.log("server       ", server);
        console.log("USDG         ", address(usdg));
        console.log("ShipNFT      ", address(ships));
        console.log("LootMint     ", address(loot));
        console.log("AllianceReg  ", address(alliances));
        console.log("BountyEscrow ", address(bounty));
        console.log("AuctionHouse ", address(auction));
        console.log("ShipStore    ", address(store));
    }

    /// @dev Persist the deployed addresses so the server relayer and the browser
    ///      wallet point at this deployment (read into env / NEXT_PUBLIC_* vars).
    function _writeDeployments(
        MockUSDG usdg,
        ShipNFT ships,
        LootMint loot,
        AllianceRegistry alliances,
        BountyEscrow bounty,
        AuctionHouse auction,
        ShipStore store
    )
        internal
    {
        string memory j = string.concat(
            "{\n",
            '  "chainId": ',
            vm.toString(RH_CHAIN_ID),
            ",\n",
            '  "usdg": "',
            vm.toString(address(usdg)),
            '",\n',
            '  "shipNFT": "',
            vm.toString(address(ships)),
            '",\n',
            '  "lootMint": "',
            vm.toString(address(loot)),
            '",\n',
            '  "allianceRegistry": "',
            vm.toString(address(alliances)),
            '",\n',
            '  "bountyEscrow": "',
            vm.toString(address(bounty)),
            '",\n',
            '  "auctionHouse": "',
            vm.toString(address(auction)),
            '",\n',
            '  "shipStore": "',
            vm.toString(address(store)),
            '"\n}\n'
        );
        vm.createDir("../deployments", true);
        vm.writeFile("../deployments/addresses.json", j);
        console.log("wrote ../deployments/addresses.json");
    }
}
