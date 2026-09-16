# Blockchain-Based Identity, Access Control & Digital Asset Management Platform

**Smart India Hackathon 2026 — Problem Statement 26125**
Bharat Electronics Limited · Blockchain & Cybersecurity

A decentralised platform that unifies self-sovereign identity, on-chain role-based access control, and NFT-based asset ownership — with every permission enforced by smart contracts rather than application code, and every action permanently recorded.

---

## What this is

Organisations managing sensitive assets face two linked problems: identity and access control sit in centralised systems that create single points of failure, and asset ownership is tracked across disconnected records that are slow and unreliable to verify.

This platform addresses both in one system, and goes further than the baseline: it is built on the assumption that **the administrator may be the threat**.

- An administrator **cannot** register an identity without that person's own cryptographic consent
- The two most destructive actions — revoking an identity, reclaiming an asset — require **two independent co-signers**
- The entire platform can be **frozen in one action** when a breach is suspected
- The system **watches its own audit trail** and flags anomalous patterns
- Anyone can **verify an asset with no wallet, no account, and no app** — just a phone camera

---

## Core features

### Identity
- DID anchoring with **EIP-712 signed holder consent** — registration requires a signature from the account being registered, with per-account nonces preventing replay
- Self-service metadata updates by the identity holder
- Revocation immediately and mechanically blocks asset movement
- Auditor-only compliance records (registration, revocation history, revocation count)

### Access control
Five on-chain roles, each gating distinct capability:

| Role | Capability |
|---|---|
| **Admin** | Register identities, assign roles, pause the platform, propose revocations and reclaims |
| **Manager** | Mint asset records |
| **Auditor** | Read-only — full histories, compliance records, anomaly alerts. No write access. |
| **User** | Hold and transfer assets, update own metadata |
| **Co-Signer** | Jointly approve high-risk actions. Deliberately independent of Admin. |

### Assets
- ERC-721 tokens bound to **active** identities — minting to an unregistered address is rejected on-chain
- Full per-token provenance (mint, every transfer, any reclaim) with timestamps
- Constrained reclaim: only from a **revoked** holder, to an **active** one, and itself co-signed

### Security
- **2-of-N multi-signature** approval for revocation and reclaim, with execution-time re-validation against TOCTOU
- **Independent emergency pause** on both asset and identity operations, with honest reporting of partial states
- **Rule-based anomaly detection** over the audit log (rapid mint bursts, mint-then-immediate-transfer, admin action bursts, unapproved proposal backlogs) with reviewer acknowledgement recorded rather than alerts deleted
- **EIP-712 API authentication** — the backend verifies the *caller's* on-chain role per request, not just its own

### Reliability
- Self-healing event indexer: recovers from RPC disconnects, detects chain resets, backfills missed blocks automatically
- Crash-safe persistence (atomic temp-file + rename)
- Chain-generation fingerprinting — events from a superseded chain are never presented as current state
- Real block timestamps, so anomaly detection stays accurate after downtime replay

### Public verification
- Wallet-free verification page with scannable QR codes — no extension, no signature, no sign-in; renders fully with `window.ethereum` undefined
- Shows current owner, metadata, full custody history, and a prominent warning if the current holder's identity has been revoked
- Reads only the unauthenticated, strictly read-only REST routes; never touches the RPC endpoint, which a phone cannot reach either
- One `PUBLIC_HOST` variable controls the origin QR codes encode, so codes are scannable off-device (see [Quick start](#public-qr-verification--set-public_host))

---

## Architecture

```
┌─────────────────────────────────────────────────────────┐
│  Frontend — React + ethers.js + MetaMask                │
│  Wallet connect · Identity · Assets · Admin/Audit       │
│  Public verification page (no wallet required)          │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  Backend — Node.js + Express                            │
│  Self-healing indexer · Persistent audit store          │
│  Anomaly detector · Signature-authenticated REST API    │
└──────────────────────────┬──────────────────────────────┘
                           │
┌──────────────────────────▼──────────────────────────────┐
│  Smart contracts — Solidity on EVM                      │
│  RoleRegistry · IdentityRegistry · AssetNFT             │
│  ApprovalRegistry (multi-signature)                     │
└─────────────────────────────────────────────────────────┘
```

All access rules live in **Layer 1**. Compromising the backend does not grant the ability to mint, revoke, or reclaim — the chain would reject it.

---

## Quick start

**Prerequisites:** Docker Desktop (running), MetaMask browser extension, ~5 GB free disk space.

```bash
git clone <repository-url>
cd blockchain-identity-platform
cp .env.example .env     # then set PUBLIC_HOST — see below
docker compose up --build
```

First run takes a few minutes. When it settles, three services are running:

| Service | URL |
|---|---|
| Frontend | http://localhost:3000 |
| Backend API | http://localhost:4000 |
| Blockchain node | http://localhost:8545 |

### Public QR verification — set `PUBLIC_HOST`

Every asset gets a QR code that opens a wallet-free public verification page. For
another device to open it, the QR has to encode an address that device can
actually reach — so **one** variable in the root `.env` controls public
reachability:

```bash
PUBLIC_HOST=192.168.1.50    # this machine's LAN IP
```

`PUBLIC_HOST` feeds three things: the origin baked into every QR code, the API
base URL the browser fetches from, and the CORS allowlist for the role-gated
admin routes. Find your LAN IP with `ipconfig` (Windows, the Wi-Fi adapter's
IPv4 Address), `ipconfig getifaddr en0` (macOS), or `hostname -I` (Linux).

Leave it as `localhost` and everything still works on this machine, but QR codes
will be unscannable from a phone — `localhost` resolves to the scanning phone
itself. The Assets tab shows a warning banner when that is the case.

To demo it: open `http://<PUBLIC_HOST>:3000`, go to **Assets**, and scan any
row's QR code from a phone on the same Wi-Fi. The page needs no wallet, no
extension, and no sign-in. Ports `3000` and `4000` must both be reachable from
the phone (Docker publishes them on all interfaces; check your host firewall if
a scan times out).

> `REACT_APP_*` variables are inlined when the dev server boots, so changing
> `PUBLIC_HOST` needs a full `docker compose down && docker compose up -d` — a
> partial `--force-recreate frontend` will sit and wait for a fresh deploy that
> never comes, since `hardhat-node` did not restart.

### Connect MetaMask

Add a custom network:

| Field | Value |
|---|---|
| Network name | `Hardhat Local` |
| RPC URL | `http://127.0.0.1:8545` |
| Chain ID | `31337` |
| Currency symbol | `ETH` |

Then import test accounts. The `hardhat-node` logs print 20 accounts with private keys at startup — search the output for `Account #0`. Roles are assigned automatically at deployment:

| Account | Role |
|---|---|
| #0 | Admin + Co-Signer |
| #1, #2 | Co-Signer |
| #3 | Manager |
| #4 | Auditor |
| #5, #6 | User |

> These are Hardhat's publicly documented test keys. They hold no real value and must never be used on any real network.

---

## Testing

```bash
npx hardhat test
```

The contract test suite covers each access-control property individually — signature verification, replay protection, role gating, pause behaviour, multi-signature approval, self-approval rejection, and reclaim constraints.

```bash
npm --prefix frontend run check:verify-isolation
```

Asserts that the public verification page cannot reach wallet code: it walks
VerifyPage's full static import closure and fails if anything in it references
MetaMask, `BrowserProvider`, `ethers`, or the wallet context. A wallet-free
visitor scanning a QR code has to be able to render that page, and the
dependency that would break it is invisible at the call site — `VerifyPage`
importing the wrong service module pulls in the wallet three hops down.

For manual verification, see the testing guide in `docs/`.

---

## Project structure

```
contracts/          Solidity contracts
  RoleRegistry.sol        Role definitions and assignment
  IdentityRegistry.sol    DID anchoring, signed consent, pause
  AssetNFT.sol            ERC-721 assets, transfer rules, reclaim, pause
  ApprovalRegistry.sol    Multi-signature proposal tracking

backend/src/
  indexer.js              Self-healing blockchain event listener
  db.js                   Persistent audit storage
  anomalyDetector.js      Rule-based pattern detection
  routes/                 REST API endpoints
  config/                 Address loading, RPC readiness

frontend/src/
  components/             UI including the public verification page
  services/               Contract calls, API client, signature auth
  context/                Wallet connection and role state

scripts/            Deployment and utilities
test/               Contract test suite
```

---

## Useful commands

```bash
# Rebuild one service without resetting the blockchain
docker compose build backend
docker compose up -d --no-deps backend

# Follow logs
docker compose logs -f backend

# Stop everything
docker compose down
```

> Restarting `hardhat-node` resets the blockchain — it runs in memory. Identities and assets must be recreated. The audit store persists, but events from a previous chain are automatically excluded from current views.

---

## Known limitations

Stated openly rather than discovered later:

- **The oracle problem.** The system proves a *record* of custody changed, not that the *physical asset* moved. Custody claims are permanently attributable to a verified identity and cannot be altered afterwards, but binding record to reality is an organisational process, not something blockchain solves alone.
- **Prototype status.** Runs on a local test network. Production would require an independent security audit, enterprise key management in place of browser wallets, and API hardening for scale.
- **No automated backend/frontend tests.** Contract logic has automated coverage; backend and frontend are verified manually, apart from the verify-page isolation check under [Testing](#testing).
- **SPA routing depends on the dev server.** A direct hit on `/verify/<id>` returns `index.html` because the React dev server has history-API fallback enabled. A production `npm run build` served by a plain static file server would 404 on that path — the static server needs an explicit rewrite of unknown paths to `index.html`.
- **Governance dependency.** Multi-signature protection is only as strong as the genuine independence of the co-signers — not something software can enforce.

---

## Documentation

| Document | Purpose |
|---|---|
| Project Overview | Architecture, security model, use cases |
| Implementation Blueprint | How this would be deployed at BEL, with sourced research |
| Setup & Testing Guide | Full feature-by-feature verification |
| Tester Workbook | Step-by-step guide for non-technical testers |

---

## Technology

Solidity · Hardhat · OpenZeppelin · ethers.js v6 · Node.js · Express · React · Docker
