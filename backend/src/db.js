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

function hasColumn(table, column) {
  const stmt = db.prepare(`PRAGMA table_info(${table})`);
  let found = false;
  while (stmt.step()) {
    if (stmt.getAsObject().name === column) {
      found = true;
      break;
    }
  }
  stmt.free();
  return found;
}

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
      chain_fingerprint TEXT,
      UNIQUE(tx_hash, log_index)
    );
  `);
  // A DB file from before chain-fingerprint tracking existed already has an
  // `events` table - CREATE TABLE IF NOT EXISTS above is a no-op against it,
  // so the new column has to be added explicitly. Every pre-existing row
  // gets chain_fingerprint = NULL, which getAllEvents() below treats the
  // same as "doesn't match the current chain" - correct, since there's no
  // way to know which chain generation produced them.
  if (!hasColumn("events", "chain_fingerprint")) {
    db.run("ALTER TABLE events ADD COLUMN chain_fingerprint TEXT");
  }
  db.run(`
    CREATE TABLE IF NOT EXISTS indexer_state (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  // Anomalies (see anomalyDetector.js) are computed fresh from the event log
  // on every request, not stored - so "dismissing" one can't mean deleting a
  // row, there isn't one. Instead this records who reviewed which anomaly ID
  // and when; routes/audit.js overlays this onto each freshly-computed
  // anomaly rather than filtering server-side, so the frontend can still
  // show reviewed ones on request. anomaly_id is the detector's deterministic
  // id (rule + the exact event ids that triggered it - see
  // anomalyDetector.js's computeAnomalyId), so re-acknowledging the same
  // anomaly is just an upsert, not a new row.
  db.run(`
    CREATE TABLE IF NOT EXISTS anomaly_acknowledgements (
      anomaly_id TEXT PRIMARY KEY,
      acknowledged_by TEXT NOT NULL,
      acknowledged_at INTEGER NOT NULL
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
//
// chainFingerprint stamps the event with the chain generation it was
// observed on (see get/setChainFingerprint below) - indexer.js supplies its
// currently-known fingerprint on every call. getAllEvents() uses this to
// tell current-chain events apart from ones left over from a chain that's
// since been replaced (e.g. hardhat-node recreated with no chain-state
// volume), without ever deleting the older rows.
function insertEvent({ type, tokenId, account, from, to, payload, blockNumber, txHash, logIndex, ts, chainFingerprint }) {
  assertReady();
  db.run(
    `INSERT OR IGNORE INTO events
       (type, token_id, account, from_address, to_address, payload, block_number, tx_hash, log_index, ts, chain_fingerprint)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
      ts,
      chainFingerprint || null
    ]
  );
  markProcessedThrough(blockNumber);
}

// Reconstructs the same shape the old in-memory auditLog array used to hold,
// so routes/audit.js and routes/assets.js's knownTokenIds() only need to
// change where they get the array from, not how they read it.
function rowToEntry(row) {
  const payload = JSON.parse(row.payload || "{}");
  // id is the event's permanent row id - exposed so anomalyDetector.js can
  // derive a stable anomaly id from exactly which events triggered a rule
  // (see computeAnomalyId there). Every other consumer of getAllEvents()
  // already ignores fields it doesn't use, so this is purely additive.
  const base = { id: row.id, type: row.type, ts: row.ts };
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
    case "IdentityRegistryPaused":
    case "IdentityRegistryUnpaused":
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

// The single choke point every consumer of the event log goes through
// (routes/audit.js, anomalyDetector.js, assets.js's knownTokenIds(),
// approvals.js's knownProposalIds()) - filtering here, once, means none of
// them can forget to and none of them can present a dead chain's history as
// if it were live. Rows from a superseded chain generation (chain_fingerprint
// not equal to the current one, see get/setChainFingerprint) are excluded
// from the result but never deleted - the full history is still in the DB
// file for anyone who needs to inspect it directly.
//
// If no fingerprint has been recorded yet (in practice: nothing calls this
// before indexer.js's start() has run once), filtering can't be done
// meaningfully yet, so this falls back to returning everything rather than
// silently returning nothing.
function getAllEvents() {
  assertReady();
  const currentFingerprint = getChainFingerprint();
  const rows = [];
  const stmt = currentFingerprint
    ? db.prepare("SELECT * FROM events WHERE chain_fingerprint = ? ORDER BY id ASC")
    : db.prepare("SELECT * FROM events ORDER BY id ASC");
  if (currentFingerprint) stmt.bind([currentFingerprint]);
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

// The chain identity (chainId + genesis block hash - see indexer.js's
// computeChainFingerprint) the indexer last confirmed it was talking to.
// Same storage pattern as lastProcessedBlock above: a key in indexer_state,
// null meaning "never recorded" rather than any real fingerprint value.
function getChainFingerprint() {
  assertReady();
  const stmt = db.prepare("SELECT value FROM indexer_state WHERE key = 'chainFingerprint'");
  const value = stmt.step() ? stmt.getAsObject().value : null;
  stmt.free();
  return value || null;
}

function setChainFingerprint(fingerprint) {
  assertReady();
  db.run(
    `INSERT INTO indexer_state (key, value) VALUES ('chainFingerprint', ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    [fingerprint]
  );
}

// How many persisted events do NOT belong to `currentFingerprint` - i.e. how
// many getAllEvents() is about to exclude. Used purely for the startup log
// line (see indexer.js) so a chain replacement is visible in the logs with a
// concrete count, not just a silent behavior change.
function countStaleEvents(currentFingerprint) {
  assertReady();
  const stmt = db.prepare(
    "SELECT COUNT(*) AS c FROM events WHERE chain_fingerprint IS NULL OR chain_fingerprint != ?"
  );
  stmt.bind([currentFingerprint]);
  const count = stmt.step() ? stmt.getAsObject().c : 0;
  stmt.free();
  return count;
}

// Upsert: acknowledging an already-acknowledged anomaly just updates who/when
// most recently confirmed it, rather than erroring - a harmless double-click
// (or a second reviewer re-confirming) shouldn't need special handling.
function acknowledgeAnomaly(anomalyId, acknowledgedBy, acknowledgedAt) {
  assertReady();
  db.run(
    `INSERT INTO anomaly_acknowledgements (anomaly_id, acknowledged_by, acknowledged_at)
       VALUES (?, ?, ?)
     ON CONFLICT(anomaly_id) DO UPDATE SET acknowledged_by = excluded.acknowledged_by, acknowledged_at = excluded.acknowledged_at`,
    [anomalyId, acknowledgedBy, acknowledgedAt]
  );
  persistNow();
}

// Returns every acknowledgement as a Map keyed by anomaly_id, for
// routes/audit.js to overlay onto freshly-computed anomalies in one pass
// rather than querying per-anomaly.
function getAnomalyAcknowledgements() {
  assertReady();
  const map = new Map();
  const stmt = db.prepare("SELECT * FROM anomaly_acknowledgements");
  while (stmt.step()) {
    const row = stmt.getAsObject();
    map.set(row.anomaly_id, { acknowledgedBy: row.acknowledged_by, acknowledgedAt: row.acknowledged_at });
  }
  stmt.free();
  return map;
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
  getChainFingerprint,
  setChainFingerprint,
  countStaleEvents,
  persistNow,
  acknowledgeAnomaly,
  getAnomalyAcknowledgements
};
