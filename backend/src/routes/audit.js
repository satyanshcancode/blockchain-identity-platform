const express = require("express");
const { auditLog } = require("../indexer");
const router = express.Router();

router.get("/", (req, res) => {
  res.json(auditLog);
});

module.exports = router;
