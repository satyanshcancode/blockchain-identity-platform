// Polls /shared/addresses.json (written by scripts/deploy.js, see the
// equivalent backend/src/config/loadAddresses.js) and writes the deployed
// contract addresses into frontend/.env.local as REACT_APP_* vars.
//
// react-scripts only reads REACT_APP_* env vars at the moment the dev server
// boots, and the browser bundle has no filesystem access to read the shared
// volume itself, so this has to run to completion and finish writing the
// file *before* `react-scripts start` is spawned - see package.json's
// "start" script, which chains this in front of it.
//
// Skipped entirely outside Docker (no /shared volume): local dev should set
// REACT_APP_* vars directly, e.g. via a hand-written .env.local (see
// .env.example).
const fs = require("fs");
const path = require("path");

const SHARED_DIR = "/shared";
const SHARED_ADDRESSES_PATH = process.env.SHARED_ADDRESSES_PATH || path.join(SHARED_DIR, "addresses.json");
const ENV_LOCAL_PATH = path.join(__dirname, "..", ".env.local");
const MAX_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 1000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  if (!fs.existsSync(SHARED_DIR)) {
    console.log("loadAddresses: no /shared volume found - skipping (local dev uses REACT_APP_* env as-is).");
    return;
  }

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(SHARED_ADDRESSES_PATH)) {
      try {
        const addresses = JSON.parse(fs.readFileSync(SHARED_ADDRESSES_PATH, "utf8"));
        const lines = [
          `REACT_APP_ROLE_REGISTRY_ADDRESS=${addresses.ROLE_REGISTRY_ADDRESS || ""}`,
          `REACT_APP_IDENTITY_REGISTRY_ADDRESS=${addresses.IDENTITY_REGISTRY_ADDRESS || ""}`,
          `REACT_APP_ASSET_NFT_ADDRESS=${addresses.ASSET_NFT_ADDRESS || ""}`
        ];
        fs.writeFileSync(ENV_LOCAL_PATH, lines.join("\n") + "\n");
        console.log(`loadAddresses: wrote ${ENV_LOCAL_PATH} from ${SHARED_ADDRESSES_PATH} (deployed ${addresses.deployedAt})`);
        return;
      } catch (err) {
        console.warn("loadAddresses: found addresses file but failed to parse it, retrying:", err.message);
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  console.warn(`loadAddresses: timed out waiting for ${SHARED_ADDRESSES_PATH} - starting without deployed addresses.`);
}

main();
