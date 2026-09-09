// Persistent store for indexed on-chain events, backed by sql.js (SQLite
// compiled to WebAssembly). Chosen over a native binding like better-sqlite3
// specifically so nothing here needs a C++ toolchain to install or to build
// inside the backend's Alpine Docker image - `npm install` alone is enough.
//
// sql.js keeps the whole database in memory and only touches disk when
// persistNow() runs, so callers control exactly when a write hits the file
// (see indexer.js: immediately after each live event, once after a whole
// startup catch-up batch). EVENTS_DB_PATH should point at a path backed by a
// volume that survives container recreation, not just process restarts
// (see docker-compose.yml's `event-db` volume).
const fs = require("fs");
const path = require("path");
const initSqlJs = require("sql.js");

const DB_PATH = process.env.EVENTS_DB_PATH || path.join(__dirname, "..", "data", "events.db");

let db;

async function initDb() {
  if (db) return db;

  const SQL = await initSqlJs();
  fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

  db = fs.existsSync(DB_PATH) ? new SQL.Database(fs.readFileSync(DB_PATH)) : new SQL.Database();

  db.run(`
    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      token_id TEXT,
      account TEXT,
      from_address TEXT,
      to_address TEXT,
      payload TEXT NOT NULL DEFAULT '{}',
      block_number INTEGER NOT NULL,
      tx_hash TEXT NOT NULL,
      log_index INTEGER NOT NULL,
      ts INTEGER NOT NULL,
      UNIQUE(tx_hash, log_index)
    );
  `);
  db.run(`
    CREATE TABLE IF NOT EXISTS indexer_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);

  persistNow();
  return db;
}

function assertReady() {
  if (!db) throw new Error("db.js: initDb() must be awaited before using the events store");
}

// Records one decoded contract event. Idempotent: the (tx_hash, log_index)
// unique constraint means replaying the same log twice - e.g. because it was
// returned by both the startup catch-up scan and a live listener - is a
// silent no-op rather than a duplicate row.
function insertEvent({ type, tokenId, account, from, to, payload, blockNumber, txHash, logIndex, ts }) {
  assertReady();
  db.run(
    `INSERT OR IGNORE INTO events
       (type, token_id, account, from_address, to_address, payload, block_number, tx_hash, log_index, ts)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      type,
      tokenId != null ? String(tokenId) : null,
      account || null,
      from || null,
      to || null,
      JSON.stringify(payload || {}),
      blockNumber,
      txHash,
      logIndex,
      ts
    ]
  );
  markProcessedThrough(blockNumber);
}

// Reconstructs the same shape the old in-memory auditLog array used to hold,
// so routes/audit.js and routes/assets.js's knownTokenIds() only need to
// change where they get the array from, not how they read it.
function rowToEntry(row) {
  const payload = JSON.parse(row.payload || "{}");
  const base = { type: row.type, ts: row.ts };
  switch (row.type) {
    case "IdentityRegistered":
      return { ...base, account: row.account, did: payload.did, uri: payload.uri };
    case "IdentityRevoked":
      return { ...base, account: row.account };
    case "AssetMinted":
      return { ...base, tokenId: row.token_id, owner: row.account, uri: payload.uri };
    case "AssetTransferred":
    case "AssetReclaimed":
      return { ...base, tokenId: row.token_id, from: row.from_address, to: row.to_address };
    case "PlatformPaused":
    case "PlatformUnpaused":
      return { ...base, admin: row.account };
    case "ActionProposed":
      return {
        ...base,
        proposalId: row.token_id,
        proposer: row.account,
        targetContract: payload.targetContract,
        actionType: payload.actionType,
        data: payload.data
      };
    case "ActionApproved":
      return {
        ...base,
        proposalId: row.token_id,
        approver: row.account,
        approvalCount: payload.approvalCount
      };
    case "ActionExecuted":
      return { ...base, proposalId: row.token_id };
    default:
      return { ...base, ...payload };
  }
}

function getAllEvents() {
  assertReady();
  const rows = [];
  const stmt = db.prepare("SELECT * FROM events ORDER BY id ASC");
  while (stmt.step()) rows.push(stmt.getAsObject());
  stmt.free();
  return rows.map(rowToEntry);
}

// Null means "no checkpoint yet" (fresh DB) - distinct from 0, which is a
// real block number, so the indexer can tell "never run before" apart from
// "last run stopped at genesis."
function getLastProcessedBlock() {
  assertReady();
  const stmt = db.prepare("SELECT value FROM indexer_state WHERE key = 'lastProcessedBlock'");
  const value = stmt.step() ? stmt.getAsObject().value : null;
  stmt.free();
  return value != null ? Number(value) : null;
}

function setLastProcessedBlock(blockNumber) {
  assertReady();
  db.run(
    `INSERT INTO indexer_state (key, value) VALUES ('lastProcessedBlock', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [String(blockNumber)]
  );
}

// Monotonic: never rewinds the checkpoint, so out-of-order calls (a live
// event for an older block landing after a catch-up scan already marked a
// later one processed) can't make the indexer re-scan blocks it already has.
function markProcessedThrough(blockNumber) {
  const current = getLastProcessedBlock();
  if (current != null && blockNumber <= current) return;
  setLastProcessedBlock(blockNumber);
}

// Bypasses markProcessedThrough's monotonic guard - only for indexer.js's
// "the chain's current height is lower than our checkpoint" recovery path
// (a fresh hardhat-node replacing the one we last indexed). That guard
// exists precisely to stop the checkpoint from ever moving backwards during
// normal operation, so undoing it needs its own explicit, clearly-named
// function rather than a flag on markProcessedThrough.
function resetProcessedBlock(blockNumber) {
  setLastProcessedBlock(blockNumber);
}

// Writes to a temp file and renames it over DB_PATH rather than writing
// DB_PATH directly. fs.writeFileSync(DB_PATH, ...) would rewrite the whole
// file in place; a crash mid-write (kill -9, power loss - not a clean
// shutdown) could leave it truncated/corrupted. rename() is atomic on both
// POSIX and NTFS, so a crash mid-write instead leaves the previous, intact
// version at DB_PATH and only strands the half-written temp file.
function persistNow() {
  assertReady();
  const data = db.export();
  const tmpPath = `${DB_PATH}.tmp`;
  fs.writeFileSync(tmpPath, Buffer.from(data));
  fs.renameSync(tmpPath, DB_PATH);
}

module.exports = {
  initDb,
  insertEvent,
  getAllEvents,
  getLastProcessedBlock,
  markProcessedThrough,
  resetProcessedBlock,
  persistNow
};
