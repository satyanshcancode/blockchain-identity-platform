// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./RoleRegistry.sol";
import "./ApprovalRegistry.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import "@openzeppelin/contracts/utils/Pausable.sol";

/// @title IdentityRegistry
/// @notice Anchors a DID + metadata pointer (IPFS) for each on-chain identity.
contract IdentityRegistry is EIP712, Pausable {
    RoleRegistry public roleRegistry;
    ApprovalRegistry public approvalRegistry;

    // EIP-712 typehash for the consent signature the account being registered
    // must produce off-chain (see scripts/signRegistration.js) so an admin can't
    // bind a DID to an address without that address's sign-off.
    bytes32 private constant REGISTER_IDENTITY_TYPEHASH =
        keccak256("RegisterIdentity(address account,string did,string metadataURI,uint256 nonce)");

    // Per-account nonce, bumped on every successful registration, so a captured
    // signature can't be replayed for a second (possibly different) registration.
    mapping(address => uint256) public nonces;

    struct Identity {
        string did;
        string metadataURI;
        bool active;
    }

    // Compliance-only fields, deliberately kept out of the public Identity struct
    // so ordinary reads (getIdentity) stay cheap and don't leak audit metadata.
    struct ComplianceRecord {
        uint256 registeredAt;
        uint256 lastUpdatedAt;
        uint256 revokedAt; // 0 if never revoked
        uint256 revocationCount;
    }

    mapping(address => Identity) private identities;
    mapping(address => ComplianceRecord) private complianceRecords;

    event IdentityRegistered(address indexed account, string did, string metadataURI);
    event IdentityRevoked(address indexed account);
    event IdentityMetadataUpdated(address indexed account, string newMetadataURI);
    // Deliberately named distinctly from AssetNFT's PlatformPaused/PlatformUnpaused -
    // this is a SEPARATE, independent circuit breaker (see the class-level note on
    // pause()/unpause() below), not the same pause state. Reusing AssetNFT's event
    // names here would make the audit log ambiguous about which one actually fired.
    event IdentityRegistryPaused(address indexed admin);
    event IdentityRegistryUnpaused(address indexed admin);

    modifier onlyAdmin() {
        require(roleRegistry.hasRole(roleRegistry.ADMIN_ROLE(), msg.sender), "Not admin");
        _;
    }

    modifier onlyAuditorOrAdmin() {
        require(
            roleRegistry.hasRole(roleRegistry.AUDITOR_ROLE(), msg.sender) ||
            roleRegistry.hasRole(roleRegistry.ADMIN_ROLE(), msg.sender),
            "Not auditor or admin"
        );
        _;
    }

    modifier onlyUser() {
        require(roleRegistry.hasRole(roleRegistry.USER_ROLE(), msg.sender), "Not a registered user");
        _;
    }

    modifier onlyCoSigner() {
        require(roleRegistry.hasRole(roleRegistry.CO_SIGNER_ROLE(), msg.sender), "Not a co-signer");
        _;
    }

    constructor(address _roleRegistry, address _approvalRegistry) EIP712("IdentityRegistry", "1") {
        roleRegistry = RoleRegistry(_roleRegistry);
        approvalRegistry = ApprovalRegistry(_approvalRegistry);
    }

    /// @notice Emergency circuit breaker for identity operations specifically -
    /// registerIdentity/revokeIdentity/approveRevokeIdentity/updateMetadata (see
    /// whenNotPaused below). Deliberately independent of AssetNFT's own pause:
    /// sharing one pause flag across both contracts would need either a runtime
    /// reference from this contract to AssetNFT's address (wired in a separate
    /// step after AssetNFT is deployed, since AssetNFT doesn't exist yet when this
    /// contract is constructed - a hard dependency that silently breaks every
    /// pause-gated function here if that wiring is ever skipped or wrong) or a
    /// third shared registry contract both would need to defer to. Two
    /// independent, self-contained switches - admin/frontend fires both together
    /// for a full platform freeze (see AdminAuditPanel.jsx) - were judged less
    /// risky than either kind of coupling.
    function pause() external onlyAdmin {
        _pause();
        emit IdentityRegistryPaused(msg.sender);
    }

    function unpause() external onlyAdmin {
        _unpause();
        emit IdentityRegistryUnpaused(msg.sender);
    }

    /// @notice Admin submits the registration, but it only succeeds if `account`
    /// itself signed an EIP-712 RegisterIdentity message consenting to this exact
    /// DID/metadataURI binding (see scripts/signRegistration.js). The nonce in the
    /// signed message must match nonces[account], preventing replay of an old
    /// signature after a re-registration.
    function registerIdentity(
        address account,
        string calldata did,
        string calldata metadataURI,
        bytes calldata signature
    ) external onlyAdmin whenNotPaused {
        // Cheap, authoritative floor against a blank identity - just a
        // calldata length check, no loop, so it costs nothing worth
        // measuring. Doesn't catch a whitespace-only DID (e.g. " ") -
        // that would need iterating every byte, real gas for what's a
        // data-hygiene concern rather than an on-chain invariant, so that
        // stricter check is left to the two client entry points instead
        // (IdentityCard.jsx's "Generate signature" form, where the DID is
        // actually chosen, and AdminAuditPanel.jsx's submission form).
        require(bytes(did).length > 0, "DID required");

        uint256 nonce = nonces[account];
        bytes32 structHash = keccak256(
            abi.encode(
                REGISTER_IDENTITY_TYPEHASH,
                account,
                keccak256(bytes(did)),
                keccak256(bytes(metadataURI)),
                nonce
            )
        );
        bytes32 digest = _hashTypedDataV4(structHash);
        address signer = ECDSA.recover(digest, signature);
        require(signer == account, "Invalid registration signature");

        nonces[account] = nonce + 1;

        identities[account] = Identity(did, metadataURI, true);
        complianceRecords[account].registeredAt = block.timestamp;
        complianceRecords[account].lastUpdatedAt = block.timestamp;
        emit IdentityRegistered(account, did, metadataURI);
    }

    /// @notice High-risk action, gated by 2-of-N multi-sig instead of plain
    /// onlyAdmin (see ApprovalRegistry.sol): this call only creates a pending
    /// proposal - it does NOT revoke anything yet. A second, different
    /// co-signer must call approveRevokeIdentity() with the returned proposal
    /// id for the revocation to actually take effect.
    function revokeIdentity(address account) external onlyCoSigner whenNotPaused returns (uint256 proposalId) {
        require(identities[account].active, "Identity not active");
        return approvalRegistry.propose(msg.sender, ApprovalRegistry.ActionType.RevokeIdentity, abi.encode(account));
    }

    /// @notice Second co-signer's approval. Executes the revocation in the
    /// same transaction the moment this crosses ApprovalRegistry's
    /// REQUIRED_APPROVALS threshold - re-checks the identity is still active,
    /// since time may have passed since revokeIdentity() was first called.
    function approveRevokeIdentity(uint256 proposalId) external onlyCoSigner whenNotPaused {
        (bool nowExecuted, bytes memory data) = approvalRegistry.approve(msg.sender, proposalId);
        if (!nowExecuted) return;

        address account = abi.decode(data, (address));
        require(identities[account].active, "Identity not active");

        identities[account].active = false;
        complianceRecords[account].revokedAt = block.timestamp;
        complianceRecords[account].revocationCount += 1;
        emit IdentityRevoked(account);
    }

    /// @notice Self-sovereign update: the identity owner (not an admin) points their
    /// DID at new metadata (e.g. a new IPFS profile). Requires USER_ROLE, i.e. the
    /// account must actually be a recognized platform user, and the identity must
    /// still be active. Admin-controlled fields (did, active) are untouched.
    function updateMetadata(string calldata newMetadataURI) external onlyUser whenNotPaused {
        require(identities[msg.sender].active, "Identity not active");
        identities[msg.sender].metadataURI = newMetadataURI;
        complianceRecords[msg.sender].lastUpdatedAt = block.timestamp;
        emit IdentityMetadataUpdated(msg.sender, newMetadataURI);
    }

    function getIdentity(address account) external view returns (Identity memory) {
        return identities[account];
    }

    /// @notice Auditor/Admin-only compliance view: registration/revocation history
    /// that isn't exposed through the public getIdentity() read.
    function getComplianceRecord(address account)
        external
        view
        onlyAuditorOrAdmin
        returns (ComplianceRecord memory)
    {
        return complianceRecords[account];
    }
}