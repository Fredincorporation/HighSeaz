// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ShipNFT} from "./ShipNFT.sol";

/// @title ShipStore
/// @notice The NPC merchant: BUY-ONLY. Players spend USDG to mint a hull and can
///         never sell back here — every player->player sale goes through the
///         AuctionHouse. This is a primary USDG sink in the economy.
/// @dev Holds the SERVER_ROLE on ShipNFT (granted at deploy) so it can issue the
///      purchased hull in the same flow it takes payment. Purchase is
///      pull-payments + CEI under a reentrancy guard.
contract ShipStore is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant PRICING_ROLE = keccak256("PRICING_ROLE");

    IERC20 public immutable usdg;
    ShipNFT public immutable shipNft;
    address public revenueWallet;

    // keccak256(shipClass) -> price in raw USDG units.
    mapping(bytes32 => uint256) public priceOf;

    event PriceSet(bytes32 indexed classKey, string shipClass, uint256 price);
    event ShipPurchased(address indexed buyer, string shipClass, uint256 tokenId, uint256 price);

    constructor(IERC20 usdg_, ShipNFT shipNft_, address revenueWallet_) {
        usdg = usdg_;
        shipNft = shipNft_;
        revenueWallet = revenueWallet_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(PRICING_ROLE, msg.sender);
    }

    function setPrice(string calldata shipClass, uint256 price) external onlyRole(PRICING_ROLE) {
        priceOf[keccak256(bytes(shipClass))] = price;
        emit PriceSet(keccak256(bytes(shipClass)), shipClass, price);
    }

    function setRevenueWallet(address wallet) external onlyRole(DEFAULT_ADMIN_ROLE) {
        require(wallet != address(0), "Store: zero wallet");
        revenueWallet = wallet;
    }

    /// @notice Buy a hull. Caller must have approved at least the price. Emits the
    ///         freshly minted tokenId so the client can bind it to the in-world ship.
    function buyShip(string calldata shipClass) external nonReentrant whenNotPaused returns (uint256 tokenId) {
        uint256 price = priceOf[keccak256(bytes(shipClass))];
        require(price > 0, "Store: unpriced class");
        require(msg.sender != address(0), "Store: zero buyer");

        // Effects / interactions: pull payment, route to treasury, then mint.
        usdg.safeTransferFrom(msg.sender, revenueWallet, price);
        tokenId = shipNft.mint(msg.sender, shipClass);
        emit ShipPurchased(msg.sender, shipClass, tokenId, price);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
