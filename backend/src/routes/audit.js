const express = require("express");
const { getAllEvents, acknowledgeAnomaly, getAnomalyAcknowledgements } = require("../db");
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
//
// Every anomaly the detector currently computes is returned - acknowledged
// ones included, annotated rather than filtered out - so the frontend can
// implement "show reviewed" without a second endpoint or losing which ones
// were already acknowledged when nothing new has happened since.
router.get("/anomalies", requireRole("AUDITOR", "ADMIN"), (req, res) => {
  try {
    const acknowledgements = getAnomalyAcknowledgements();
    const anomalies = detectAnomalies(getAllEvents()).map((anomaly) => {
      const ack = acknowledgements.get(anomaly.id);
      return {
        ...anomaly,
        acknowledged: Boolean(ack),
        acknowledgedBy: ack ? ack.acknowledgedBy : null,
        acknowledgedAt: ack ? ack.acknowledgedAt : null
      };
    });
    res.json(anomalies);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/audit/anomalies/acknowledge — records that the caller (identity
// proven by requireRole()'s signature check, not a client-supplied field)
// has reviewed one specific anomaly. Body: { anomalyId }. This never
// deletes or alters the underlying event log - acknowledging is itself
// just another append to the persistent store, consistent with this being
// an audit system (hiding is fine, erasing isn't). The id is validated
// against a fresh computation rather than accepted blindly, so a typo'd or
// stale id can't silently create an orphaned acknowledgement row.
router.post("/anomalies/acknowledge", requireRole("AUDITOR", "ADMIN"), (req, res) => {
  const { anomalyId } = req.body || {};
  if (!anomalyId || typeof anomalyId !== "string") {
    return res.status(400).json({ error: "anomalyId is required." });
  }
  try {
    const currentIds = new Set(detectAnomalies(getAllEvents()).map((a) => a.id));
    if (!currentIds.has(anomalyId)) {
      return res.status(404).json({ error: "No currently-flagged anomaly matches that id." });
    }
    acknowledgeAnomaly(anomalyId, req.callerAddress, Date.now());
    res.json({ acknowledged: true, anomalyId, acknowledgedBy: req.callerAddress });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
