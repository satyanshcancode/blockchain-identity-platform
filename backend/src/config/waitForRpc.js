const RETRY_INTERVAL_MS = 2000;
const MAX_WAIT_MS = 30000;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// Waits for `provider`'s RPC endpoint to actually answer before returning,
// retrying with backoff instead of failing on the first attempt.
//
// docker-compose's `depends_on: hardhat-node` only waits for that container
// to start, not for the Hardhat node's RPC server inside it to be listening
// yet - the same kind of gap loadAddresses.js (in this directory) handles
// for the deployed-addresses file. Without this, the indexer's first RPC
// call can hit that window and crash the whole backend before hardhat-node
// finishes booting, instead of just waiting it out.
async function waitForRpc(provider, { intervalMs = RETRY_INTERVAL_MS, timeoutMs = MAX_WAIT_MS } = {}) {
  const deadline = Date.now() + timeoutMs;
  let attempt = 0;
  for (;;) {
    attempt += 1;
    try {
      return await provider.getBlockNumber();
    } catch (err) {
      if (Date.now() >= deadline) {
        throw new Error(`RPC never became reachable after ${attempt} attempt(s): ${err.message}`);
      }
      console.warn(`Waiting for RPC (attempt ${attempt} failed: ${err.message}) - retrying in ${intervalMs}ms...`);
      await sleep(intervalMs);
    }
  }
}

module.exports = { waitForRpc };
