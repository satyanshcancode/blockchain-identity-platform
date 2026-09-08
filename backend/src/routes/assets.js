const express = require("express");
const { ethers } = require("ethers");
const { getAllEvents } = require("../db");

const router = express.Router();

const ASSET_ABI = [
  "function ownerOf(uint256) view returns (address)",
  "function tokenURI(uint256) view returns (string)",
  "function getTransferHistory(uint256) view returns (tuple(address from,address to,uint256 timestamp)[])"
];

function getProvider() {
  return new ethers.JsonRpcProvider(process.env.RPC_URL);
}

// Public reads (ownerOf/tokenURI have no on-chain access restriction) — no signer needed.
function getReadContract() {
  return new ethers.Contract(process.env.ASSET_NFT_ADDRESS, ASSET_ABI, getProvider());
}

// getTransferHistory() is gated on-chain by onlyAuditorOrAdmin, which checks msg.sender.
// A plain JsonRpcProvider call resolves msg.sender to the zero address and will revert,
// so this needs a real signer whose address actually holds AUDITOR_ROLE or ADMIN_ROLE.
// In dev this is the Hardhat deployer key (see docker-compose.yml); in production this
// should be a dedicated service-account key with AUDITOR_ROLE only, not the root admin.
function getPrivilegedContract() {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY not configured on the backend — required for auditor-only reads");
  }
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, getProvider());
  return new ethers.Contract(process.env.ASSET_NFT_ADDRESS, ASSET_ABI, wallet);
}

// AssetNFT has no ERC721Enumerable extension, so there's no on-chain "give me every
// tokenId" call. Rather than re-scanning the whole chain's logs on every request, we
// pull the set of known tokenIds from the persistent event store (see ../db.js),
// which the indexer (../indexer.js) keeps up to date - including catching up on
// anything minted/transferred while the backend was down, so this stays complete
// across restarts.
function knownTokenIds() {
  const ids = new Set();
  for (const entry of getAllEvents()) {
    if (entry.type === "AssetMinted" || entry.type === "AssetTransferred") {
      ids.add(entry.tokenId);
    }
  }
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

// Resolves one tokenId to its live owner + metadata URI. Left to reject
// naturally (no try/catch here) - callers use Promise.allSettled so one
// bad tokenId can't take the whole request down; see resolveSettled below.
async function resolveAsset(contract, tokenId) {
  const [owner, uri] = await Promise.all([contract.ownerOf(tokenId), contract.tokenURI(tokenId)]);
  return { tokenId, owner, uri };
}

// The event log's known tokenIds are historical record, not a live
// guarantee the token still resolves on this chain - e.g. after a
// hardhat-node reset (no chain-state volume), old entries can reference a
// tokenId that never existed on the fresh chain. Promise.allSettled lets
// every other valid asset resolve normally instead of one bad/reverting
// tokenId taking the whole response down with a 500; a rejected entry is
// logged with its tokenId and reason (not silently dropped) and skipped.
async function resolveSettled(contract, ids, routeLabel) {
  const results = await Promise.allSettled(ids.map((tokenId) => resolveAsset(contract, tokenId)));
  const assets = [];
  results.forEach((result, i) => {
    if (result.status === "fulfilled") {
      assets.push(result.value);
    } else {
      console.warn(`${routeLabel}: skipping tokenId ${ids[i]} - on-chain read failed: ${result.reason.message}`);
    }
  });
  return assets;
}

// GET /api/assets — every asset the indexer has seen, with live owner + metadata URI.
router.get("/", async (req, res) => {
  try {
    const contract = getReadContract();
    const assets = await resolveSettled(contract, knownTokenIds(), "GET /api/assets");
    res.json(assets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assets/owner/:address — assets currently held by a given address.
router.get("/owner/:address", async (req, res) => {
  try {
    const contract = getReadContract();
    const assets = await resolveSettled(contract, knownTokenIds(), "GET /api/assets/owner/:address");
    res.json(assets.filter((a) => a.owner.toLowerCase() === req.params.address.toLowerCase()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assets/:tokenId/history — full mint+transfer provenance for one token.
// Auditor/Admin only, enforced on-chain by AssetNFT.getTransferHistory's modifier.
router.get("/:tokenId/history", async (req, res) => {
  try {
    const contract = getPrivilegedContract();
    const history = await contract.getTransferHistory(req.params.tokenId);
    res.json(
      history.map((h) => ({ from: h.from, to: h.to, timestamp: h.timestamp.toString() }))
    );
  } catch (err) {
    const status = /Not auditor or admin/.test(err.message) ? 403 : 500;
    res.status(status).json({ error: err.message });
  }
});

// GET /api/assets/:tokenId — single asset's current owner + metadata URI.
router.get("/:tokenId", async (req, res) => {
  try {
    const contract = getReadContract();
    const [owner, uri] = await Promise.all([
      contract.ownerOf(req.params.tokenId),
      contract.tokenURI(req.params.tokenId)
    ]);
    res.json({ tokenId: req.params.tokenId, owner, uri });
  } catch (err) {
    res.status(404).json({ error: "Asset not found" });
  }
});

module.exports = router;