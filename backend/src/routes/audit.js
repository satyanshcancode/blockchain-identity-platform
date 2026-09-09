const express = require("express");
const { ethers } = require("ethers");
const { getAllEvents } = require("../db");
const { detectAnomalies } = require("../anomalyDetector");

const router = express.Router();

const ROLE_REGISTRY_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function AUDITOR_ROLE() view returns (bytes32)",
  "function ADMIN_ROLE() view returns (bytes32)"
];

function getProvider() {
  return new ethers.JsonRpcProvider(process.env.RPC_URL);
}

// Anomaly detection is a pure backend computation over the event log, not a
// contract call, so unlike assets.js's /:tokenId/history (gated implicitly
// by AssetNFT's own onlyAuditorOrAdmin modifier reverting) there's no
// contract function to piggyback the gate on. This checks the same
// condition directly instead: the backend's own configured key (PRIVATE_KEY)
// must hold AUDITOR_ROLE or ADMIN_ROLE on RoleRegistry - same requirement,
// same key, same dev-only caveat as assets.js/identity.js's privileged reads.
async function backendHoldsAuditorOrAdmin() {
  if (!process.env.PRIVATE_KEY) {
    throw new Error("PRIVATE_KEY not configured on the backend — required for auditor-only reads");
  }
  const wallet = new ethers.Wallet(process.env.PRIVATE_KEY, getProvider());
  const roleRegistry = new ethers.Contract(process.env.ROLE_REGISTRY_ADDRESS, ROLE_REGISTRY_ABI, getProvider());
  const [auditorRole, adminRole] = await Promise.all([roleRegistry.AUDITOR_ROLE(), roleRegistry.ADMIN_ROLE()]);
  const [isAuditor, isAdmin] = await Promise.all([
    roleRegistry.hasRole(auditorRole, wallet.address),
    roleRegistry.hasRole(adminRole, wallet.address)
  ]);
  return isAuditor || isAdmin;
}

router.get("/", (req, res) => {
  res.json(getAllEvents());
});

// GET /api/audit/anomalies — Auditor/Admin only, mirroring the gating
// pattern of assets.js's /:tokenId/history and identity.js's
// /:address/compliance. Scans the full persisted event log with a fixed set
// of rule-based checks (see anomalyDetector.js) - not AI/ML.
router.get("/anomalies", async (req, res) => {
  try {
    if (!(await backendHoldsAuditorOrAdmin())) {
      return res.status(403).json({ error: "Not auditor or admin" });
    }
    res.json(detectAnomalies(getAllEvents()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
