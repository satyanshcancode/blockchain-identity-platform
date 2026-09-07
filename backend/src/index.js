require("dotenv").config();
const express = require("express");
const cors = require("cors");
const { loadDeployedAddresses } = require("./config/loadAddresses");

async function main() {
  // Must resolve before requiring routes/indexer below — indexer.js reads
  // process.env.IDENTITY_REGISTRY_ADDRESS / ASSET_NFT_ADDRESS at require time.
  await loadDeployedAddresses();

  const identityRoutes = require("./routes/identity");
  const assetRoutes = require("./routes/assets");
  const auditRoutes = require("./routes/audit");

  const app = express();
  app.use(cors());
  app.use(express.json());

  app.get("/health", (req, res) => res.json({ status: "ok" }));
  app.use("/api/identity", identityRoutes);
  app.use("/api/assets", assetRoutes);
  app.use("/api/audit", auditRoutes);

  const port = process.env.PORT || 4000;
  app.listen(port, () => console.log(`API listening on port ${port}`));
}

main().catch((err) => {
  console.error("Fatal error starting backend:", err);
  process.exit(1);
});