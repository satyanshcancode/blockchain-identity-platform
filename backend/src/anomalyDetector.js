// Lightweight, RULE-BASED anomaly scanner over the persisted audit event log
// (see db.js's getAllEvents()). This is explicitly NOT machine learning or
// AI - every rule below is a fixed threshold ("more than N of X within Y
// minutes/seconds") over data already in the event log. There is no model,
// no training data, and no probabilistic scoring; every flag is a plain,
// auditable comparison anyone can hand-verify against the same event log by
// eye. Keep it that way - do not describe this module as AI/ML anywhere in
// code, comments, or UI text that reads from it.
//
// Thresholds/windows are constants below (not inline) so they're easy to
// tune without hunting through the rule logic.

const RAPID_MINT_THRESHOLD_COUNT = 3;
const RAPID_MINT_WINDOW_MS = 5 * 60 * 1000;

const MINT_TRANSFER_WINDOW_MS = 2 * 60 * 1000;

const RAPID_ADMIN_ACTION_THRESHOLD_COUNT = 5;
const RAPID_ADMIN_ACTION_WINDOW_MS = 5 * 60 * 1000;

const UNAPPROVED_PROPOSAL_THRESHOLD_COUNT = 2;
const UNAPPROVED_PROPOSAL_WINDOW_MS = 5 * 60 * 1000;

function formatDuration(ms) {
  if (ms < 60000) return `${Math.round(ms / 1000)}s`;
  const minutes = ms / 60000;
  return `${Number.isInteger(minutes) ? minutes : minutes.toFixed(1)} minute${minutes === 1 ? "" : "s"}`;
}

// Groups `events` by keyFn(event) and, within each group, finds the most
// recent sliding window (by `ts`) containing more than `thresholdCount`
// events no more than `windowMs` apart. Reports at most one (the latest
// qualifying) burst per key, so a single ongoing burst doesn't produce a
// pile of overlapping near-duplicate flags.
function findBursts(events, keyFn, windowMs, thresholdCount) {
  const byKey = new Map();
  for (const e of events) {
    const key = keyFn(e);
    if (!key) continue;
    if (!byKey.has(key)) byKey.set(key, []);
    byKey.get(key).push(e);
  }

  const bursts = [];
  for (const [key, list] of byKey) {
    list.sort((a, b) => a.ts - b.ts);
    let windowStart = 0;
    let lastQualifying = null;
    for (let i = 0; i < list.length; i++) {
      while (list[i].ts - list[windowStart].ts > windowMs) windowStart++;
      const windowEvents = list.slice(windowStart, i + 1);
      if (windowEvents.length > thresholdCount) {
        lastQualifying = windowEvents;
      }
    }
    if (lastQualifying) bursts.push({ key, events: lastQualifying });
  }
  return bursts;
}

// Rule 1: rapid mint burst.
//
// NOTE ON WHAT THIS ACTUALLY MEASURES: the spec for this rule talks about
// "the same minter", but AssetNFT.sol's AssetMinted event only carries
// (tokenId, recipient, uri) - it never records msg.sender, so the indexer
// has no minter address to key off. This rule instead keys off the
// *recipient* (many mints landing on the same address fast), which is a
// real, honestly-labeled signal in its own right - keeping it distinct from
// "minter" avoids claiming data this system doesn't actually capture.
function detectRapidMintBursts(events) {
  const mints = events.filter((e) => e.type === "AssetMinted");
  const bursts = findBursts(mints, (e) => e.owner, RAPID_MINT_WINDOW_MS, RAPID_MINT_THRESHOLD_COUNT);
  return bursts.map(({ key: recipient, events: burstEvents }) => ({
    rule: "rapid-mint-burst",
    ruleLabel: "Rapid mint burst (same recipient)",
    addresses: [recipient],
    events: burstEvents,
    description:
      `${burstEvents.length} assets were minted to the same recipient (${recipient}) within ` +
      `${formatDuration(RAPID_MINT_WINDOW_MS)} - more than the threshold of ${RAPID_MINT_THRESHOLD_COUNT}, ` +
      `unusually fast for normal allocation.`
  }));
}

// Rule 2: mint, then an immediate transfer of that same token - unusual for
// a legitimate custody handover, common in a "mint and immediately launder
// ownership" pattern. Only the first transfer after a mint is considered;
// later transfers of the same token are ordinary ownership continuation.
function detectMintThenImmediateTransfer(events) {
  const mintByToken = new Map();
  for (const e of events) {
    if (e.type === "AssetMinted") mintByToken.set(e.tokenId, e);
  }
  const transfersByToken = new Map();
  for (const e of events) {
    if (e.type !== "AssetTransferred") continue;
    if (!transfersByToken.has(e.tokenId)) transfersByToken.set(e.tokenId, []);
    transfersByToken.get(e.tokenId).push(e);
  }

  const anomalies = [];
  for (const [tokenId, mint] of mintByToken) {
    const firstTransfer = (transfersByToken.get(tokenId) || [])
      .filter((t) => t.ts >= mint.ts)
      .sort((a, b) => a.ts - b.ts)[0];
    if (!firstTransfer) continue;

    const gapMs = firstTransfer.ts - mint.ts;
    if (gapMs > MINT_TRANSFER_WINDOW_MS) continue;

    anomalies.push({
      rule: "mint-then-immediate-transfer",
      ruleLabel: "Mint then immediate transfer",
      addresses: [mint.owner, firstTransfer.to],
      events: [mint, firstTransfer],
      description:
        `Asset #${tokenId} was transferred from ${firstTransfer.from} to ${firstTransfer.to} just ` +
        `${formatDuration(gapMs)} after being minted to ${mint.owner} - within the ` +
        `${formatDuration(MINT_TRANSFER_WINDOW_MS)} threshold, unusual for a legitimate custody handover.`
    });
  }
  return anomalies;
}

// Rule 3: rapid admin-type action burst from the same address - pause/
// unpause, and proposing or approving a revoke/reclaim. Could indicate a
// compromised admin/co-signer key being used to do damage quickly.
// ActionExecuted carries no actor address (see db.js) - the approval that
// crosses the threshold is already counted via its own ActionApproved event
// in the same transaction, so it's deliberately not double-counted here.
function detectRapidAdminActionBursts(events) {
  const adminActions = [];
  for (const e of events) {
    if (e.type === "PlatformPaused" || e.type === "PlatformUnpaused") {
      adminActions.push({ ...e, actor: e.admin });
    } else if (e.type === "ActionProposed") {
      adminActions.push({ ...e, actor: e.proposer });
    } else if (e.type === "ActionApproved") {
      adminActions.push({ ...e, actor: e.approver });
    }
  }

  const bursts = findBursts(adminActions, (e) => e.actor, RAPID_ADMIN_ACTION_WINDOW_MS, RAPID_ADMIN_ACTION_THRESHOLD_COUNT);
  return bursts.map(({ key: actor, events: burstEvents }) => ({
    rule: "rapid-admin-action-burst",
    ruleLabel: "Rapid admin action burst",
    addresses: [actor],
    events: burstEvents,
    description:
      `${burstEvents.length} admin-type actions (pause/unpause/propose/approve) were performed by ${actor} ` +
      `within ${formatDuration(RAPID_ADMIN_ACTION_WINDOW_MS)} - more than the threshold of ` +
      `${RAPID_ADMIN_ACTION_THRESHOLD_COUNT}, which could indicate a compromised key being used to act quickly.`
  }));
}

// Rule 4: a proposer with several proposals that have sat unapproved past
// the window - could indicate someone trying to force through multiple
// risky actions hoping one slips past co-signers. "Unapproved" means no
// ActionExecuted has fired for that proposalId yet (propose() always counts
// as the proposer's own first approval - see ApprovalRegistry.sol - so this
// is specifically about proposals still missing their second, different
// co-signer).
function detectUnapprovedProposalBacklog(events, now) {
  const executedIds = new Set(events.filter((e) => e.type === "ActionExecuted").map((e) => e.proposalId));

  const byProposer = new Map();
  for (const e of events) {
    if (e.type !== "ActionProposed") continue;
    if (executedIds.has(e.proposalId)) continue;
    if (now - e.ts < UNAPPROVED_PROPOSAL_WINDOW_MS) continue;
    if (!byProposer.has(e.proposer)) byProposer.set(e.proposer, []);
    byProposer.get(e.proposer).push(e);
  }

  const anomalies = [];
  for (const [proposer, proposals] of byProposer) {
    if (proposals.length <= UNAPPROVED_PROPOSAL_THRESHOLD_COUNT) continue;
    anomalies.push({
      rule: "unapproved-proposal-backlog",
      ruleLabel: "Unapproved proposal backlog",
      addresses: [proposer],
      events: proposals,
      description:
        `${proposer} has ${proposals.length} proposals still waiting on a second co-signer's approval ` +
        `after more than ${formatDuration(UNAPPROVED_PROPOSAL_WINDOW_MS)} - more than the threshold of ` +
        `${UNAPPROVED_PROPOSAL_THRESHOLD_COUNT}, which could indicate an attempt to force through multiple ` +
        `risky actions hoping one slips past co-signers.`
    });
  }
  return anomalies;
}

// Runs every rule over `events` (the same array shape getAllEvents()
// returns) and returns the combined, flat list of flagged anomalies. `now`
// defaults to the real clock but can be overridden for deterministic testing
// of window-based rules (see rule 4).
function detectAnomalies(events, { now = Date.now() } = {}) {
  return [
    ...detectRapidMintBursts(events),
    ...detectMintThenImmediateTransfer(events),
    ...detectRapidAdminActionBursts(events),
    ...detectUnapprovedProposalBacklog(events, now)
  ];
}

module.exports = {
  detectAnomalies,
  RAPID_MINT_THRESHOLD_COUNT,
  RAPID_MINT_WINDOW_MS,
  MINT_TRANSFER_WINDOW_MS,
  RAPID_ADMIN_ACTION_THRESHOLD_COUNT,
  RAPID_ADMIN_ACTION_WINDOW_MS,
  UNAPPROVED_PROPOSAL_THRESHOLD_COUNT,
  UNAPPROVED_PROPOSAL_WINDOW_MS
};
