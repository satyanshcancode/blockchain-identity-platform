// Listens for on-chain events and persists them to a local SQLite (sql.js)
// database (see ./db.js) so the audit trail survives backend restarts.
//
// On startup this doesn't just start listening from "now": it reads the
// last block number recorded in the DB and replays everything the chain
// emitted since then via queryFilter, before subscribing to new events live.
// That closes the gap where a restart (planned or a crash) could otherwise
// silently miss events that fired while the backend was down. Duplicate
// replays - an event seen by both the historical scan and the live listener -
// are made harmless by the DB's unique (tx_hash, log_index) constraint.
require("dotenv").config();
const { ethers } = require("ethers");
const { insertEvent, getLastProcessedBlock, markProcessedThrough, resetProcessedBlock, persistNow } = require("./db");
const { waitForRpc } = require("./config/waitForRpc");

// Forces ethers to watch for events by polling eth_getLogs over a block
// range (ethers' PollingEventSubscriber) instead of its default
// eth_newFilter/eth_getFilterChanges mechanism (FilterIdEventSubscriber).
//
// The default was found to die silently against Hardhat's local node: after
// a few minutes without any chain activity, Hardhat forgets the filter ID,
// eth_getFilterChanges then returns null instead of an array, and ethers'
// FilterIdEventSubscriber._emitResults does `for (const result of results)`
// on that null - throwing "results is not iterable". That throw happens
// inside ethers' own compiled code (subscriber-filterid.js's #poll), which
// catches it with a bare `console.log("@TODO", error)` and never rethrows
// or emits a public "error" event - so there is no hook available in
// application code to catch or react to this specific failure. Worse, it
// doesn't reset its cached (now-dead) filter ID, so every subsequent poll
// repeats the same failure forever - the listener is permanently dead until
// the process restarts (confirmed live: a transfer went unindexed after an
// idle period and only appeared after a manual restart triggered start()'s
// catch-up scan below).
//
// PollingEventSubscriber sidesteps the whole mechanism: it keeps no
// server-side filter state to expire, just tracks the last block number it
// scanned and calls eth_getLogs for whatever range is new. This eliminates
// the bug at its root rather than reacting to it after the fact. See also
// scheduleHeartbeat() below for a second, independent safety net.
const provider = new ethers.JsonRpcProvider(process.env.RPC_URL, undefined, { polling: true });

// A stray rejection from ethers' own internal polling (e.g. a transient RPC
// hiccup mid-poll) would otherwise be an unhandled promise rejection -
// Node's default since v15 is to crash the process on those. That would
// turn a transient network blip into a full backend outage instead of a
// logged, harmless blip. This is a precaution, not a reaction to something
// observed - PollingEventSubscriber's own poll loop has no internal
// try/catch (see node_modules/ethers/.../subscriber-polling.js), so this is
// the only backstop against it taking the process down.
process.on("unhandledRejection", (reason) => {
  console.error("Indexer: unhandled rejection (continuing, not exiting):", reason);
});

// How often scheduleHeartbeat() double-checks the persisted checkpoint
// against the chain's actual height and backfills any gap it finds. This is
// deliberately independent of *why* a gap might exist - unlike the
// polling:true fix above (which targets one specific, now-understood
// failure mode), the heartbeat is a general safety net against anything
// that could stop live events from landing (this bug, a future ethers
// change, an RPC restart, ...), so a demo can't be silently missing data
// with no visible sign of it.
const HEARTBEAT_INTERVAL_MS = 2 * 60 * 1000;

const identityAbi = [
  "event IdentityRegistered(address indexed account, string did, string metadataURI)",
  "event IdentityRevoked(address indexed account)"
];
const assetAbi = [
  "event AssetMinted(uint256 indexed tokenId, address indexed owner, string uri)",
  "event AssetTransferred(uint256 indexed tokenId, address indexed from, address indexed to)",
  "event AssetReclaimed(uint256 indexed tokenId, address indexed from, address indexed to)",
  "event PlatformPaused(address indexed admin)",
  "event PlatformUnpaused(address indexed admin)"
];
const approvalAbi = [
  "event ActionProposed(uint256 indexed proposalId, address indexed targetContract, uint8 actionType, address indexed proposer, bytes data)",
  "event ActionApproved(uint256 indexed proposalId, address indexed approver, uint256 approvalCount)",
  "event ActionExecuted(uint256 indexed proposalId)"
];

function record(type, fields, log) {
  insertEvent({
    type,
    ...fields,
    blockNumber: log.blockNumber,
    txHash: log.transactionHash,
    logIndex: log.index,
    ts: Date.now()
  });
}

function attachListeners(identityContract, assetContract, approvalContract) {
  identityContract.on("IdentityRegistered", (account, did, uri, event) => {
    record("IdentityRegistered", { account, payload: { did, uri } }, event.log);
    persistNow();
    console.log("Identity registered:", account, did);
  });

  identityContract.on("IdentityRevoked", (account, event) => {
    record("IdentityRevoked", { account }, event.log);
    persistNow();
    console.log("Identity revoked:", account);
  });

  assetContract.on("AssetMinted", (tokenId, owner, uri, event) => {
    record("AssetMinted", { tokenId: tokenId.toString(), account: owner, payload: { uri } }, event.log);
    persistNow();
    console.log("Asset minted:", tokenId.toString(), owner);
  });

  assetContract.on("AssetTransferred", (tokenId, from, to, event) => {
    record("AssetTransferred", { tokenId: tokenId.toString(), from, to }, event.log);
    persistNow();
    console.log("Asset transferred:", tokenId.toString(), from, "->", to);
  });

  assetContract.on("AssetReclaimed", (tokenId, from, to, event) => {
    record("AssetReclaimed", { tokenId: tokenId.toString(), from, to }, event.log);
    persistNow();
    console.log("Asset reclaimed:", tokenId.toString(), from, "->", to);
  });

  assetContract.on("PlatformPaused", (admin, event) => {
    record("PlatformPaused", { account: admin }, event.log);
    persistNow();
    console.log("Platform paused by:", admin);
  });

  assetContract.on("PlatformUnpaused", (admin, event) => {
    record("PlatformUnpaused", { account: admin }, event.log);
    persistNow();
    console.log("Platform unpaused by:", admin);
  });

  approvalContract.on("ActionProposed", (proposalId, targetContract, actionType, proposer, data, event) => {
    record(
      "ActionProposed",
      // actionType is a uint8 enum - ethers returns it as a BigInt, which
      // JSON.stringify (used when persisting payload below) cannot serialize
      // ("Do not know how to serialize a BigInt"). That throw happened
      // inside this listener callback, and ethers' own dispatch loop
      // silently swallows exceptions thrown by event listeners - no crash,
      // no log, the event just never got recorded. Number() here converts
      // it up front so this listener can't hit that silently-dropped path.
      { tokenId: proposalId.toString(), account: proposer, payload: { targetContract, actionType: Number(actionType), data } },
      event.log
    );
    persistNow();
    console.log("Action proposed:", proposalId.toString(), "by", proposer);
  });

  approvalContract.on("ActionApproved", (proposalId, approver, approvalCount, event) => {
    record(
      "ActionApproved",
      { tokenId: proposalId.toString(), account: approver, payload: { approvalCount: approvalCount.toString() } },
      event.log
    );
    persistNow();
    console.log("Action approved:", proposalId.toString(), "by", approver, `(${approvalCount}/2)`);
  });

  approvalContract.on("ActionExecuted", (proposalId, event) => {
    record("ActionExecuted", { tokenId: proposalId.toString() }, event.log);
    persistNow();
    console.log("Action executed:", proposalId.toString());
  });
}

// Fetches every log for one event in [fromBlock, toBlock] and writes it to
// the DB without persisting to disk yet - callers persist once after the
// whole catch-up batch instead of once per historical log.
async function catchUpEvent(contract, eventName, fromBlock, toBlock, mapArgs) {
  const logs = await contract.queryFilter(eventName, fromBlock, toBlock);
  for (const log of logs) {
    record(eventName, mapArgs(log.args), log);
  }
  return logs.length;
}

// Runs catchUpEvent for every event type this indexer knows about, across
// all three contracts, over [fromBlock, toBlock]. Shared by start()'s
// startup catch-up and scheduleHeartbeat()'s periodic backfill so the two
// can't drift out of sync (e.g. a new event type added to one but not the
// other) - there is exactly one list of "everything we index."
async function catchUpAll(identityContract, assetContract, approvalContract, fromBlock, toBlock) {
  let caught = 0;
  caught += await catchUpEvent(identityContract, "IdentityRegistered", fromBlock, toBlock, (args) => ({
    account: args.account,
    payload: { did: args.did, uri: args.metadataURI }
  }));
  caught += await catchUpEvent(identityContract, "IdentityRevoked", fromBlock, toBlock, (args) => ({
    account: args.account
  }));
  caught += await catchUpEvent(assetContract, "AssetMinted", fromBlock, toBlock, (args) => ({
    tokenId: args.tokenId.toString(),
    account: args.owner,
    payload: { uri: args.uri }
  }));
  caught += await catchUpEvent(assetContract, "AssetTransferred", fromBlock, toBlock, (args) => ({
    tokenId: args.tokenId.toString(),
    from: args.from,
    to: args.to
  }));
  caught += await catchUpEvent(assetContract, "AssetReclaimed", fromBlock, toBlock, (args) => ({
    tokenId: args.tokenId.toString(),
    from: args.from,
    to: args.to
  }));
  caught += await catchUpEvent(assetContract, "PlatformPaused", fromBlock, toBlock, (args) => ({
    account: args.admin
  }));
  caught += await catchUpEvent(assetContract, "PlatformUnpaused", fromBlock, toBlock, (args) => ({
    account: args.admin
  }));
  caught += await catchUpEvent(approvalContract, "ActionProposed", fromBlock, toBlock, (args) => ({
    tokenId: args.proposalId.toString(),
    account: args.proposer,
    // See the live listener's identical Number(actionType) note above -
    // args.actionType is a BigInt here too.
    payload: { targetContract: args.targetContract, actionType: Number(args.actionType), data: args.data }
  }));
  caught += await catchUpEvent(approvalContract, "ActionApproved", fromBlock, toBlock, (args) => ({
    tokenId: args.proposalId.toString(),
    account: args.approver,
    payload: { approvalCount: args.approvalCount.toString() }
  }));
  caught += await catchUpEvent(approvalContract, "ActionExecuted", fromBlock, toBlock, (args) => ({
    tokenId: args.proposalId.toString()
  }));
  return caught;
}

// Periodic safety net, independent of the live listeners: every
// HEARTBEAT_INTERVAL_MS, compares the chain's actual current height against
// the indexer's persisted checkpoint. In steady state these match (the live
// listeners already keep the checkpoint current) and this is a harmless,
// quiet no-op. If they ever don't match - live events stopped landing for
// any reason - this backfills the gap with the same catchUpAll() logic
// start() uses on a fresh boot, so a live demo self-heals within one
// heartbeat interval instead of silently missing data until someone
// notices and restarts the backend. Uses a self-rescheduling setTimeout
// (not setInterval) with a re-entrancy guard so a slow check can't overlap
// with the next one.
function scheduleHeartbeat(identityContract, assetContract, approvalContract) {
  let running = false;
  async function tick() {
    if (!running) {
      running = true;
      try {
        const currentBlock = await provider.getBlockNumber();
        const lastProcessed = getLastProcessedBlock();
        if (lastProcessed != null && currentBlock > lastProcessed) {
          const fromBlock = lastProcessed + 1;
          console.warn(
            `Indexer heartbeat: checkpoint (${lastProcessed}) is behind chain height (${currentBlock}) - ` +
            `live listeners missed something. Backfilling blocks ${fromBlock}-${currentBlock}...`
          );
          const caught = await catchUpAll(identityContract, assetContract, approvalContract, fromBlock, currentBlock);
          markProcessedThrough(currentBlock);
          persistNow();
          console.warn(`Indexer heartbeat: backfill complete, replayed ${caught} event(s), checkpoint now at ${currentBlock}.`);
        }
      } catch (err) {
        console.error("Indexer heartbeat: check failed, will retry next interval:", err.message);
      } finally {
        running = false;
      }
    }
    setTimeout(tick, HEARTBEAT_INTERVAL_MS);
  }
  setTimeout(tick, HEARTBEAT_INTERVAL_MS);
}

async function start() {
  console.log(`Indexer: connecting to RPC at ${process.env.RPC_URL}...`);
  const currentBlock = await waitForRpc(provider);

  const identityContract = new ethers.Contract(process.env.IDENTITY_REGISTRY_ADDRESS, identityAbi, provider);
  const assetContract = new ethers.Contract(process.env.ASSET_NFT_ADDRESS, assetAbi, provider);
  const approvalContract = new ethers.Contract(process.env.APPROVAL_REGISTRY_ADDRESS, approvalAbi, provider);

  // Subscribe before scanning history, so an event emitted mid-scan can't
  // fall through the gap between "scan finished" and "subscribed live" - at
  // worst it's seen by both and the unique constraint in db.js drops the
  // duplicate insert.
  attachListeners(identityContract, assetContract, approvalContract);

  let lastProcessed = getLastProcessedBlock();

  // A checkpoint higher than the chain's actual current height means the
  // chain itself is shorter than what we last indexed - the only way that
  // happens is a fresh hardhat-node replaced the one we were following (a
  // Docker restart with no volume for chain state, most likely), not normal
  // operation. Left alone, the catch-up branch below would just be skipped
  // silently (lastProcessed < currentBlock is false), pinning the indexer at
  // a stale, too-high checkpoint forever - it looks "caught up" but has
  // never seen anything on the new chain. Detect it and re-scan from
  // genesis instead. resetProcessedBlock() bypasses markProcessedThrough's
  // monotonic guard and persistNow() writes it immediately, so a crash
  // during the catch-up below can't strand the stale checkpoint on disk.
  if (lastProcessed != null && lastProcessed > currentBlock) {
    console.warn(
      `Indexer: chain height (${currentBlock}) is behind persisted checkpoint (${lastProcessed}) - chain was likely reset; re-scanning from block 0.`
    );
    resetProcessedBlock(0);
    persistNow();
    lastProcessed = 0;
  }

  if (lastProcessed == null) {
    console.log("Indexer: no prior checkpoint - starting fresh from block", currentBlock);
  } else if (lastProcessed < currentBlock) {
    const fromBlock = lastProcessed + 1;
    console.log(`Indexer: catching up on blocks ${fromBlock}-${currentBlock}...`);
    const caught = await catchUpAll(identityContract, assetContract, approvalContract, fromBlock, currentBlock);
    console.log(`Indexer: caught up, replayed ${caught} event(s) from downtime.`);
  }

  // Mark the whole range through, even if no events were found in it -
  // otherwise a quiet period would leave the checkpoint stale and every
  // future restart would re-scan the same already-empty range forever.
  markProcessedThrough(currentBlock);
  persistNow();
  console.log(`Indexer listening for live events (checkpoint at block ${currentBlock}).`);

  scheduleHeartbeat(identityContract, assetContract, approvalContract);
}

module.exports = { start };

// Lets `npm run indexer` still work as a standalone process (e.g. for local
// debugging without the full HTTP server). index.js instead calls start()
// itself after its own initDb() - initDb() is idempotent, so this path is
// only exercised when indexer.js is the entry point.
if (require.main === module) {
  const { initDb } = require("./db");
  initDb()
    .then(() => start())
    .catch((err) => {
      console.error("Fatal error starting indexer:", err);
      process.exit(1);
    });
}
