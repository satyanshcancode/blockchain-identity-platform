# Blockchain-Based Secure Platform for Identity, Access Control & Digital Asset Management

A permissioned-blockchain platform combining Decentralized Identifiers (DID), Role-Based
Access Control (RBAC) enforced by smart contracts, and NFT-based digital asset ownership,
with a fully immutable on-chain audit trail.

## Folder structure

```
blockchain-identity-platform/
├── contracts/          Solidity smart contracts (RBAC, Identity, Asset NFT)
├── scripts/            Hardhat deployment scripts
├── test/               Contract unit tests
├── backend/            Node.js API + blockchain event indexer + DID resolver
├── frontend/           React DApp (identity, asset, role dashboards)
├── docs/               Architecture & workflow notes
├── hardhat.config.js   Hardhat network/config
└── package.json        Root (contracts) dependencies
```

## Prerequisites
- Node.js 18+
- npm or yarn
- MetaMask (for testnet interaction)
- An RPC endpoint (local Hardhat node, or a testnet like Polygon Amoy)

## Quick start (contracts)

```bash
npm install
npx hardhat compile
npx hardhat test
npx hardhat node                                       # terminal 1: local chain
npx hardhat run scripts/deploy.js --network localhost  # terminal 2: deploy
```

## Quick start (backend)

```bash
cd backend
npm install
cp .env.example .env     # fill in RPC_URL, PRIVATE_KEY, contract addresses
npm start
```

## Quick start (frontend)

```bash
cd frontend
npm install
npm start
```

See `docs/smart-contract-flow.md` for how the contracts interact.

## Run everything with Docker (no local Node.js/Hardhat install needed)

Requires only Docker + Docker Compose installed.

```bash
docker compose up --build
```

This starts three containers:
- `hardhat-node` — a local blockchain on `localhost:8545`, which auto-deploys
  `RoleRegistry`, `IdentityRegistry`, and `AssetNFT` on startup (check
  `docker compose logs hardhat-node` for the deployed addresses).
- `backend` — the API on `localhost:4000`.
- `frontend` — the React DApp on `localhost:3000`.

Point MetaMask at `http://localhost:8545` (chain ID `31337`) to interact with
the contracts directly from the browser.

To stop everything: `docker compose down`.
To rebuild after changing a contract: `docker compose up --build`.
