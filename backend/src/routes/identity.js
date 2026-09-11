const express = require("express");
const { ethers } = require("ethers");
const { resolveDID } = require("../did/didResolver");
const { requireRole } = require("../auth/apiAuth");

const router = express.Router();

const IDENTITY_ABI = [
  "function getComplianceRecord(address account) view returns (tuple(uint256 registeredAt,uint256 lastUpdatedAt,uint256 revokedAt,uint256 revocationCount))"
];

function getProvider() {
  return new ethers.JsonRpcProvider(process.env.RPC_URL);
}

// Two separate gates stack on the route below: requireRole() (see
// ../auth/apiAuth.js) checks that the actual HTTP CALLER controls an
// address holding AUDITOR_ROLE/ADMIN_ROLE, via a signature they produce
// with their own wallet. Independently, getComplianceRecord() is ALSO
// gated on-chain by onlyAuditorOrAdmin - a plain read-only provider
// resolves msg.sender to the zero address and reverts, so fetching the
// data itself still needs a real signer holding one of those roles. That
// signer is the backend's own configured key, same as before - it isn't
// what authenticates the caller (requireRole() is), it's just how the
// backend is allowed to read this particular on-chain data at all.
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
// revocation history. Caller-authenticated by requireRole() (see the note
// above getPrivilegedContract()).
router.get("/:address/compliance", requireRole("AUDITOR", "ADMIN"), async (req, res) => {
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
