// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {ERC721} from "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import {AccessControl} from "@openzeppelin/contracts/access/AccessControl.sol";

/// @title ShipNFT
/// @notice Each ship is an ERC-721. On-chain we store only what must be
///         trustless: ownership, coarse status, and battle provenance. All
///         realtime state (position, cargo counts, damage) lives off-chain.
/// @dev A SUNKEN hull is a STATUS, never a burn — the token persists and is
///      repaired off-chain, matching the design's "sunk != destroyed" rule.
///      Only the trusted game server (SERVER_ROLE) may mint or advance live
///      derived fields; ownership transfers are ordinary player-signed ERC-721
///      calls and are never gated.
contract ShipNFT is ERC721, AccessControl {
    bytes32 public constant SERVER_ROLE = keccak256("SERVER_ROLE");

    enum Status {
        Active,
        SunkNeedsRepair,
        OnAuto
    }

    struct Provenance {
        uint64 kills;
        uint64 bountiesSurvived;
        uint64 sunkAndRepaired;
        uint40 mintedAt;
    }

    uint256 public nextTokenId = 1;

    mapping(uint256 => Status) public statusOf;
    mapping(uint256 => Provenance) public provenanceOf;
    mapping(uint256 => string) public shipClassOf; // e.g. "war_galleon"

    event ShipMinted(uint256 indexed tokenId, address indexed to, string shipClass);
    event ProvenanceUpdated(uint256 indexed tokenId, uint64 kills, uint64 bountiesSurvived, uint64 sunkAndRepaired);
    event StatusChanged(uint256 indexed tokenId, Status status);

    constructor() ERC721("HighSeaz Ship", "HS-SHIP") {
        _grantRole(DEFAULT_ADMIN_ROLE, msg.sender);
        _grantRole(SERVER_ROLE, msg.sender);
    }

    /// @notice Server issues a hull to a buyer (invoked by ShipStore on purchase,
    ///         or directly for grants). Returns the new token id.
    function mint(address to, string calldata shipClass) external onlyRole(SERVER_ROLE) returns (uint256 tokenId) {
        tokenId = nextTokenId++;
        _safeMint(to, tokenId);
        shipClassOf[tokenId] = shipClass;
        statusOf[tokenId] = Status.Active;
        provenanceOf[tokenId].mintedAt = uint40(block.timestamp);
        emit ShipMinted(tokenId, to, shipClass);
    }

    function setStatus(uint256 tokenId, Status status) external onlyRole(SERVER_ROLE) {
        _requireMinted(tokenId);
        statusOf[tokenId] = status;
        emit StatusChanged(tokenId, status);
    }

    /// @notice Server records a kill / bounty survived / sunk-and-repaired. A
    ///         battle-hardened hull is worth more, so this is the on-chain
    ///         provenance the design calls for.
    function recordProvenance(
        uint256 tokenId,
        bool kill,
        bool bountySurvived,
        bool sunkAndRepaired
    ) external onlyRole(SERVER_ROLE) {
        _requireMinted(tokenId);
        Provenance storage p = provenanceOf[tokenId];
        if (kill) p.kills += 1;
        if (bountySurvived) p.bountiesSurvived += 1;
        if (sunkAndRepaired) p.sunkAndRepaired += 1;
        emit ProvenanceUpdated(tokenId, p.kills, p.bountiesSurvived, p.sunkAndRepaired);
    }

    function _requireMinted(uint256 tokenId) internal view {
        require(_ownerOf(tokenId) != address(0), "ShipNFT: unminted");
    }

    // ERC-721 transfers stay entirely player-signed; the server only mutates the
    // derived metadata above. Silence the AccessControl/ERC721 interface overlap.
    function supportsInterface(bytes4 interfaceId)
        public
        view
        override(ERC721, AccessControl)
        returns (bool)
    {
        return super.supportsInterface(interfaceId);
    }
}
