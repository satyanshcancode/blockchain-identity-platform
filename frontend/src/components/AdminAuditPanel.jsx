import React, { useCallback, useEffect, useState } from "react";
import { useWallet } from "../context/WalletContext";
import { getAuditLog, getAssetHistory, getComplianceRecord, getPendingApprovals } from "../services/api";
import {
  registerIdentity,
  revokeIdentity,
  reclaimAsset,
  approveRevokeIdentity,
  approveReclaimAsset,
  hasApproved,
  pausePlatform,
  unpausePlatform,
  getPaused
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

  const [paused, setPausedState] = useState(null);
  const [pauseBusy, setPauseBusy] = useState(false);
  const [pauseStatus, setPauseStatus] = useState(null);

  const [pendingApprovals, setPendingApprovals] = useState([]);
  const [pendingLoading, setPendingLoading] = useState(false);
  const [approvedByMe, setApprovedByMe] = useState(new Set());
  const [approveBusyId, setApproveBusyId] = useState(null);
  const [approveStatus, setApproveStatus] = useState(null);

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
    setAuditLoading(true);
    setError(null);
    try {
      setAuditLog(await getAuditLog());
    } catch (err) {
      setError(err.message);
    } finally {
      setAuditLoading(false);
    }
  };

  const loadPaused = useCallback(async () => {
    if (!roles.isAdmin) return;
    try {
      setPausedState(await getPaused(signer));
    } catch (err) {
      setError(err.message);
    }
  }, [roles.isAdmin, signer]);

  // Which pending proposals the CONNECTED wallet has already approved - the
  // backend's list doesn't include this (it's per-viewer, not indexed audit
  // data), so it's fetched live via the same on-chain-read-through-the-
  // connected-wallet exception role checks and getPaused() already use. Only
  // bothers making those calls for a co-signer, since only a co-signer could
  // ever see the Approve button anyway.
  const loadPendingApprovals = useCallback(async () => {
    setPendingLoading(true);
    try {
      const list = await getPendingApprovals();
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

  useEffect(() => {
    loadAuditLog();
    loadPaused();
    loadPendingApprovals();
  }, [loadPaused, loadPendingApprovals]);

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
    setComplianceBusy(true);
    setError(null);
    try {
      setCompliance(await getComplianceRecord(complianceAddress));
    } catch (err) {
      setError(err.message);
    } finally {
      setComplianceBusy(false);
    }
  };

  const handleRegister = async (e) => {
    e.preventDefault();
    setRegBusy(true);
    setRegStatus(null);
    setError(null);
    try {
      await registerIdentity(signer, regAccount, regDid, regUri, regSignature);
      setRegStatus(`Identity registered for ${regAccount}.`);
      setRegAccount("");
      setRegDid("");
      setRegUri("");
      setRegSignature("");
      await loadAuditLog();
    } catch (err) {
      setError(err.message);
    } finally {
      setRegBusy(false);
    }
  };

  const handleRevoke = async (e) => {
    e.preventDefault();
    setRevokeBusy(true);
    setRevokeStatus(null);
    setError(null);
    try {
      await revokeIdentity(signer, revokeAddress);
      setRevokeStatus(
        `Proposed revoking ${revokeAddress} - needs one more co-signer's approval below before it takes effect.`
      );
      setRevokeAddress("");
      await loadAuditLog();
      await loadPendingApprovals();
    } catch (err) {
      setError(err.message);
    } finally {
      setRevokeBusy(false);
    }
  };

  const handleReclaim = async (e) => {
    e.preventDefault();
    setReclaimBusy(true);
    setReclaimStatus(null);
    setError(null);
    try {
      await reclaimAsset(signer, reclaimTokenId, reclaimNewOwner);
      setReclaimStatus(
        `Proposed reclaiming #${reclaimTokenId} to ${reclaimNewOwner} - needs one more co-signer's approval below before it takes effect.`
      );
      setReclaimTokenId("");
      setReclaimNewOwner("");
      await loadAuditLog();
      await loadPendingApprovals();
    } catch (err) {
      setError(err.message);
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
      setApproveStatus(`Approved proposal #${proposal.proposalId}.`);
      await loadPendingApprovals();
      await loadAuditLog();
    } catch (err) {
      setError(err.message);
    } finally {
      setApproveBusyId(null);
    }
  };

  const handlePauseToggle = async () => {
    setPauseBusy(true);
    setPauseStatus(null);
    setError(null);
    try {
      if (paused) {
        await unpausePlatform(signer);
        setPauseStatus("Platform unpaused.");
      } else {
        await pausePlatform(signer);
        setPauseStatus("Platform paused - minting, transfers, and reclaims are now blocked.");
      }
      await loadPaused();
      await loadAuditLog();
    } catch (err) {
      setError(err.message);
    } finally {
      setPauseBusy(false);
    }
  };

  return (
    <div style={box}>
      <h2>Admin / audit panel</h2>
      {error && <p style={styles.error}>{error}</p>}

      {roles.isAdmin && paused != null && (
        <section style={paused ? styles.pausedBanner : styles.activeBanner}>
          <div style={styles.pausedBannerTitle}>
            {paused ? "⛔ PLATFORM PAUSED" : "✅ Platform active"}
          </div>
          <p style={{ margin: "4px 0 8px" }}>
            {paused
              ? "Minting, transfers, and reclaims are blocked platform-wide until unpaused."
              : "Minting, transfers, and reclaims are operating normally."}
          </p>
          <button onClick={handlePauseToggle} disabled={pauseBusy}>
            {pauseBusy ? "Submitting..." : paused ? "Unpause platform" : "Pause platform"}
          </button>
          {pauseStatus && <p>{pauseStatus}</p>}
        </section>
      )}

      <section style={section}>
        <h3>Audit log</h3>
        <button onClick={loadAuditLog} disabled={auditLoading}>{auditLoading ? "Loading..." : "Refresh"}</button>
        <div style={styles.scroll}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Type</th>
                <th style={styles.th}>Details</th>
                <th style={styles.th}>Time</th>
              </tr>
            </thead>
            <tbody>
              {auditLog.map((entry, i) => (
                <tr key={i}>
                  <td style={styles.td}>{entry.type}</td>
                  <td style={styles.td}>{describeEntry(entry)}</td>
                  <td style={styles.td}>{new Date(entry.ts).toLocaleString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      <section style={section}>
        <h3>Per-token transfer history</h3>
        <form onSubmit={handleHistoryLookup}>
          <label>
            Token ID:{" "}
            <input value={historyTokenId} onChange={(e) => setHistoryTokenId(e.target.value)} required />
          </label>
          <button type="submit" disabled={historyBusy}>{historyBusy ? "Looking up..." : "Lookup"}</button>
        </form>
        {history && (
          <ul>
            {history.map((h, i) => (
              <li key={i}>
                {h.from} → {h.to} at {new Date(Number(h.timestamp) * 1000).toLocaleString()}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section style={section}>
        <h3>Per-identity compliance record</h3>
        <form onSubmit={handleComplianceLookup}>
          <label>
            Address:{" "}
            <input value={complianceAddress} onChange={(e) => setComplianceAddress(e.target.value)} placeholder="0x..." required />
          </label>
          <button type="submit" disabled={complianceBusy}>{complianceBusy ? "Looking up..." : "Lookup"}</button>
        </form>
        {compliance && (
          <ul>
            <li>Registered at: {formatTs(compliance.registeredAt)}</li>
            <li>Last updated at: {formatTs(compliance.lastUpdatedAt)}</li>
            <li>Revoked at: {compliance.revokedAt !== "0" ? formatTs(compliance.revokedAt) : "never"}</li>
            <li>Revocation count: {compliance.revocationCount}</li>
          </ul>
        )}
      </section>

      <section style={section}>
        <h3>Pending approvals</h3>
        <p style={styles.hint}>
          revokeIdentity and reclaimAsset require 2-of-N co-signer approval (see RoleRegistry's
          CO_SIGNER_ROLE) - proposing one below only creates a proposal here. A different
          co-signer (not the proposer) must approve it before it takes effect.
        </p>
        <button onClick={loadPendingApprovals} disabled={pendingLoading}>
          {pendingLoading ? "Loading..." : "Refresh"}
        </button>
        {pendingApprovals.length === 0 ? (
          <p>No pending proposals.</p>
        ) : (
          <ul>
            {pendingApprovals.map((p) => {
              const isProposer = address && p.proposer.toLowerCase() === address.toLowerCase();
              const alreadyApproved = approvedByMe.has(p.proposalId);
              const canApprove = roles.isCoSigner && !isProposer && !alreadyApproved;
              return (
                <li key={p.proposalId} style={{ marginBottom: 12 }}>
                  <div>
                    <strong>#{p.proposalId} {p.actionType}</strong>
                    {p.actionType === "RevokeIdentity" && <span> — revoke {p.account}</span>}
                    {p.actionType === "ReclaimAsset" && (
                      <span> — reclaim #{p.tokenId} to {p.newOwner}</span>
                    )}
                  </div>
                  <div style={styles.small}>
                    Proposed by {p.proposer} at {new Date(Number(p.proposedAt) * 1000).toLocaleString()}
                    {" — "}
                    {p.approvalCount}/{p.requiredApprovals} approvals
                    {isProposer && " (you proposed this)"}
                    {!isProposer && alreadyApproved && " (you already approved)"}
                  </div>
                  {canApprove && (
                    <button onClick={() => handleApprove(p)} disabled={approveBusyId === p.proposalId}>
                      {approveBusyId === p.proposalId ? "Approving..." : "Approve"}
                    </button>
                  )}
                </li>
              );
            })}
          </ul>
        )}
        {approveStatus && <p>{approveStatus}</p>}
      </section>

      {roles.isAdmin && (
        <section style={section}>
          <h3>Register identity</h3>
          <p style={styles.hint}>
            Submits a registration signed by someone else - paste the signature (and the
            exact account/DID/metadata URI it was signed for) from the Identity tab's
            "Generate signature" flow on *their* wallet, or from scripts/signRegistration.js.
            The signature must match these fields exactly or the on-chain check rejects it.
          </p>
          <form onSubmit={handleRegister}>
            <div>
              <label>
                Account:{" "}
                <input value={regAccount} onChange={(e) => setRegAccount(e.target.value)} placeholder="0x..." required />
              </label>
            </div>
            <div>
              <label>
                DID:{" "}
                <input value={regDid} onChange={(e) => setRegDid(e.target.value)} placeholder="did:ethr:0x..." required />
              </label>
            </div>
            <div>
              <label>
                Metadata URI:{" "}
                <input value={regUri} onChange={(e) => setRegUri(e.target.value)} placeholder="ipfs://..." required />
              </label>
            </div>
            <div>
              <label>
                Signature:{" "}
                <textarea
                  value={regSignature}
                  onChange={(e) => setRegSignature(e.target.value)}
                  placeholder="0x..."
                  rows={2}
                  style={styles.textarea}
                  required
                />
              </label>
            </div>
            <button type="submit" disabled={regBusy}>{regBusy ? "Registering..." : "Register"}</button>
          </form>
          {regStatus && <p>{regStatus}</p>}
        </section>
      )}

      {roles.isCoSigner && (
        <>
          <section style={section}>
            <h3>Propose: revoke identity</h3>
            <p style={styles.hint}>
              Requires a second, different co-signer's approval below before this takes effect
              - see "Pending approvals" above.
            </p>
            <form onSubmit={handleRevoke}>
              <label>
                Address:{" "}
                <input value={revokeAddress} onChange={(e) => setRevokeAddress(e.target.value)} placeholder="0x..." required />
              </label>
              <button type="submit" disabled={revokeBusy}>{revokeBusy ? "Proposing..." : "Propose revoke"}</button>
            </form>
            {revokeStatus && <p>{revokeStatus}</p>}
          </section>

          <section style={section}>
            <h3>Propose: reclaim asset (revoked identity only)</h3>
            <p style={styles.hint}>
              Requires a second, different co-signer's approval below before this takes effect
              - see "Pending approvals" above.
            </p>
            <form onSubmit={handleReclaim}>
              <label>
                Token ID:{" "}
                <input value={reclaimTokenId} onChange={(e) => setReclaimTokenId(e.target.value)} required />
              </label>{" "}
              <label>
                New owner:{" "}
                <input value={reclaimNewOwner} onChange={(e) => setReclaimNewOwner(e.target.value)} placeholder="0x..." required />
              </label>
              <button type="submit" disabled={reclaimBusy}>{reclaimBusy ? "Proposing..." : "Propose reclaim"}</button>
            </form>
            {reclaimStatus && <p>{reclaimStatus}</p>}
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

function describeEntry(entry) {
  switch (entry.type) {
    case "IdentityRegistered":
      return `${entry.account} — ${entry.did}`;
    case "IdentityRevoked":
      return `${entry.account} — revoked`;
    case "AssetMinted":
      return `#${entry.tokenId} → ${entry.owner}`;
    case "AssetTransferred":
      return `#${entry.tokenId}: ${entry.from} → ${entry.to}`;
    case "AssetReclaimed":
      return `#${entry.tokenId}: ${entry.from} → ${entry.to} (reclaimed)`;
    case "PlatformPaused":
      return `Paused by ${entry.admin}`;
    case "PlatformUnpaused":
      return `Unpaused by ${entry.admin}`;
    case "ActionProposed":
      return `#${entry.proposalId} ${ACTION_TYPE_NAMES[entry.actionType] ?? entry.actionType} proposed by ${entry.proposer}`;
    case "ActionApproved":
      return `#${entry.proposalId} approved by ${entry.approver} (${entry.approvalCount}/2)`;
    case "ActionExecuted":
      return `#${entry.proposalId} executed`;
    default:
      return JSON.stringify(entry);
  }
}

const box = { border: "1px solid #ccc", padding: 16, marginBottom: 16 };
const section = { marginTop: 16, paddingTop: 16, borderTop: "1px solid #eee" };
const styles = {
  error: { color: "#b00020" },
  hint: { fontSize: 13, color: "#555" },
  small: { fontSize: 12, color: "#555" },
  scroll: { maxHeight: 240, overflowY: "auto" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", borderBottom: "1px solid #ccc", padding: "4px 8px", position: "sticky", top: 0, background: "#fff" },
  td: { borderBottom: "1px solid #eee", padding: "4px 8px" },
  textarea: { width: "100%", fontFamily: "monospace", fontSize: 12, display: "block" },
  pausedBannerTitle: { fontSize: 20, fontWeight: "bold" },
  pausedBanner: {
    background: "#fdeaea",
    border: "2px solid #b00020",
    color: "#7a0016",
    padding: 16,
    borderRadius: 4,
    marginBottom: 16
  },
  activeBanner: {
    background: "#eaf7ea",
    border: "2px solid #1a7a1a",
    color: "#14591a",
    padding: 16,
    borderRadius: 4,
    marginBottom: 16
  }
};
