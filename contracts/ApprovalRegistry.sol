// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./RoleRegistry.sol";

/// @title ApprovalRegistry
/// @notice Generic 2-of-N multi-sig proposal ledger for a small allowlist of
/// trusted caller contracts (IdentityRegistry, AssetNFT). Deliberately does
/// NOT execute anything itself or hold arbitrary calldata - it only tracks
/// who proposed what and who has approved it. The calling contract decides
/// what "the action" actually means (revoke an identity, reclaim an asset),
/// stores/decodes the action-specific data itself, and performs the real
/// state change only when approve() reports the threshold was just crossed.
/// This keeps the execution surface to exactly the two known actions that
/// need it, instead of a general-purpose "call anything" executor.
contract ApprovalRegistry {
    RoleRegistry public roleRegistry;

    uint256 public constant REQUIRED_APPROVALS = 2;

    enum ActionType {
        RevokeIdentity,
        ReclaimAsset
    }

    struct Proposal {
        address targetContract;
        ActionType actionType;
        bytes data;
        address proposer;
        uint256 approvalCount;
        bool executed;
        uint256 proposedAt;
    }

    uint256 private _nextProposalId;
    mapping(uint256 => Proposal) private _proposals;
    mapping(uint256 => mapping(address => bool)) public hasApproved;

    // Contracts allowed to propose/approve through this registry - set by
    // admin once after IdentityRegistry/AssetNFT are deployed (see
    // scripts/deploy.js), not at construction, since this registry is
    // deployed before either of them exists.
    mapping(address => bool) public authorizedCallers;

    event CallerAuthorized(address indexed contractAddress, bool authorized);
    event ActionProposed(
        uint256 indexed proposalId,
        address indexed targetContract,
        ActionType actionType,
        address indexed proposer,
        bytes data
    );
    event ActionApproved(uint256 indexed proposalId, address indexed approver, uint256 approvalCount);
    event ActionExecuted(uint256 indexed proposalId);

    modifier onlyAdmin() {
        require(roleRegistry.hasRole(roleRegistry.ADMIN_ROLE(), msg.sender), "Not admin");
        _;
    }

    modifier onlyAuthorizedCaller() {
        require(authorizedCallers[msg.sender], "Not an authorized caller");
        _;
    }

    modifier onlyCoSigner(address account) {
        require(roleRegistry.hasRole(roleRegistry.CO_SIGNER_ROLE(), account), "Not a co-signer");
        _;
    }

    constructor(address _roleRegistry) {
        roleRegistry = RoleRegistry(_roleRegistry);
    }

    function setAuthorizedCaller(address contractAddress, bool authorized) external onlyAdmin {
        authorizedCallers[contractAddress] = authorized;
        emit CallerAuthorized(contractAddress, authorized);
    }

    /// @notice Called by IdentityRegistry/AssetNFT when a co-signer first calls
    /// revokeIdentity()/reclaimAsset(). Records the proposer as the first
    /// approval (see approve() - a proposer approving their own proposal again
    /// is rejected as a duplicate, not counted twice) and returns the new
    /// proposal's id for the caller to surface back to the proposer.
    function propose(address proposer, ActionType actionType, bytes calldata data)
        external
        onlyAuthorizedCaller
        onlyCoSigner(proposer)
        returns (uint256 proposalId)
    {
        proposalId = _nextProposalId++;
        Proposal storage p = _proposals[proposalId];
        p.targetContract = msg.sender;
        p.actionType = actionType;
        p.data = data;
        p.proposer = proposer;
        p.approvalCount = 1;
        p.proposedAt = block.timestamp;
        hasApproved[proposalId][proposer] = true;

        emit ActionProposed(proposalId, msg.sender, actionType, proposer, data);
        emit ActionApproved(proposalId, proposer, 1);
    }

    /// @notice Called by IdentityRegistry/AssetNFT when a co-signer calls
    /// approveRevokeIdentity()/approveReclaimAsset(). Reverts if `approver` has
    /// already approved this proposal - including the original proposer, whose
    /// propose() call already counted as their one approval, so this is also
    /// what stops "the same co-signer approving their own proposal twice."
    /// Returns (true, data) exactly once, the call that reaches
    /// REQUIRED_APPROVALS - the caller is expected to execute the real action
    /// immediately when it gets `true` back.
    function approve(address approver, uint256 proposalId)
        external
        onlyAuthorizedCaller
        onlyCoSigner(approver)
        returns (bool nowExecuted, bytes memory data)
    {
        Proposal storage p = _proposals[proposalId];
        require(p.targetContract == msg.sender, "Wrong contract for this proposal");
        require(!p.executed, "Already executed");
        require(!hasApproved[proposalId][approver], "Already approved");

        hasApproved[proposalId][approver] = true;
        p.approvalCount += 1;
        emit ActionApproved(proposalId, approver, p.approvalCount);

        if (p.approvalCount >= REQUIRED_APPROVALS) {
            p.executed = true;
            emit ActionExecuted(proposalId);
            return (true, p.data);
        }
        return (false, p.data);
    }

    function proposalCount() external view returns (uint256) {
        return _nextProposalId;
    }

    function getProposal(uint256 proposalId)
        external
        view
        returns (
            address targetContract,
            ActionType actionType,
            bytes memory data,
            address proposer,
            uint256 approvalCount,
            bool executed,
            uint256 proposedAt
        )
    {
        Proposal storage p = _proposals[proposalId];
        return (p.targetContract, p.actionType, p.data, p.proposer, p.approvalCount, p.executed, p.proposedAt);
    }
}
