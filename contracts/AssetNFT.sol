// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/token/ERC721/ERC721.sol";
import "./RoleRegistry.sol";
import "./IdentityRegistry.sol";

/// @title AssetNFT
/// @notice Each digital/physical asset is minted as an NFT tied to an active DID identity.
contract AssetNFT is ERC721 {
    RoleRegistry public roleRegistry;
    IdentityRegistry public identityRegistry;
    uint256 private _nextTokenId;

    mapping(uint256 => string) private _tokenURIs;

    struct TransferRecord {
        address from;
        address to;
        uint256 timestamp;
    }

    // Full provenance per token, kept separate from ERC721's own owner tracking
    // so auditors get a permanent, queryable ownership trail (mint counts as
    // a transfer from the zero address).
    mapping(uint256 => TransferRecord[]) private _history;

    event AssetMinted(uint256 indexed tokenId, address indexed owner, string uri);
    event AssetTransferred(uint256 indexed tokenId, address indexed from, address indexed to);

    modifier onlyManagerOrAdmin() {
        require(
            roleRegistry.hasRole(roleRegistry.ADMIN_ROLE(), msg.sender) ||
            roleRegistry.hasRole(roleRegistry.MANAGER_ROLE(), msg.sender),
            "Not authorized to mint"
        );
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

    constructor(address _roleRegistry, address _identityRegistry)
        ERC721("PlatformAsset", "PAST")
    {
        roleRegistry = RoleRegistry(_roleRegistry);
        identityRegistry = IdentityRegistry(_identityRegistry);
    }

    function mintAsset(address to, string calldata uri) external onlyManagerOrAdmin returns (uint256) {
        IdentityRegistry.Identity memory id = identityRegistry.getIdentity(to);
        require(id.active, "Recipient has no active identity");

        uint256 tokenId = _nextTokenId++;
        _safeMint(to, tokenId);
        _tokenURIs[tokenId] = uri;
        _history[tokenId].push(TransferRecord(address(0), to, block.timestamp));

        emit AssetMinted(tokenId, to, uri);
        return tokenId;
    }

    function tokenURI(uint256 tokenId) public view override returns (string memory) {
        _requireOwned(tokenId);
        return _tokenURIs[tokenId];
    }

    /// @notice Only a recognized platform user (USER_ROLE) who owns the token and
    /// is sending it to another active identity may transfer it. This is what makes
    /// RBAC apply to asset movement, not just minting.
    function transferAsset(address to, uint256 tokenId) external onlyUser {
        require(ownerOf(tokenId) == msg.sender, "Not the owner");
        IdentityRegistry.Identity memory id = identityRegistry.getIdentity(to);
        require(id.active, "Recipient has no active identity");

        _transfer(msg.sender, to, tokenId);
        _history[tokenId].push(TransferRecord(msg.sender, to, block.timestamp));
        emit AssetTransferred(tokenId, msg.sender, to);
    }

    /// @notice Auditor/Admin-only full provenance trail for a token: every mint and
    /// transfer it has ever been through, in order.
    function getTransferHistory(uint256 tokenId)
        external
        view
        onlyAuditorOrAdmin
        returns (TransferRecord[] memory)
    {
        return _history[tokenId];
    }
}