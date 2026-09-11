const express = require("express");
const { getAllEvents } = require("../db");
const { detectAnomalies } = require("../anomalyDetector");
const { requireRole } = require("../auth/apiAuth");

const router = express.Router();

// GET /api/audit — Auditor/Admin-only full event log. Caller-authenticated
// by requireRole() (see ../auth/apiAuth.js) - unlike assets.js/identity.js's
// on-chain-gated reads, this route has no contract call to piggyback an
// access check on (getAllEvents() is a local SQLite read), so requireRole()
// is the ONLY gate here, not a second layer alongside an on-chain one.
router.get("/", requireRole("AUDITOR", "ADMIN"), (req, res) => {
  res.json(getAllEvents());
});

// GET /api/audit/anomalies — Auditor/Admin only, same reasoning as above:
// anomaly detection is a pure computation over the persisted event log, not
// a contract call, so requireRole() is the whole gate. Scans the full
// event log with a fixed set of rule-based checks (see anomalyDetector.js)
// - not AI/ML.
router.get("/anomalies", requireRole("AUDITOR", "ADMIN"), (req, res) => {
  try {
    res.json(detectAnomalies(getAllEvents()));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
