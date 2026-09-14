const fs = require("fs");

const SHARED_ADDRESSES_PATH = process.env.SHARED_ADDRESSES_PATH || "/shared/addresses.json";
const MAX_WAIT_MS = 30000;
const POLL_INTERVAL_MS = 1000;

// Captured at module load - as close to "this container's startup" as this
// process gets - so a stale addresses.json already sitting on the shared
// volume from a PREVIOUS deploy (the volume survives container recreation;
// the deploy doesn't) can be told apart from a fresh one written by THIS
// boot's hardhat-node entrypoint. See the freshness check below.
const PROCESS_STARTED_AT = Date.now();

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits for scripts/deploy.js (running inside the hardhat-node container) to write
// its freshly-deployed contract addresses to a shared volume, then injects them
// into process.env. This replaces hand-copying deterministic addresses into
// docker-compose.yml every time contracts are redeployed, which silently goes
// stale the moment deploy order or account nonces change.
//
// Only waits when talking to the Docker hardhat-node (RPC_URL contains its
// hostname) — local/non-Docker runs skip straight to whatever's already in
// process.env (e.g. from backend/.env).
async function loadDeployedAddresses() {
  const usesDockerNode = (process.env.RPC_URL || "").includes("hardhat-node");
  if (!usesDockerNode) return;

  const deadline = Date.now() + MAX_WAIT_MS;
  while (Date.now() < deadline) {
    if (fs.existsSync(SHARED_ADDRESSES_PATH)) {
      try {
        const addresses = JSON.parse(fs.readFileSync(SHARED_ADDRESSES_PATH, "utf8"));
        // Confirmed live: this container can start and reach this check
        // before hardhat-node's own entrypoint (which sleeps, then runs
        // deploy.js) has finished overwriting the file for THIS boot - the
        // shared volume persists across restarts, so `existsSync` alone was
        // satisfied by a leftover file from an earlier deploy. Hardhat's
        // deterministic CREATE addressing happened to make every redeploy
        // produce identical addresses, so that race was harmless in
        // practice - but that's not guaranteed (a different account funding
        // order, a new contract added to deploy.js's sequence, etc. would
        // change it), so a deployedAt older than this process's own
        // startup is treated the same as the file not existing yet.
        const deployedAt = Date.parse(addresses.deployedAt);
        if (!Number.isNaN(deployedAt) && deployedAt < PROCESS_STARTED_AT) {
          console.warn(
            `Found ${SHARED_ADDRESSES_PATH} but it predates this container's startup ` +
              `(deployed ${addresses.deployedAt}) - waiting for a fresh deploy...`
          );
          await sleep(POLL_INTERVAL_MS);
          continue;
        }
        if (addresses.ROLE_REGISTRY_ADDRESS) process.env.ROLE_REGISTRY_ADDRESS = addresses.ROLE_REGISTRY_ADDRESS;
        if (addresses.APPROVAL_REGISTRY_ADDRESS) process.env.APPROVAL_REGISTRY_ADDRESS = addresses.APPROVAL_REGISTRY_ADDRESS;
        if (addresses.IDENTITY_REGISTRY_ADDRESS) process.env.IDENTITY_REGISTRY_ADDRESS = addresses.IDENTITY_REGISTRY_ADDRESS;
        if (addresses.ASSET_NFT_ADDRESS) process.env.ASSET_NFT_ADDRESS = addresses.ASSET_NFT_ADDRESS;
        console.log(`Loaded deployed contract addresses from ${SHARED_ADDRESSES_PATH} (deployed ${addresses.deployedAt})`);
        return;
      } catch (err) {
        console.warn("Found addresses file but failed to parse it, retrying:", err.message);
      }
    }
    await sleep(POLL_INTERVAL_MS);
  }
  console.warn(`Timed out waiting for a fresh ${SHARED_ADDRESSES_PATH} — using environment variables as-is.`);
}

module.exports = { loadDeployedAddresses };