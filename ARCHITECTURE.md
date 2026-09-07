# Architecture summary

Layers (top to bottom): User/Admin client -> Decentralized Identity (DID) -> RBAC access
control -> NFT asset management -> Blockchain ledger (immutable audit trail).
Smart contracts (RoleRegistry, IdentityRegistry, AssetNFT) enforce rules across the
identity, access-control, and asset layers - no action is valid unless the contract's
role check passes.

See the diagram shared earlier in the conversation for the visual version.
