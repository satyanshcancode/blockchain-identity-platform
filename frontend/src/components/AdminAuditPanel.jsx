import React, { useCallback, useEffect, useState } from "react";
import { isAddress } from "ethers";
import { useWallet } from "../context/WalletContext";
import {
  getAuditLog,
  getAssetHistory,
  getComplianceRecord,
  getPendingApprovals,
  getAnomalies,
  acknowledgeAnomaly
} from "../services/api";
import {
  registerIdentity,
  revokeIdentity,
  reclaimAsset,
  approveRevokeIdentity,
  approveReclaimAsset,
  hasApproved,
  pauseAssets,
  unpauseAssets,
  getAssetsPaused,
  pauseIdentity,
  unpauseIdentity,
  getIdentityPaused
} from "../services/contractService";

// Rendered only if the connected wallet has ADMIN_ROLE or AUDITOR_ROLE - see
// App.jsx, which doesn't mount this component at all otherwise. The guard
// below is a defensive backstop in case that ever changes, not the primary
// gate: per the spec this panel must be hidden entirely, not just disabled.
export default function AdminAuditPanel() {
  const { address, signer, roles } = useWallet();

  const [auditLog, setAuditLog] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [error, setError] = useState(null);

  const [historyTokenId, setHistoryTokenId] = useState("");
  const [history, setHistory] = useState(null);
  const [historyBusy, setHistoryBusy] = useState(false);

  const [complianceAddress, setComplianceAddress] = useState("");
  const [compliance, setCompliance] = useState(null);
  const [complianceBusy, setComplianceBusy] = useState(false);

  // AssetNFT and IdentityRegistry each have their OWN independent pause
  // state (see IdentityRegistry.sol's pause()/unpause() doc comment for why
  // they're not shared) - both are tracked separately so the banner can
  // honestly show a partial state (e.g. one paused, the other not) instead
  // of collapsing them into a single flag that could misrepresent reality.
  const [assetsPaused, setAssetsPaused] = useState(null);
  const [identityPaused, setIdentityPaused] = useState(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseStatus, setPauseStatus] = useState(null);

  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [approvedByMe, setApprovedByMe] = useState(new Set());
  const [approveBusyId, setApproveBusyId] = useState(null);
  const [approveStatus, setApproveStatus] = useState(null);

  const [anomalies, setAnomalies] = useState([]);
  const [anomaliesLoading, setAnomaliesLoading] = useState(false);
  const [showReviewed, setShowReviewed] = useState(false);
  const [ackBusyId, setAckBusyId] = useState(null);

  const [regAccount, setRegAccount] = useState("");
  const [regDid, setRegDid] = useState("");
  const [regUri, setRegUri] = useState("");
  const [regSignature, setRegSignature] = useState("");
  const [regBusy, setRegBusy] = useState(false);
  const [regStatus, setRegStatus] = useState(null);

  const [revokeAddress, setRevokeAddress] = useState("");
  const [revokeBusy, setRevokeBusy] = useState(false);
  const [revokeStatus, setRevokeStatus] = useState(null);

  const [reclaimTokenId, setReclaimTokenId] = useState("");
  const [reclaimNewOwner, setReclaimNewOwner] = useState("");
  const [reclaimBusy, setReclaimBusy] = useState(false);
  const [reclaimStatus, setReclaimStatus] = useState(null);

  const loadAuditLog = async () => {
    if (!signer || !address) return;
    setAuditLoading(true);
    setError(null);
    try {
      setAuditLog(await getAuditLog(signer, address));
    } catch (err) {
      setError(err.message);
    } finally {
      setAuditLoading(false);
    }
  };

  const loadPaused = useCallback(async () => {
    if (!roles.isAdmin) return;
    try {
      const [assets, identity] = await Promise.all([getAssetsPaused(signer), getIdentityPaused(signer)]);
      setAssetsPaused(assets);
      setIdentityPaused(identity);
    } catch (err) {
      setError(err.message);
    }
  }, [roles.isAdmin, signer]);

  // Which pending proposals the CONNECTED wallet has already approved - the
  // backend's list doesn't include this (it's per-viewer, not indexed audit
  // data), so it's fetched live via the same on-chain-read-through-the-
  // connected-wallet exception role checks and getAssetsPaused()/
  // getIdentityPaused() already use. Only bothers making those calls for a
  // co-signer, since only a co-signer could ever see the Approve button
  // anyway.
  const loadPendingApprovals = useCallback(async () => {
    if (!signer || !address) return;
    setPendingLoading(true);
    try {
      const list = await getPendingApprovals(signer, address);
      setPendingApprovals(list);
      if (roles.isCoSigner && address) {
        const flags = await Promise.all(list.map((p) => hasApproved(signer, p.proposalId, address)));
        setApprovedByMe(new Set(list.filter((_, i) => flags[i]).map((p) => p.proposalId)));
      } else {
        setApprovedByMe(new Set());
      }
    } catch (err) {
      setError(err.message);
    } finally {
      setPendingLoading(false);
    }
  }, [roles.isCoSigner, address, signer]);

  const loadAnomalies = useCallback(async () => {
    if (!signer || !address) return;
    setAnomaliesLoading(true);
    try {
      setAnomalies(await getAnomalies(signer, address));
    } catch (err) {
      setError(err.message);
    } finally {
      setAnomaliesLoading(false);
    }
  }, [signer, address]);

  useEffect(() => {
    loadAuditLog();
    loadPaused();
    loadPendingApprovals();
    loadAnomalies();
  }, [loadPaused, loadPendingApprovals, loadAnomalies]);

  if (!roles.isAdmin && !roles.isAuditor) return null;

  const handleHistoryLookup = async (e) => {
    e.preventDefault();
    setHistoryBusy(true);
    setError(null);
    try {
      setHistory(await getAssetHistory(historyTokenId));
    } catch (err) {
      setError(err.message);
    } finally {
      setHistoryBusy(false);
    }
  };

  const handleComplianceLookup = async (e) => {
    e.preventDefault();
    setError(null);
    // Catches a malformed address here, before it's sent - the backend
    // rejects it too (see backend/src/routes/identity.js), but a typo
    // shouldn't need a round trip (and a MetaMask signature, for this
    // auth-gated route) just to find out.
    if (!isAddress(complianceAddress)) {
      setError("Enter a valid address (0x followed by 40 hex characters).");
      return;
    }
    setComplianceBusy(true);
    try {
      setCompliance(await getComplianceRecord(complianceAddress, signer, address));
    } catch (err) {
      setError(err.message);
    } finally {
      setComplianceBusy(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setRegStatus(null);
    setError(null);
    if (!isAddress(regAccount)) {
      setError("Enter a valid account address (0x followed by 40 hex characters).");
      return;
    }
    // Also enforced on-chain (registerIdentity reverts on an empty DID) and
    // at the signing step in IdentityCard.jsx - this catches an admin's own
    // typo before spending a transaction on a signature mismatch.
    if (!regDid.trim()) {
      setError("DID cannot be empty or just whitespace.");
      return;
    }
    setRegBusy(true);
    // The write and the follow-up audit-log refresh are deliberately in
    // separate try/catch blocks: registerIdentity() succeeding and
    // loadAuditLog() then failing (a transient network blip, say) are two
    // different outcomes and shouldn't collapse into one "it failed"
    // message when the identity was, in fact, registered.
    try {
      await registerIdentity(signer, regAccount, regDid, regUri, regSignature);
    } catch (err) {
      setError(err.message);
      setRegBusy(false);
      return;
    }
    setRegStatus(`Identity registered for ${regAccount}.`);
    setRegAccount("");
    setRegDid("");
    setRegUri("");
    setRegSignature("");
    try {
      await loadAuditLog();
    } catch (err) {
      setError(`Identity registered, but refreshing the audit log failed - click refresh. (${err.message})`);
    } finally {
      setRegBusy(false);
    }
  };

  const handleRevoke = async (e) => {
    e.preventDefault();
    setRevokeStatus(null);
    setError(null);
    if (!isAddress(revokeAddress)) {
      setError("Enter a valid address (0x followed by 40 hex characters).");
      return;
    }
    setRevokeBusy(true);
    try {
      await revokeIdentity(signer, revokeAddress);
    } catch (err) {
      setError(err.message);
      setRevokeBusy(false);
      return;
    }
    setRevokeStatus(
      `Proposed revoking ${revokeAddress} - needs one more co-signer's approval below before it takes effect.`
    );
    setRevokeAddress("");
    try {
      await loadAuditLog();
      await loadPendingApprovals();
    } catch (err) {
      setError(`Revoke proposed, but refreshing the view failed - click refresh. (${err.message})`);
    } finally {
      setRevokeBusy(false);
    }
  };

  const handleReclaim = async (e) => {
    e.preventDefault();
    setReclaimStatus(null);
    setError(null);
    if (!isAddress(reclaimNewOwner)) {
      setError("Enter a valid new-owner address (0x followed by 40 hex characters).");
      return;
    }
    setReclaimBusy(true);
    try {
      await reclaimAsset(signer, reclaimTokenId, reclaimNewOwner);
    } catch (err) {
      setError(err.message);
      setReclaimBusy(false);
      return;
    }
    setReclaimStatus(
      `Proposed reclaiming #${reclaimTokenId} to ${reclaimNewOwner} - needs one more co-signer's approval below before it takes effect.`
    );
    setReclaimTokenId("");
    setReclaimNewOwner("");
    try {
      await loadAuditLog();
      await loadPendingApprovals();
    } catch (err) {
      setError(`Reclaim proposed, but refreshing the view failed - click refresh. (${err.message})`);
    } finally {
      setReclaimBusy(false);
    }
  };

  const handleApprove = async (proposal) => {
    setApproveBusyId(proposal.proposalId);
    setApproveStatus(null);
    setError(null);
    try {
      if (proposal.actionType === "RevokeIdentity") {
        await approveRevokeIdentity(signer, proposal.proposalId);
      } else {
        await approveReclaimAsset(signer, proposal.proposalId);
      }
    } catch (err) {
      setError(err.message);
      setApproveBusyId(null);
      return;
    }
    setApproveStatus(`Approved proposal #${proposal.proposalId}.`);
    try {
      await loadPendingApprovals();
      await loadAuditLog();
    } catch (err) {
      setError(`Approval succeeded, but refreshing the view failed - click refresh. (${err.message})`);
    } finally {
      setApproveBusyId(null);
    }
  };

  // Acknowledging never deletes or alters an anomaly - it records that this
  // wallet reviewed it (see backend/src/routes/audit.js), and the backend
  // re-annotates it as acknowledged on the next fetch. Re-fetching (rather
  // than optimistically flipping local state) is deliberate: it's the same
  // roundtrip that would happen anyway, and it means the count/list can
  // never drift from what's actually persisted.
  const handleAcknowledge = async (anomaly) => {
    setAckBusyId(anomaly.id);
    setError(null);
    try {
      await acknowledgeAnomaly(anomaly.id, signer, address);
    } catch (err) {
      setError(err.message);
      setAckBusyId(null);
      return;
    }
    try {
      await loadAnomalies();
    } catch (err) {
      setError(`Anomaly acknowledged, but refreshing the list failed - click Refresh above. (${err.message})`);
    } finally {
      setAckBusyId(null);
    }
  };

  // Drives BOTH independent pause states toward one target (true = pause
  // everything, false = resume everything) as two sequential transactions -
  // skipping whichever contract is already at the target state, so clicking
  // "Pause everything" from a partial state (say assets already paused)
  // doesn't needlessly resubmit a call that would just revert. If the
  // second step fails (rejected in MetaMask, reverts, network issue) after
  // the first already landed on-chain, the platform is left in a genuine
  // partial state - loadPaused() below re-reads BOTH from the chain
  // afterward regardless of outcome, so the banner always reflects reality
  // rather than assuming the action fully succeeded.
  const handleSetPaused = async (targetPaused) => {
    setPauseBusy(true);
    setPauseStatus(null);
    setError(null);

    const steps = [];
    if (assetsPaused !== targetPaused) {
      steps.push({ label: "asset operations", run: targetPaused ? pauseAssets : unpauseAssets });
    }
    if (identityPaused !== targetPaused) {
      steps.push({ label: "identity operations", run: targetPaused ? pauseIdentity : unpauseIdentity });
    }

    if (steps.length === 0) {
      setPauseStatus(targetPaused ? "Already fully paused." : "Already fully active.");
      setPauseBusy(false);
      return;
    }

    let failedAt = null;
    for (let i = 0; i < steps.length; i++) {
      setPauseStatus(
        `${targetPaused ? "Pausing" : "Resuming"} ${steps[i].label} (${i + 1}/${steps.length})...`
      );
      try {
        await steps[i].run(signer);
      } catch (err) {
        failedAt = steps[i].label;
        setError(
          `Failed to ${targetPaused ? "pause" : "resume"} ${steps[i].label}: ${err.message} - ` +
            `the platform may now be in a partial state; see the banner below for the actual result.`
        );
        break;
      }
    }

    // Split from the write loop above so a failure here (a transient
    // network blip while re-reading the chain) can't throw out of the
    // whole handler uncaught - which would leave pauseBusy stuck on
    // "Working..." forever and never report anything, even though the
    // pause/resume step(s) above may have already succeeded.
    try {
      await loadPaused();
      await loadAuditLog();
    } catch (err) {
      if (!failedAt) {
        setError(`Pause state updated, but refreshing the view failed - click refresh. (${err.message})`);
      }
    }
    setPauseStatus(
      failedAt
        ? null
        : targetPaused
          ? "Both asset and identity operations are now paused."
          : "Both asset and identity operations are now active."
    );
    setPauseBusy(false);
  };

  return (
    <div>
      <h2 className="page-title">Admin / audit panel</h2>
      {error && <p className="alert alert--error">{error}</p>}

      {roles.isAdmin && assetsPaused != null && identityPaused != null && (() => {
        const bothActive = !assetsPaused && !identityPaused;
        const bothPaused = assetsPaused && identityPaused;
        const bannerClass = bothPaused ? "banner--critical" : bothActive ? "banner--success" : "banner--warning";
        const title = bothPaused
          ? "⛔ FULLY PAUSED"
          : bothActive
            ? "✅ Active"
            : "⚠️ PARTIALLY PAUSED";
        return (
          <section className={`banner ${bannerClass}`}>
            <div className="banner__title">{title}</div>
            <p className="banner__body" style={{ margin: "4px 0 4px" }}>
              Asset operations (mint / transfer / reclaim):{" "}
              <strong>{assetsPaused ? "paused" : "active"}</strong>
            </p>
            <p className="banner__body" style={{ margin: "4px 0 8px" }}>
              Identity operations (register / revoke / approve revoke / update metadata):{" "}
              <strong>{identityPaused ? "paused" : "active"}</strong>
            </p>
            <div className="banner__actions">
              <button className="btn btn--danger btn--sm" onClick={() => handleSetPaused(true)} disabled={pauseBusy || bothPaused}>
                {pauseBusy ? "Working..." : "Pause everything"}
              </button>
              <button className="btn btn--sm" onClick={() => handleSetPaused(false)} disabled={pauseBusy || bothActive}>
                {pauseBusy ? "Working..." : "Resume everything"}
              </button>
            </div>
            {pauseStatus && <p className="banner__body mt-3">{pauseStatus}</p>}
          </section>
        );
      })()}

      {(() => {
        const unreviewed = anomalies.filter((a) => !a.acknowledged);
        const reviewed = anomalies.filter((a) => a.acknowledged);
        return (
          <section className={`banner ${unreviewed.length > 0 ? "banner--critical" : "banner--success"}`}>
            <div className="banner__title">
              {unreviewed.length > 0
                ? `⚠️ ${unreviewed.length} anomaly alert${unreviewed.length === 1 ? "" : "s"}`
                : "✅ No anomalies detected"}
            </div>
            <p className="banner__body" style={{ margin: "4px 0 8px" }}>
              Rule-based checks over the audit log - fixed thresholds (rapid mint bursts,
              mint-then-immediate-transfer, rapid admin action bursts, unapproved proposal
              backlogs), not AI/ML. Marking one reviewed doesn't erase it - it's recorded who
              reviewed it and when, not deleted.
            </p>
            <div className="banner__actions">
              <button className="btn btn--secondary btn--sm" onClick={loadAnomalies} disabled={anomaliesLoading}>
                {anomaliesLoading ? "Scanning..." : "Refresh"}
              </button>
              {reviewed.length > 0 && (
                <button className="btn btn--secondary btn--sm" onClick={() => setShowReviewed((v) => !v)}>
                  {showReviewed ? "Hide reviewed alerts" : `Show ${reviewed.length} reviewed alert${reviewed.length === 1 ? "" : "s"}`}
                </button>
              )}
            </div>
            {unreviewed.length > 0 && (
              <ul className="item-list mt-3">
                {unreviewed.map((a) => (
                  <li key={a.id} className="item-list__row">
                    <strong>{a.ruleLabel}</strong>
                    <p style={{ margin: "4px 0" }}>{a.description}</p>
                    <div className="small-text">
                      {a.events.length} event(s) involved — {a.addresses.join(", ")}
                    </div>
                    <button className="btn btn--secondary btn--sm mt-3" onClick={() => handleAcknowledge(a)} disabled={ackBusyId === a.id}>
                      {ackBusyId === a.id ? "Marking..." : "Mark as reviewed"}
                    </button>
                  </li>
                ))}
              </ul>
            )}
            {showReviewed && reviewed.length > 0 && (
              <ul className="item-list mt-3">
                {reviewed.map((a) => (
                  <li key={a.id} className="item-list__row item-list__row--muted">
                    <strong>{a.ruleLabel}</strong>
                    <p style={{ margin: "4px 0" }}>{a.description}</p>
                    <div className="small-text">
                      {a.events.length} event(s) involved — {a.addresses.join(", ")}
                    </div>
                    <div className="small-text">
                      ✓ Reviewed by {a.acknowledgedBy} at {new Date(a.acknowledgedAt).toLocaleString()}
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        );
      })()}

      <section className="panel">
        <div className="panel__header">
          <h3 className="panel__title">Audit log</h3>
          <button className="btn btn--secondary btn--sm" onClick={loadAuditLog} disabled={auditLoading}>
            {auditLoading ? "Loading..." : "Refresh"}
          </button>
        </div>
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Type</th>
                <th>Details</th>
                <th>Time</th>
              </tr>
            </thead>
            <tbody>
              {auditLog.map((entry, i) => (
                <tr key={i}>
                  <td>{entry.type}</td>
                  <td>{describeEntry(entry)}</td>
                  <td>{new Date(entry.ts).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section className="panel">
        <h3 className="panel__title">Per-token transfer history</h3>
        <form onSubmit={handleHistoryLookup} className="inline-form mt-3">
          <label className="field" style={{ marginBottom: 0 }}>
            <span className="field__label-text">Token ID</span>
            <input value={historyTokenId} onChange={(e) => setHistoryTokenId(e.target.value)} required />
          </label>
          <button type="submit" className="btn" disabled={historyBusy}>{historyBusy ? "Looking up..." : "Lookup"}</button>
        </form>
        {history && (
          <ul className="item-list mt-3">
            {history.map((h, i) => (
              <li key={i} className="item-list__row">
                <span className="mono">{h.from}</span> → <span className="mono">{h.to}</span> at{" "}
                {new Date(Number(h.timestamp) * 1000).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section className="panel">
        <h3 className="panel__title">Per-identity compliance record</h3>
        <form onSubmit={handleComplianceLookup} className="inline-form mt-3">
          <label className="field" style={{ marginBottom: 0 }}>
            <span className="field__label-text">Address</span>
            <input
              className="mono-input"
              value={complianceAddress}
              onChange={(e) => setComplianceAddress(e.target.value)}
              placeholder="0x..."
              required
            />
          </label>
          <button type="submit" className="btn" disabled={complianceBusy}>{complianceBusy ? "Looking up..." : "Lookup"}</button>
        </form>
        {compliance && (
          <dl className="kv-list mt-3">
            <dt>Registered at</dt>
            <dd>{formatTs(compliance.registeredAt)}</dd>
            <dt>Last updated at</dt>
            <dd>{formatTs(compliance.lastUpdatedAt)}</dd>
            <dt>Revoked at</dt>
            <dd>{compliance.revokedAt !== "0" ? formatTs(compliance.revokedAt) : "never"}</dd>
            <dt>Revocation count</dt>
            <dd>{compliance.revocationCount}</dd>
          </dl>
        )}
      </section>

      <section className="panel">
        <h3 className="panel__title">Pending approvals</h3>
        <p className="hint-text mt-3">
          revokeIdentity and reclaimAsset require 2-of-N co-signer approval (see RoleRegistry's
          CO_SIGNER_ROLE) - proposing one below only creates a proposal here. A different
          co-signer (not the proposer) must approve it before it takes effect.
        </p>
        <button className="btn btn--secondary btn--sm mt-3" onClick={loadPendingApprovals} disabled={pendingLoading}>
          {pendingLoading ? "Loading..." : "Refresh"}
        </button>
        {pendingApprovals.length === 0 ? (
          <p className="text-muted mt-3">No pending proposals.</p>
        ) : (
          <ul className="item-list mt-3">
            {pendingApprovals.map((p) => {
              const isProposer = address && p.proposer.toLowerCase() === address.toLowerCase();
              const alreadyApproved = approvedByMe.has(p.proposalId);
              const canApprove = roles.isCoSigner && !isProposer && !alreadyApproved;
              return (
                <li key={p.proposalId} className="item-list__row">
                  <div>
                    <strong>#{p.proposalId}</strong> <span className="badge badge--neutral">{p.actionType}</span>
                    {p.actionType === "RevokeIdentity" && <span> — revoke <span className="mono">{p.account}</span></span>}
                    {p.actionType === "ReclaimAsset" && (
                      <span> — reclaim #{p.tokenId} to <span className="mono">{p.newOwner}</span></span>
                    )}
                  </div>
                  <div className="small-text mt-3">
                    Proposed by <span className="mono">{p.proposer}</span> at {new Date(Number(p.proposedAt) * 1000).toLocaleString()}
                    {" — "}
                    <span className="badge badge--pending">{p.approvalCount}/{p.requiredApprovals} approvals</span>
                    {isProposer && " (you proposed this)"}
                    {!isProposer && alreadyApproved && " (you already approved)"}
                  </div>
                  {canApprove && (
                    <button className="btn btn--sm mt-3" onClick={() => handleApprove(p)} disabled={approveBusyId === p.proposalId}>
                      {approveBusyId === p.proposalId ? "Approving..." : "Approve"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {approveStatus && <p className="alert alert--success mt-3">{approveStatus}</p>}
      </section>

      {roles.isAdmin && (
        <section className="panel">
          <h3 className="panel__title">Register identity</h3>
          <p className="hint-text mt-3">
            Submits a registration signed by someone else - paste the signature (and the
            exact account/DID/metadata URI it was signed for) from the Identity tab's
            "Generate signature" flow on *their* wallet, or from scripts/signRegistration.js.
            The signature must match these fields exactly or the on-chain check rejects it.
          </p>
          <form onSubmit={handleRegister} className="mt-3">
            <label className="field">
              <span className="field__label-text">Account</span>
              <input className="mono-input" value={regAccount} onChange={(e) => setRegAccount(e.target.value)} placeholder="0x..." required />
            </label>
            <label className="field">
              <span className="field__label-text">DID</span>
              <input value={regDid} onChange={(e) => setRegDid(e.target.value)} placeholder="did:ethr:0x..." required />
            </label>
            <label className="field">
              <span className="field__label-text">Metadata URI</span>
              <input value={regUri} onChange={(e) => setRegUri(e.target.value)} placeholder="ipfs://..." required />
            </label>
            <label className="field field--wide">
              <span className="field__label-text">Signature</span>
              <textarea
                className="mono-input"
                value={regSignature}
                onChange={(e) => setRegSignature(e.target.value)}
                placeholder="0x..."
                rows={2}
                required
              />
            </label>
            <button type="submit" className="btn" disabled={regBusy}>{regBusy ? "Registering..." : "Register"}</button>
          </form>
          {regStatus && <p className="alert alert--success mt-3">{regStatus}</p>}
        </section>
      )}

      {roles.isCoSigner && (
        <>
          <section className="panel">
            <h3 className="panel__title">Propose: revoke identity</h3>
            <p className="hint-text mt-3">
              Requires a second, different co-signer's approval below before this takes effect
              - see "Pending approvals" above.
            </p>
            <form onSubmit={handleRevoke} className="mt-3">
              <label className="field">
                <span className="field__label-text">Address</span>
                <input className="mono-input" value={revokeAddress} onChange={(e) => setRevokeAddress(e.target.value)} placeholder="0x..." required />
              </label>
              <button type="submit" className="btn btn--danger" disabled={revokeBusy}>{revokeBusy ? "Proposing..." : "Propose revoke"}</button>
            </form>
            {revokeStatus && <p className="alert alert--success mt-3">{revokeStatus}</p>}
          </section>

          <section className="panel">
            <h3 className="panel__title">Propose: reclaim asset (revoked identity only)</h3>
            <p className="hint-text mt-3">
              Requires a second, different co-signer's approval below before this takes effect
              - see "Pending approvals" above.
            </p>
            <form onSubmit={handleReclaim} className="field-row mt-3">
              <label className="field" style={{ marginBottom: 0 }}>
                <span className="field__label-text">Token ID</span>
                <input value={reclaimTokenId} onChange={(e) => setReclaimTokenId(e.target.value)} required />
              </label>
              <label className="field" style={{ marginBottom: 0 }}>
                <span className="field__label-text">New owner</span>
                <input className="mono-input" value={reclaimNewOwner} onChange={(e) => setReclaimNewOwner(e.target.value)} placeholder="0x..." required />
              </label>
              <button type="submit" className="btn btn--danger" disabled={reclaimBusy}>{reclaimBusy ? "Proposing..." : "Propose reclaim"}</button>
            </form>
            {reclaimStatus && <p className="alert alert--success mt-3">{reclaimStatus}</p>}
          </section>
        </>
      )}
    </div>
  );
}

function formatTs(seconds) {
  return new Date(Number(seconds) * 1000).toLocaleString();
}

const ACTION_TYPE_NAMES = ["RevokeIdentity", "ReclaimAsset"];

function mono(value) {
  return <span className="mono">{value}</span>;
}

function describeEntry(entry) {
  switch (entry.type) {
    case "IdentityRegistered":
      return <>{mono(entry.account)} — {entry.did}</>;
    case "IdentityRevoked":
      return <>{mono(entry.account)} — revoked</>;
    case "AssetMinted":
      return <>#{entry.tokenId} → {mono(entry.owner)}</>;
    case "AssetTransferred":
      return <>#{entry.tokenId}: {mono(entry.from)} → {mono(entry.to)}</>;
    case "AssetReclaimed":
      return <>#{entry.tokenId}: {mono(entry.from)} → {mono(entry.to)} (reclaimed)</>;
    case "PlatformPaused":
      return <>Asset operations paused by {mono(entry.admin)}</>;
    case "PlatformUnpaused":
      return <>Asset operations unpaused by {mono(entry.admin)}</>;
    case "IdentityRegistryPaused":
      return <>Identity operations paused by {mono(entry.admin)}</>;
    case "IdentityRegistryUnpaused":
      return <>Identity operations unpaused by {mono(entry.admin)}</>;
    case "ActionProposed":
      return <>#{entry.proposalId} {ACTION_TYPE_NAMES[entry.actionType] ?? entry.actionType} proposed by {mono(entry.proposer)}</>;
    case "ActionApproved":
      return <>#{entry.proposalId} approved by {mono(entry.approver)} ({entry.approvalCount}/2)</>;
    case "ActionExecuted":
      return <>#{entry.proposalId} executed</>;
    default:
      return JSON.stringify(entry);
  }
}
