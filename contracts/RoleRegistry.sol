// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "@openzeppelin/contracts/access/AccessControl.sol";

/// @title RoleRegistry
/// @notice Central RBAC registry shared by every other contract in the platform.
contract RoleRegistry is AccessControl {
    bytes32 public constant ADMIN_ROLE = keccak256("ADMIN_ROLE");
    bytes32 public constant MANAGER_ROLE = keccak256("MANAGER_ROLE");
    bytes32 public constant AUDITOR_ROLE = keccak256("AUDITOR_ROLE");
    bytes32 public constant USER_ROLE = keccak256("USER_ROLE");
    // Designated co-signers for the 2-of-N multi-sig approval flow on
    // high-risk actions (see ApprovalRegistry.sol). Deliberately separate
    // from ADMIN_ROLE: an address can hold ADMIN_ROLE for day-to-day admin
    // work without being one of the designated co-signers, and vice versa.
    bytes32 public constant CO_SIGNER_ROLE = keccak256("CO_SIGNER_ROLE");

    constructor(address rootAdmin) {
        _grantRole(DEFAULT_ADMIN_ROLE, rootAdmin);
        _grantRole(ADMIN_ROLE, rootAdmin);
    }

    function assignRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        grantRole(role, account);
    }

    function removeRole(bytes32 role, address account) external onlyRole(DEFAULT_ADMIN_ROLE) {
        revokeRole(role, account);
    }
}
