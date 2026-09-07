const express = require("express");
const { resolveDID } = require("../did/didResolver");

const router = express.Router();

router.get("/:address", async (req, res) => {
  try {
    const identity = await resolveDID(req.params.address);
    res.json(identity);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
