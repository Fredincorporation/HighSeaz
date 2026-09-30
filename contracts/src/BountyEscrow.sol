// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {AllianceRegistry} from "./AllianceRegistry.sol";

/// @title BountyEscrow
/// @notice A player escrows USDG against a SPECIFIC ship tokenId; whoever sinks
///         that exact ship claims the pot. Claimants are excluded if they are the
///         declarer OR in the declarer's alliance (anti alt-ring laundering) —
///         checked trustlessly against the on-chain AllianceRegistry. Bounty
///         chains: a fresh claim can immediately target the previous winner.
/// @dev The server alone settles claims (SERVER_ROLE): it is the only party that
///      can authoritatively confirm "ship X was sunk by ship Y". Every value
///      transfer follows checks-effects-interactions under a reentrancy guard.
contract BountyEscrow is AccessControl, ReentrancyGuard, Pausable {
    using SafeERC20 for IERC20;

    bytes32 public constant SERVER_ROLE = keccak256("SERVER_ROLE");

    IERC20 public immutable usdg;
    AllianceRegistry public immutable alliances;

    struct Bounty {
        uint256 tokenId; // target ship
        address declarer;
        uint256 amount;
        bool claimed;
        bool active;
    }

    uint256 public nextBountyId = 1;
    mapping(uint256 => Bounty) public bounties;

    event BountyPosted(uint256 indexed bountyId, uint256 indexed tokenId, address indexed declarer, uint256 amount);
    event BountyClaimed(uint256 indexed bountyId, uint256 indexed tokenId, address indexed claimant, uint256 amount);
    event BountyCancelled(uint256 indexed bountyId, address indexed declarer, uint256 amount);

    constructor(IERC20 usdg_, AllianceRegistry alliances_) {
        usdg = usdg_;
        alliances = alliances_;
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(SERVER_ROLE, msg.sender);
    }

    /// @notice Lock `amount` (raw USDG units) against `tokenId`. The caller must
    ///         have approved this contract for at least `amount`.
    function postBounty(uint256 tokenId, uint256 amount) external whenNotPaused returns (uint256 bountyId) {
        require(amount > 0, "Bounty: zero");
        bountyId = nextBountyId++;
        bounties[bountyId] = Bounty({
            tokenId: tokenId,
            declarer: msg.sender,
            amount: amount,
            claimed: false,
            active: true
        });
        // CEI: state recorded before the external token pull.
        usdg.safeTransferFrom(msg.sender, address(this), amount);
        emit BountyPosted(bountyId, tokenId, msg.sender, amount);
    }

    /// @notice True if `claimant` is barred from claiming this bounty. Exclusion
    ///         is checked LIVE against the declarer's *current* alliance, not a
    ///         snapshot at escrow time: otherwise a ring could post a bounty with
    ///         no alliance, then have the intended winner join to farm the pot.
    function isExcluded(uint256 bountyId, address claimant) public view returns (bool) {
        Bounty storage b = bounties[bountyId];
        if (claimant == b.declarer) return true;
        uint256 declarerAlliance = alliances.allianceOf(b.declarer);
        if (declarerAlliance != 0 && alliances.isMember(declarerAlliance, claimant)) return true;
        return false;
    }

    /// @notice Server settles a bounty to the player who sank the target hull.
    function claim(uint256 bountyId, address claimant) external onlyRole(SERVER_ROLE) nonReentrant whenNotPaused {
        Bounty storage b = bounties[bountyId];
        require(b.active && !b.claimed, "Bounty: not claimable");
        require(claimant != address(0), "Bounty: zero claimant");
        require(!isExcluded(bountyId, claimant), "Bounty: claimant excluded");
        // Effects first: drain the pot exactly once (first sink wins).
        b.claimed = true;
        b.active = false;
        uint256 amount = b.amount;
        usdg.safeTransfer(claimant, amount);
        emit BountyClaimed(bountyId, b.tokenId, claimant, amount);
    }

    /// @notice Declarer withdraws an unclaimed bounty.
    function cancel(uint256 bountyId) external nonReentrant {
        Bounty storage b = bounties[bountyId];
        require(b.active && !b.claimed, "Bounty: not active");
        require(msg.sender == b.declarer, "Bounty: not declarer");
        b.active = false;
        uint256 amount = b.amount;
        usdg.safeTransfer(b.declarer, amount);
        emit BountyCancelled(bountyId, msg.sender, amount);
    }

    function pause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _pause();
    }

    function unpause() external onlyRole(DEFAULT_ADMIN_ROLE) {
        _unpause();
    }
}
