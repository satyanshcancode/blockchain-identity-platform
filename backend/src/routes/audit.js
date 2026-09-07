const express = require("express");
const { getAllEvents } = require("../db");
const router = express.Router();

router.get("/", (req, res) => {
  res.json(getAllEvents());
});

module.exports = router;
