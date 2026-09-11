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

// ethers.isAddress() rejects anything that isn't a well-formed 20-byte hex
// address up front, before it ever reaches an ethers Contract call below -
// otherwise a malformed address (wrong length, non-hex, empty, etc.) falls
// through to ethers' ENS-name resolution fallback, which tries to resolve it
// as a name and throws its own raw error, surfacing as an unfriendly 500
// that leaks ethers' internals instead of a clean "bad input" response.
function requireValidAddress(req, res) {
  if (!ethers.isAddress(req.params.address)) {
    res.status(400).json({ error: "Invalid address." });
    return false;
  }
  return true;
}

router.get("/:address", async (req, res) => {
  if (!requireValidAddress(req, res)) return;
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
  if (!requireValidAddress(req, res)) return;
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
