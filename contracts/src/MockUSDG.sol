// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title MockUSDG
/// @notice Testnet stand-in for the real Paxos USD stablecoin (USDG). The game
///         NEVER mints value as part of play — this mock exists only so testers
///         can faucet themselves balance and exercise the real USDG code paths
///         (approve -> transferFrom -> escrow / purchase / settlement). Swap the
///         deployed address for the live testnet USDG once known; nothing in the
///         game contracts assumes anything beyond a standard ERC-20 + 6 decimals.
/// @dev  USDG is 6-decimal (US style). Mints are faucet-gated behind MINTER_ROLE
///      so the deployer controls testnet distribution.
contract MockUSDG is ERC20, AccessControl {
    bytes32 public constant MINTER_ROLE = keccak256("MINTER_ROLE");

    uint8 private constant _DECIMALS = 6;

    constructor() ERC20("Mock USD", "USDG") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(MINTER_ROLE, msg.sender);
    }

    function decimals() public pure override returns (uint8) {
        return _DECIMALS;
    }

    /// @notice Faucet mint — testnet only. `amount` is raw 6-decimal base units,
    ///         matching the convention every game contract transfers in.
    function mint(address to, uint256 amount) external onlyRole(MINTER_ROLE) {
        _mint(to, amount);
    }
}
