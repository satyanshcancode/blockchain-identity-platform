require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { loadDeployedAddresses } = require("./config/loadAddresses");
const { initDb } = require("./db");
const indexer = require("./indexer");

async function main() {
  // Contract addresses must be resolved before the indexer starts — it reads
  // process.env.IDENTITY_REGISTRY_ADDRESS / ASSET_NFT_ADDRESS. The events DB
  // must be open before indexer.start()'s catch-up scan writes to it, and
  // before routes (which read from it) start serving requests.
  await loadDeployedAddresses();
  await initDb();
  await indexer.start();

  const identityRoutes = require("./routes/identity");
  const assetRoutes = require("./routes/assets");
  const auditRoutes = require("./routes/audit");
  const approvalRoutes = require("./routes/approvals");

  const app = express();
  // Wide-open CORS meant any website could read this API's responses from
  // a visitor's browser. Restricted to the frontend's own origin - the
  // only legitimate caller, including VerifyPage (served from the same
  // origin regardless of which page within the app a visitor is on).
  app.use(cors({ origin: process.env.FRONTEND_ORIGIN || "http://localhost:3000" }));
  app.use(express.json());

  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.use("/api/identity", identityRoutes);
  app.use("/api/assets", assetRoutes);
  app.use("/api/audit", auditRoutes);
  app.use("/api/approvals", approvalRoutes);

  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`API listening on port ${port}`));
}

main().catch((err) => {
  console.error("Fatal error starting backend:", err);
  process.exit(1);
});