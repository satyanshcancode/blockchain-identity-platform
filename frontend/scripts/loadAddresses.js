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

// Captured at module load, before the poll loop below - the earliest this
// script can stand in for "this container's startup." See the freshness
// check inside main(): react-scripts only reads .env.local once, at the
// moment it's spawned (see the file-level comment below), so if this script
// writes it from a stale addresses.json, the dev server can end up running
// against contract addresses from a chain generation that's already gone,
// with nothing forcing it to notice until someone restarts this container.
const PROCESS_STARTED_AT = Date.now();

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
        // The shared volume persists across container recreation; the
        // deploy on it doesn't. existsSync alone can be satisfied by a
        // leftover file from a PREVIOUS deploy, still there because THIS
        // boot's hardhat-node entrypoint (which sleeps, then runs
        // deploy.js) hasn't finished overwriting it yet - confirmed live.
        // Hardhat's deterministic CREATE addressing happened to make every
        // redeploy produce identical addresses, so loading that stale file
        // was harmless in practice, but that's not guaranteed - so a
        // deployedAt older than this process's own startup is treated the
        // same as the file not existing yet.
        const deployedAt = Date.parse(addresses.deployedAt);
        if (!Number.isNaN(deployedAt) && deployedAt < PROCESS_STARTED_AT) {
          console.warn(
            `loadAddresses: found ${SHARED_ADDRESSES_PATH} but it predates this container's startup ` +
              `(deployed ${addresses.deployedAt}) - waiting for a fresh deploy...`
          );
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        const lines = [
          `REACT_APP_ROLE_REGISTRY_ADDRESS=${addresses.ROLE_REGISTRY_ADDRESS || ""}`,
          `REACT_APP_APPROVAL_REGISTRY_ADDRESS=${addresses.APPROVAL_REGISTRY_ADDRESS || ""}`,
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
  console.warn(`loadAddresses: timed out waiting for a fresh ${SHARED_ADDRESSES_PATH} - starting without deployed addresses.`);
}

main();
