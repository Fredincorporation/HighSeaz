// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title LootMint
/// @notice Rare world-sourced loot (POI treasure, Kraken drops) is minted as an
///         ERC-721 to the finder, then tradeable via AuctionHouse. The game
///         never mints USDG — USDG is exogenous (Paxos stablecoin). Only the
///         server records an authoritative pickup.
contract LootMint is ERC721, AccessControl {
    bytes32 public constant SERVER_ROLE = keccak256("SERVER_ROLE");

    struct Loot {
        string kind; // e.g. "chest", "relic", "kraken_hoard"
        uint256 tier; // 1..5 rarity
        uint40 mintedAt;
    }

    uint256 public nextTokenId = 1;
    mapping(uint256 => Loot) public lootOf;

    event LootMinted(uint256 indexed tokenId, address indexed to, string kind, uint256 tier);

    constructor() ERC721("HighSeaz Loot", "HS-LOOT") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(SERVER_ROLE, msg.sender);
    }

    function mint(address to, string calldata kind, uint256 tier)
        external
        onlyRole(SERVER_ROLE)
        returns (uint256 tokenId)
    {
        require(tier >= 1 && tier <= 5, "LootMint: bad tier");
        tokenId = nextTokenId++;
        _safeMint(to, tokenId);
        lootOf[tokenId] = Loot({kind: kind, tier: tier, mintedAt: uint40(block.timestamp)});
        emit LootMinted(tokenId, to, kind, tier);
    }

    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
