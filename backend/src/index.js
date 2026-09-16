require("dotenv").config();
const express = require("express");
const { publicCors, privateCors, readOnlyOnly, PRIVATE_ORIGINS } = require("./config/cors");
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
  app.use(express.json());

  // CORS is applied per route group, not app-wide - see ./config/cors.js for
  // why. Short version: the public verification routes have to be readable by
  // a phone that loaded the app from this machine's LAN address, while the
  // role-gated routes stay pinned to an allowlist.
  //
  // assetRoutes is entirely public and entirely read-only (current owner,
  // metadata URI, transfer provenance), so the whole router mounts behind
  // publicCors + readOnlyOnly. identityRoutes is mixed - GET /:address is
  // public, GET /:address/compliance is auditor/admin-only - so it applies
  // the two policies per route internally instead.
  app.get("/health", publicCors, (req, res) => res.json({ status: "ok" }));
  app.use("/api/assets", publicCors, readOnlyOnly, assetRoutes);
  app.use("/api/identity", identityRoutes);
  app.use("/api/audit", privateCors, auditRoutes);
  app.use("/api/approvals", privateCors, approvalRoutes);

  const port = process.env.PORT || 4000;
  app.listen(port, () => {
    console.log(`API listening on port ${port}`);
    console.log(`Public read routes (/health, /api/assets/*, /api/identity/:address): any origin, read-only`);
    console.log(`Role-gated routes: origin allowlist ${PRIVATE_ORIGINS.join(", ")}`);
  });
}

main().catch((err) => {
  console.error("Fatal error starting backend:", err);
  process.exit(1);
});