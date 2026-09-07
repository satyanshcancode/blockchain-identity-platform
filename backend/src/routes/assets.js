const express = require("express");
const { ethers } = require("ethers");
const { auditLog } = require("../indexer");

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
// pull the set of known tokenIds from the live event indexer (see ../indexer.js),
// which has been listening to AssetMinted/AssetTransferred since the backend started.
// Note: since that log is in-memory, a backend restart loses history for tokens minted
// before the restart until Phase-next adds persistent storage for the indexer.
function knownTokenIds() {
  const ids = new Set();
  for (const entry of auditLog) {
    if (entry.type === "AssetMinted" || entry.type === "AssetTransferred") {
      ids.add(entry.tokenId);
    }
  }
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

// GET /api/assets — every asset the indexer has seen, with live owner + metadata URI.
router.get("/", async (req, res) => {
  try {
    const contract = getReadContract();
    const ids = knownTokenIds();
    const assets = await Promise.all(
      ids.map(async (tokenId) => {
        const [owner, uri] = await Promise.all([
          contract.ownerOf(tokenId),
          contract.tokenURI(tokenId)
        ]);
        return { tokenId, owner, uri };
      })
    );
    res.json(assets);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/assets/owner/:address — assets currently held by a given address.
router.get("/owner/:address", async (req, res) => {
  try {
    const contract = getReadContract();
    const ids = knownTokenIds();
    const owned = [];
    for (const tokenId of ids) {
      const owner = await contract.ownerOf(tokenId);
      if (owner.toLowerCase() === req.params.address.toLowerCase()) {
        const uri = await contract.tokenURI(tokenId);
        owned.push({ tokenId, owner, uri });
      }
    }
    res.json(owned);
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