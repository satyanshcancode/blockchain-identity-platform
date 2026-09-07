# Build roadmap

## Phase 0 — Environment setup
- [ ] Install Node.js 18+, npm, Git
- [ ] Install Hardhat (`npm install --save-dev hardhat`) inside the project root
- [ ] Install MetaMask browser extension, create a test wallet
- [ ] Get free testnet RPC + faucet funds (e.g. Polygon Amoy, or run a local Hardhat node — no faucet needed for local dev)
- [ ] Create an IPFS account (web3.storage / Pinata) for NFT metadata later

## Phase 1 — Smart contracts (core of the system)
- [ ] Implement `RoleRegistry.sol` (Admin, Manager, Auditor, User roles)
- [ ] Implement `IdentityRegistry.sol` (register/revoke DID-linked identities)
- [ ] Implement `AssetNFT.sol` (mint/transfer NFTs, gated by role + active identity)
- [ ] Write unit tests for every function and every role restriction (`test/platform.test.js`)
- [ ] Deploy and test locally with `npx hardhat node`

## Phase 2 — Backend services
- [ ] Build the Express API skeleton (`backend/src/index.js`)
- [ ] Build the event indexer that listens for `IdentityRegistered`, `AssetMinted`,
      `AssetTransferred` events and stores them for fast querying (`backend/src/indexer.js`)
- [ ] Build the DID resolver service that reads identity data from the contract
- [ ] Add IPFS upload endpoint for NFT metadata

## Phase 3 — Frontend DApp
- [ ] Wallet connect (MetaMask via ethers.js)
- [ ] Identity registration & view screen
- [ ] Admin dashboard: assign roles, mint/allocate NFTs
- [ ] Asset list + transfer screen
- [ ] Audit trail / activity log view (reads from backend indexer)

## Phase 4 — Integration & security
- [ ] End-to-end test: register identity → assign role → mint NFT → transfer → verify audit log
- [ ] Run static analysis on contracts (Slither / MythX)
- [ ] Add multi-sig requirement for critical admin actions
- [ ] Load test the indexer/API

## Phase 5 — Deployment
- [ ] Deploy contracts to a public testnet (Polygon Amoy) for demo purposes
- [ ] For production/enterprise use: deploy on a permissioned network (Hyperledger Besu / Fabric)
- [ ] Host backend + frontend (any cloud VM or platform of choice)

## Phase 6 — Documentation & demo prep
- [ ] Record a short demo video / prepare a live walkthrough
- [ ] Finalize architecture diagram and pitch deck
- [ ] Prepare answers for likely judge questions (why blockchain, why DID, scalability, cost)

---

## What to do right now
1. Extract this zip and open it in VS Code (or any editor).
2. Install Node.js 18+ if you don't have it.
3. `cd blockchain-identity-platform && npm install`
4. `npx hardhat compile` — confirms your toolchain works and the contracts compile.
5. `npx hardhat test` — confirms the sample tests pass.
Once these five steps work, you have a verified base to build on — move to Phase 1 checklist items you haven't finished, then Phase 2.
