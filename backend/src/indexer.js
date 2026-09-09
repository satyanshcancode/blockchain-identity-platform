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

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);

const identityAbi = ["event IdentityRegistered(address indexed account, string did, string metadataURI)"];
const assetAbi = [
  "event AssetMinted(uint256 indexed tokenId, address indexed owner, string uri)",
  "event AssetTransferred(uint256 indexed tokenId, address indexed from, address indexed to)",
  "event AssetReclaimed(uint256 indexed tokenId, address indexed from, address indexed to)",
  "event PlatformPaused(address indexed admin)",
  "event PlatformUnpaused(address indexed admin)"
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

function attachListeners(identityContract, assetContract) {
  identityContract.on("IdentityRegistered", (account, did, uri, event) => {
    record("IdentityRegistered", { account, payload: { did, uri } }, event.log);
    persistNow();
    console.log("Identity registered:", account, did);
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
}

// Fetches every log for one event in [fromBlock, toBlock] and writes it to
// the DB without persisting to disk yet - start() persists once after the
// whole catch-up batch instead of once per historical log.
async function catchUpEvent(contract, eventName, fromBlock, toBlock, mapArgs) {
  const logs = await contract.queryFilter(eventName, fromBlock, toBlock);
  for (const log of logs) {
    record(eventName, mapArgs(log.args), log);
  }
  return logs.length;
}

async function start() {
  console.log(`Indexer: connecting to RPC at ${process.env.RPC_URL}...`);
  const currentBlock = await waitForRpc(provider);

  const identityContract = new ethers.Contract(process.env.IDENTITY_REGISTRY_ADDRESS, identityAbi, provider);
  const assetContract = new ethers.Contract(process.env.ASSET_NFT_ADDRESS, assetAbi, provider);

  // Subscribe before scanning history, so an event emitted mid-scan can't
  // fall through the gap between "scan finished" and "subscribed live" - at
  // worst it's seen by both and the unique constraint in db.js drops the
  // duplicate insert.
  attachListeners(identityContract, assetContract);

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
    let caught = 0;
    caught += await catchUpEvent(identityContract, "IdentityRegistered", fromBlock, currentBlock, (args) => ({
      account: args.account,
      payload: { did: args.did, uri: args.metadataURI }
    }));
    caught += await catchUpEvent(assetContract, "AssetMinted", fromBlock, currentBlock, (args) => ({
      tokenId: args.tokenId.toString(),
      account: args.owner,
      payload: { uri: args.uri }
    }));
    caught += await catchUpEvent(assetContract, "AssetTransferred", fromBlock, currentBlock, (args) => ({
      tokenId: args.tokenId.toString(),
      from: args.from,
      to: args.to
    }));
    caught += await catchUpEvent(assetContract, "AssetReclaimed", fromBlock, currentBlock, (args) => ({
      tokenId: args.tokenId.toString(),
      from: args.from,
      to: args.to
    }));
    caught += await catchUpEvent(assetContract, "PlatformPaused", fromBlock, currentBlock, (args) => ({
      account: args.admin
    }));
    caught += await catchUpEvent(assetContract, "PlatformUnpaused", fromBlock, currentBlock, (args) => ({
      account: args.admin
    }));
    console.log(`Indexer: caught up, replayed ${caught} event(s) from downtime.`);
  }

  // Mark the whole range through, even if no events were found in it -
  // otherwise a quiet period would leave the checkpoint stale and every
  // future restart would re-scan the same already-empty range forever.
  markProcessedThrough(currentBlock);
  persistNow();
  console.log(`Indexer listening for live events (checkpoint at block ${currentBlock}).`);
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
