// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./RoleRegistry.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";

/// @title IdentityRegistry
/// @notice Anchors a DID + metadata pointer (IPFS) for each on-chain identity.
contract IdentityRegistry is EIP712 {
    RoleRegistry public roleRegistry;

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

    constructor(address _roleRegistry) EIP712("IdentityRegistry", "1") {
        roleRegistry = RoleRegistry(_roleRegistry);
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
    ) external onlyAdmin {
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

    function revokeIdentity(address account) external onlyAdmin {
        identities[account].active = false;
        complianceRecords[account].revokedAt = block.timestamp;
        complianceRecords[account].revocationCount += 1;
        emit IdentityRevoked(account);
    }

    /// @notice Self-sovereign update: the identity owner (not an admin) points their
    /// DID at new metadata (e.g. a new IPFS profile). Requires USER_ROLE, i.e. the
    /// account must actually be a recognized platform user, and the identity must
    /// still be active. Admin-controlled fields (did, active) are untouched.
    function updateMetadata(string calldata newMetadataURI) external onlyUser {
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