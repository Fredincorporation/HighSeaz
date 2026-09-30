// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {IERC721} from "@openzeppelin/contracts/token/ERC721/IERC721.sol";
import {ERC721Holder} from "@openzeppelin/contracts/token/ERC721/utils/ERC721Holder.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";

/// @title AuctionHouse
/// @notice The only player->player USDG path (the NPC merchant is buy-only, so
///         all real value flows through here). A seller lists an ERC-721 (ship or
///         loot); buyers bid in USDG; the highest bid wins on settle.
/// @dev Classic English auction hardened three ways:
///        - Withdrawal pattern: outbid funds are CREDITED, never pushed, so a
///          reverting recipient can't brick the auction and there is no external
///          call mid-bid to re-enter.
///        - Minimum 5% increment, so a bid must genuinely raise the stakes.
///        - Anti-snipe: a bid in the final window extends the deadline, so a
///          last-block sniper cannot steal a live auction.
contract AuctionHouse is ERC721Holder, ReentrancyGuard {
    using SafeERC20 for IERC20;

    IERC20 public immutable usdg;
    address public feeRecipient;
    uint256 public feeBps; // basis points of the winning price

    uint256 public constant MIN_INCREMENT_BPS = 500; // +5%
    uint256 public constant SNIP_WINDOW = 180; // seconds
    uint256 public constant SNIP_EXTEND = 180; // seconds

    struct Auction {
        IERC721 nft;
        uint256 tokenId;
        address seller;
        uint64 endsAt;
        address highestBidder;
        uint256 highestBid;
        bool settled;
        bool open;
    }

    uint256 public nextAuctionId = 1;
    mapping(uint256 => Auction) public auctions;
    /// @dev Credited balances claimable via withdraw() (outbid refunds + payouts).
    mapping(address => uint256) public withdrawable;

    event AuctionCreated(uint256 indexed auctionId, IERC721 indexed nft, uint256 indexed tokenId, address seller, uint64 endsAt);
    event AuctionBid(uint256 indexed auctionId, address indexed bidder, uint256 amount);
    event AuctionSettled(uint256 indexed auctionId, address indexed winner, uint256 amount);
    event AuctionReturned(uint256 indexed auctionId);
    event Withdrawn(address indexed account, uint256 amount);

    constructor(IERC20 usdg_, address feeRecipient_, uint256 feeBps_) {
        require(feeBps_ <= 1000, "Auction: fee too high"); // cap 10%
        usdg = usdg_;
        feeRecipient = feeRecipient_;
        feeBps = feeBps_;
    }

    /// @notice Seller deposits an NFT they own; bidding can then begin.
    function createAuction(IERC721 nft, uint256 tokenId, uint64 endsAt) external returns (uint256 auctionId) {
        require(block.timestamp < endsAt, "Auction: ended already");
        require(nft.ownerOf(tokenId) == msg.sender, "Auction: not owner");
        auctionId = nextAuctionId++;
        auctions[auctionId] = Auction({
            nft: nft,
            tokenId: tokenId,
            seller: msg.sender,
            endsAt: endsAt,
            highestBidder: address(0),
            highestBid: 0,
            settled: false,
            open: true
        });
        nft.safeTransferFrom(msg.sender, address(this), tokenId);
        emit AuctionCreated(auctionId, nft, tokenId, msg.sender, endsAt);
    }

    /// @notice Place a USDG bid at least MIN_INCREMENT above the current leader.
    ///         The caller must have approved this contract for `amount`.
    function bid(uint256 auctionId, uint256 amount) external nonReentrant {
        Auction storage a = auctions[auctionId];
        require(a.open && !a.settled, "Auction: closed");
        require(block.timestamp < a.endsAt, "Auction: ended");
        uint256 minNext = a.highestBid + (a.highestBid * MIN_INCREMENT_BPS) / 10_000;
        require(amount > a.highestBid && amount >= minNext, "Auction: bid too low");

        // Pull the NEW bid first (attacker-initiated, safe external call).
        usdg.safeTransferFrom(msg.sender, address(this), amount);

        // Credit the OUTBID bidder rather than pushing to them.
        if (a.highestBidder != address(0)) {
            withdrawable[a.highestBidder] += a.highestBid;
        }
        a.highestBidder = msg.sender;
        a.highestBid = amount;

        // Anti-snipe: extend if we're inside the closing window.
        if (a.endsAt - block.timestamp < SNIP_WINDOW) {
            a.endsAt = uint64(block.timestamp + SNIP_EXTEND);
        }
        emit AuctionBid(auctionId, msg.sender, amount);
    }

    /// @notice Anyone may settle once the auction has ended.
    function settle(uint256 auctionId) external nonReentrant {
        Auction storage a = auctions[auctionId];
        require(a.open && !a.settled, "Auction: closed");
        require(block.timestamp >= a.endsAt, "Auction: not ended");
        a.settled = true;
        a.open = false;

        if (a.highestBidder != address(0)) {
            uint256 fee = (a.highestBid * feeBps) / 10_000;
            withdrawable[a.seller] += a.highestBid - fee;
            withdrawable[feeRecipient] += fee;
            a.nft.safeTransferFrom(address(this), a.highestBidder, a.tokenId);
            emit AuctionSettled(auctionId, a.highestBidder, a.highestBid);
        } else {
            // No bids: give the item back to its seller.
            a.nft.safeTransferFrom(address(this), a.seller, a.tokenId);
            emit AuctionReturned(auctionId);
        }
    }

    /// @notice Claim credited funds (outbid refunds, sale proceeds, fees).
    function withdraw() external nonReentrant {
        uint256 amount = withdrawable[msg.sender];
        require(amount > 0, "Auction: nothing to withdraw");
        withdrawable[msg.sender] = 0;
        usdg.safeTransfer(msg.sender, amount);
        emit Withdrawn(msg.sender, amount);
    }
}
