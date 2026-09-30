// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title AllianceRegistry
/// @notice On-chain alliance membership so BountyEscrow's "exclude the declarer
///         AND everyone in the declarer's alliance" rule is trustless rather
///         than server-asserted. Membership is intentionally minimal: which
///         alliance an account belongs to, and who belongs to a given alliance.
/// @dev An account is in at most one alliance at a time. The leader may kick,
///      anyone may leave; leaving a leader's alliance that still has members
///      simply demotes (the alliance persists without a leader until one is
///      reasserted) — good enough for bounty exclusion, which only needs the
///      member set.
contract AllianceRegistry {
    uint256 public nextAllianceId = 1;

    struct Member {
        bool joined;
        uint64 joinedAt;
    }

    mapping(uint256 => mapping(address => Member)) private _members;
    mapping(uint256 => address) public leader;
    mapping(uint256 => uint256) public memberCount;
    // Reverse index so BountyEscrow can resolve a declarer's alliance in O(1).
    mapping(address => uint256) public allianceOf;

    event AllianceCreated(uint256 indexed allianceId, address indexed leader);
    event MemberJoined(uint256 indexed allianceId, address indexed account);
    event MemberLeft(uint256 indexed allianceId, address indexed account);
    event MemberKicked(uint256 indexed allianceId, address indexed account);

    modifier onlyMember(uint256 allianceId) {
        require(_members[allianceId][msg.sender].joined, "Alliance: not a member");
        _;
    }

    function createAlliance() external returns (uint256 allianceId) {
        require(allianceOf[msg.sender] == 0, "Alliance: already in one");
        allianceId = nextAllianceId++;
        leader[allianceId] = msg.sender;
        _members[allianceId][msg.sender] = Member(true, uint64(block.timestamp));
        allianceOf[msg.sender] = allianceId;
        memberCount[allianceId] = 1;
        emit AllianceCreated(allianceId, msg.sender);
    }

    function join(uint256 allianceId) external {
        require(leader[allianceId] != address(0) || memberCount[allianceId] > 0, "Alliance: nonexistent");
        require(allianceOf[msg.sender] == 0, "Alliance: already in one");
        _members[allianceId][msg.sender] = Member(true, uint64(block.timestamp));
        allianceOf[msg.sender] = allianceId;
        memberCount[allianceId] += 1;
        emit MemberJoined(allianceId, msg.sender);
    }

    function leave(uint256 allianceId) external onlyMember(allianceId) {
        _remove(allianceId, msg.sender);
        emit MemberLeft(allianceId, msg.sender);
    }

    /// @notice The leader may expel a member (keeps alt-rings manageable).
    function kick(uint256 allianceId, address account) external onlyMember(allianceId) {
        require(leader[allianceId] == msg.sender, "Alliance: not leader");
        require(account != msg.sender, "Alliance: cannot kick self");
        _remove(allianceId, account);
        emit MemberKicked(allianceId, account);
    }

    function _remove(uint256 allianceId, address account) internal {
        delete _members[allianceId][account];
        allianceOf[account] = 0;
        memberCount[allianceId] -= 1;
        if (leader[allianceId] == account) leader[allianceId] = address(0);
    }

    function isMember(uint256 allianceId, address account) external view returns (bool) {
        return _members[allianceId][account].joined;
    }
}
