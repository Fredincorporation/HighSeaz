// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Test} from "forge-std/Test.sol";
import {MockUSDG} from "../src/MockUSDG.sol";
import {ShipNFT} from "../src/ShipNFT.sol";
import {LootMint} from "../src/LootMint.sol";
import {AllianceRegistry} from "../src/AllianceRegistry.sol";
import {BountyEscrow} from "../src/BountyEscrow.sol";
import {AuctionHouse} from "../src/AuctionHouse.sol";
import {ShipStore} from "../src/ShipStore.sol";

/// @dev Covers the trustless invariants that carry real USDG: bounty exclusion +
///      first-sink-wins + server-only settlement, the auction's increment/refund/
///      settle/anti-snipe rules, and the buy-only store's payment+mint coupling.
contract HighSeazTest is Test {
    MockUSDG usdg;
    ShipNFT ships;
    LootMint loot;
    AllianceRegistry alliances;
    BountyEscrow bounty;
    AuctionHouse auction;
    ShipStore store;

    address server = makeAddr("server");
    address alice = makeAddr("alice"); // declarer / seller
    address bob = makeAddr("bob");     // hunter / buyer
    address carol = makeAddr("carol"); // alice's alliance mate
    address treasury = makeAddr("treasury");

    uint256 constant AMT = 100e6; // 100 USDG (6 decimals)

    function setUp() public {
        usdg = new MockUSDG();
        ships = new ShipNFT();
        loot = new LootMint();
        alliances = new AllianceRegistry();
        bounty = new BountyEscrow(usdg, alliances);
        auction = new AuctionHouse(usdg, treasury, 250); // 2.5% fee
        store = new ShipStore(usdg, ships, treasury);

        // Server can advance provenance / status / claims.
        ships.grantRole(ships.SERVER_ROLE(), server);
        loot.grantRole(loot.SERVER_ROLE(), server);
        bounty.grantRole(bounty.SERVER_ROLE(), server);
        // ShipStore must be able to mint the hulls it sells.
        ships.grantRole(ships.SERVER_ROLE(), address(store));

        usdg.mint(alice, 1000e6);
        usdg.mint(bob, 1000e6);
        usdg.mint(carol, 1000e6);
    }

    // ----------------------------------------------------------------- bounty

    function _post() internal returns (uint256 bountyId, uint256 tokenId) {
        tokenId = ships.mint(alice, "galleon");
        vm.startPrank(alice);
        usdg.approve(address(bounty), AMT);
        bountyId = bounty.postBounty(tokenId, AMT);
        vm.stopPrank();
    }

    function test_bounty_only_server_claims() public {
        (uint256 id, ) = _post();
        vm.prank(bob);
        vm.expectRevert();
        bounty.claim(id, bob);
    }

    function test_bounty_declarer_excluded() public {
        (uint256 id, ) = _post();
        assertTrue(bounty.isExcluded(id, alice));
        vm.prank(server);
        vm.expectRevert("Bounty: claimant excluded");
        bounty.claim(id, alice);
    }

    function test_bounty_alliance_member_excluded() public {
        (uint256 id, ) = _post();
        vm.prank(alice);
        uint256 a = alliances.createAlliance(); // alice leads + joins
        vm.prank(carol);
        alliances.join(a);
        assertTrue(bounty.isExcluded(id, carol));
        vm.prank(server);
        vm.expectRevert("Bounty: claimant excluded");
        bounty.claim(id, carol);
    }

    function test_bounty_first_sink_wins_and_drains() public {
        (uint256 id, ) = _post();
        vm.prank(server);
        bounty.claim(id, bob);
        assertEq(usdg.balanceOf(bob), 1000e6 + AMT);
        assertEq(usdg.balanceOf(address(bounty)), 0);
        // Cannot be claimed twice.
        vm.prank(server);
        vm.expectRevert("Bounty: not claimable");
        bounty.claim(id, carol);
    }

    function test_bounty_cancel_refunds_declarer() public {
        (uint256 id, ) = _post();
        uint256 afterPost = usdg.balanceOf(alice); // already drained by AMT
        vm.prank(alice);
        bounty.cancel(id);
        assertEq(usdg.balanceOf(alice), afterPost + AMT); // refunded
        vm.prank(server);
        vm.expectRevert("Bounty: not claimable");
        bounty.claim(id, bob);
    }

    function test_bounty_zero_amount_reverts() public {
        uint256 tokenId = ships.mint(alice, "galleon");
        vm.prank(alice);
        vm.expectRevert("Bounty: zero");
        bounty.postBounty(tokenId, 0);
    }

    // ---------------------------------------------------------------- auction

    function _list() internal returns (uint256 auctionId, uint256 tokenId) {
        tokenId = loot.mint(alice, "relic", 3);
        vm.startPrank(alice);
        loot.approve(address(auction), tokenId);
        auctionId = auction.createAuction(loot, tokenId, uint64(block.timestamp + 600));
        vm.stopPrank();
    }

    function test_auction_requires_owner_to_list() public {
        uint256 tokenId = loot.mint(alice, "relic", 3);
        vm.prank(bob);
        vm.expectRevert("Auction: not owner");
        auction.createAuction(loot, tokenId, uint64(block.timestamp + 600));
    }

    function test_auction_min_increment_enforced() public {
        (uint256 id, ) = _list();
        vm.startPrank(bob);
        usdg.approve(address(auction), type(uint256).max);
        auction.bid(id, 50e6);
        // Next must be >= 50e6 * 1.05 = 52.5e6.
        vm.expectRevert("Auction: bid too low");
        auction.bid(id, 51e6);
        auction.bid(id, 53e6);
        vm.stopPrank();
    }

    function test_auction_outbid_refund_is_credited() public {
        (uint256 id, ) = _list();
        address dave = makeAddr("dave");
        usdg.mint(dave, 1000e6);
        vm.prank(bob);
        usdg.approve(address(auction), 100e6);
        vm.prank(bob);
        auction.bid(id, 60e6);

        vm.startPrank(dave);
        usdg.approve(address(auction), 200e6);
        auction.bid(id, 63e6);
        vm.stopPrank();
        // Bob's 60e6 is now refundable rather than pushed.
        assertEq(auction.withdrawable(bob), 60e6);
    }

    function test_auction_settle_pays_seller_net_of_fee_and_ships_nft() public {
        (uint256 id, uint256 tokenId) = _list();
        vm.startPrank(bob);
        usdg.approve(address(auction), 200e6);
        auction.bid(id, 100e6);
        vm.stopPrank();

        vm.warp(block.timestamp + 601);
        auction.settle(id);
        assertEq(loot.ownerOf(tokenId), bob);
        uint256 fee = (100e6 * 250) / 10_000; // 2.5e6
        assertEq(auction.withdrawable(alice), 100e6 - fee);
        assertEq(auction.withdrawable(treasury), fee);
    }

    function test_auction_no_bids_returns_nft() public {
        (uint256 id, uint256 tokenId) = _list();
        vm.warp(block.timestamp + 601);
        auction.settle(id);
        assertEq(loot.ownerOf(tokenId), alice);
    }

    function test_auction_settle_before_end_reverts() public {
        (uint256 id, ) = _list();
        vm.warp(block.timestamp + 300);
        vm.expectRevert("Auction: not ended");
        auction.settle(id);
    }

    function test_auction_snipe_extends_deadline() public {
        (uint256 id, ) = _list();
        // Move to within the 180s snipe window (ends at +600).
        vm.warp(block.timestamp + 450);
        vm.startPrank(bob);
        usdg.approve(address(auction), 200e6);
        auction.bid(id, 100e6);
        vm.stopPrank();
        (, , , uint64 endsAt, , , , ) = auction.auctions(id);
        assertGt(endsAt, 600); // deadline pushed out past the original
        assertEq(endsAt, uint64(block.timestamp + 180)); // now + SNIP_EXTEND
    }

    function test_auction_withdraw_moves_funds() public {
        (uint256 id, ) = _list();
        address dave = makeAddr("dave");
        usdg.mint(dave, 1000e6);
        vm.prank(bob);
        usdg.approve(address(auction), 200e6);
        vm.prank(bob);
        auction.bid(id, 60e6);
        vm.startPrank(dave);
        usdg.approve(address(auction), 200e6);
        auction.bid(id, 63e6);
        vm.stopPrank();
        // Bob was outbid, so his 60e6 is credited to him; he pulls it back.
        uint256 before = usdg.balanceOf(bob);
        vm.prank(bob);
        auction.withdraw();
        assertEq(usdg.balanceOf(bob), before + 60e6);
    }

    // ------------------------------------------------------------------ store

    function test_store_buys_ship_pulls_usdg_and_mints() public {
        store.setPrice("galleon", 250e6);
        vm.startPrank(bob);
        usdg.approve(address(store), 250e6);
        uint256 tokenId = store.buyShip("galleon");
        vm.stopPrank();
        assertEq(ships.ownerOf(tokenId), bob);
        assertEq(usdg.balanceOf(treasury), 250e6);
        assertEq(usdg.balanceOf(address(store)), 0);
    }

    function test_store_unpriced_class_reverts() public {
        vm.prank(bob);
        vm.expectRevert("Store: unpriced class");
        store.buyShip("imperial");
    }

    function test_store_only_pricing_sets_price() public {
        vm.prank(bob);
        vm.expectRevert();
        store.setPrice("galleon", 1e6);
    }

    // -------------------------------------------------------------------- nft

    function test_shipnft_requires_server_to_mint() public {
        vm.prank(alice);
        vm.expectRevert();
        ships.mint(alice, "galleon");
    }

    function test_shipnft_status_never_burns_on_sink() public {
        uint256 tokenId = ships.mint(alice, "galleon");
        vm.prank(server);
        ships.setStatus(tokenId, ShipNFT.Status.SunkNeedsRepair);
        assertEq(ships.ownerOf(tokenId), alice); // hull persists, status only
        assertEq(uint256(ships.statusOf(tokenId)), uint256(ShipNFT.Status.SunkNeedsRepair));
    }

    function test_usdg_is_six_decimals() public view {
        assertEq(usdg.decimals(), 6);
    }
}
