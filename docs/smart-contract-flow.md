# Contract interaction flow

1. Deploy `RoleRegistry` - deployer becomes DEFAULT_ADMIN_ROLE + ADMIN_ROLE.
2. Deploy `IdentityRegistry`, passing the `RoleRegistry` address.
3. Deploy `AssetNFT`, passing both the `RoleRegistry` and `IdentityRegistry` addresses.
4. Admin calls `RoleRegistry.assignRole(MANAGER_ROLE, managerAddress)`.
5. The user being registered signs an EIP-712 `RegisterIdentity` message with
   their own wallet (`scripts/signRegistration.js`), consenting to the DID
   binding. Admin then calls
   `IdentityRegistry.registerIdentity(userAddress, did, metadataURI, signature)`,
   which reverts unless the signature recovers to `userAddress` and matches
   their current nonce.
6. Manager or Admin calls `AssetNFT.mintAsset(userAddress, tokenURI)` -
   this reverts if the recipient has no active identity.
7. Owner calls `AssetNFT.transferAsset(newOwner, tokenId)` -
   reverts if the new owner has no active identity.
8. Every step above emits an event; the backend indexer listens for these
   and builds the audit trail.
