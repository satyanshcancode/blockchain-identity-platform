const express = require("express");
const { ethers } = require("ethers");
const { resolveDID } = require("../did/didResolver");

const router = express.Router();

const IDENTITY_ABI = [
  "function getComplianceRecord(address account) view returns (tuple(uint256 registeredAt,uint256 lastUpdatedAt,uint256 revokedAt,uint256 revocationCount))"
];

function getProvider() {
  return new ethers.JsonRpcProvider(process.env.RPC_URL);
}

// getComplianceRecord() is gated on-chain by onlyAuditorOrAdmin, same reasoning
// as assets.js's getPrivilegedContract(): a plain read-only provider resolves
// msg.sender to the zero address and reverts, so this needs a real signer
// holding AUDITOR_ROLE or ADMIN_ROLE.
function getPrivilegedContract() {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY not configured on the backend — required for auditor-only reads");
  }
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, getProvider());
  return new ethers.Contract(process.env.IDENTITY_REGISTRY_ADDRESS, IDENTITY_ABI, wallet);
}

router.get("/:address", async (req, res) => {
  try {
    const identity = await resolveDID(req.params.address);
    // resolveDID() returns ethers' raw Result (an Array subclass) for the
    // struct - JSON.stringify on that serializes as a positional array, not
    // {did, metadataURI, active}. Shape it into a plain object here so
    // consumers (the frontend) don't have to know that.
    res.json({ did: identity.did, metadataURI: identity.metadataURI, active: identity.active });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/identity/:address/compliance — Auditor/Admin-only registration/
// revocation history. Enforced on-chain by IdentityRegistry.getComplianceRecord's
// onlyAuditorOrAdmin modifier; mirrors assets.js's /:tokenId/history route.
router.get("/:address/compliance", async (req, res) => {
  try {
    const contract = getPrivilegedContract();
    const record = await contract.getComplianceRecord(req.params.address);
    res.json({
      registeredAt: record.registeredAt.toString(),
      lastUpdatedAt: record.lastUpdatedAt.toString(),
      revokedAt: record.revokedAt.toString(),
      revocationCount: record.revocationCount.toString()
    });
  } catch (err) {
    const status = /Not auditor or admin/.test(err.message) ? 403 : 500;
    res.status(status).json({ error: err.message });
  }
});

module.exports = router;
