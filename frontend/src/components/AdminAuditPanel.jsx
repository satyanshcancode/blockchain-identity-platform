import React, { useEffect, useState } from "react";
import { useWallet } from "../context/WalletContext";
import { getAuditLog, getAssetHistory, getComplianceRecord } from "../services/api";
import { revokeIdentity, reclaimAsset } from "../services/contractService";

// Rendered only if the connected wallet has ADMIN_ROLE or AUDITOR_ROLE - see
// App.jsx, which doesn't mount this component at all otherwise. The guard
// below is a defensive backstop in case that ever changes, not the primary
// gate: per the spec this panel must be hidden entirely, not just disabled.
export default function AdminAuditPanel() {
  const { signer, roles } = useWallet();

  const [auditLog, setAuditLog] = useState([]);
  const [auditLoading, setAuditLoading] = useState(false);
  const [error, setError] = useState(null);

  const [historyTokenId, setHistoryTokenId] = useState("");
  const [history, setHistory] = useState(null);
  const [historyBusy, setHistoryBusy] = useState(false);

  const [complianceAddress, setComplianceAddress] = useState("");
  const [compliance, setCompliance] = useState(null);
  const [complianceBusy, setComplianceBusy] = useState(false);

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

  useEffect(() => {
    loadAuditLog();
  }, []);

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

  const handleRevoke = async (e) => {
    e.preventDefault();
    setRevokeBusy(true);
    setRevokeStatus(null);
    setError(null);
    try {
      await revokeIdentity(signer, revokeAddress);
      setRevokeStatus(`Identity ${revokeAddress} revoked.`);
      setRevokeAddress("");
      await loadAuditLog();
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
      setReclaimStatus(`Asset #${reclaimTokenId} reclaimed to ${reclaimNewOwner}.`);
      setReclaimTokenId("");
      setReclaimNewOwner("");
      await loadAuditLog();
    } catch (err) {
      setError(err.message);
    } finally {
      setReclaimBusy(false);
    }
  };

  return (
    <div style={box}>
      <h2>Admin / audit panel</h2>
      {error && <p style={styles.error}>{error}</p>}

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

      {roles.isAdmin && (
        <>
          <section style={section}>
            <h3>Revoke identity</h3>
            <form onSubmit={handleRevoke}>
              <label>
                Address:{" "}
                <input value={revokeAddress} onChange={(e) => setRevokeAddress(e.target.value)} placeholder="0x..." required />
              </label>
              <button type="submit" disabled={revokeBusy}>{revokeBusy ? "Revoking..." : "Revoke"}</button>
            </form>
            {revokeStatus && <p>{revokeStatus}</p>}
          </section>

          <section style={section}>
            <h3>Reclaim asset (revoked identity only)</h3>
            <form onSubmit={handleReclaim}>
              <label>
                Token ID:{" "}
                <input value={reclaimTokenId} onChange={(e) => setReclaimTokenId(e.target.value)} required />
              </label>{" "}
              <label>
                New owner:{" "}
                <input value={reclaimNewOwner} onChange={(e) => setReclaimNewOwner(e.target.value)} placeholder="0x..." required />
              </label>
              <button type="submit" disabled={reclaimBusy}>{reclaimBusy ? "Reclaiming..." : "Reclaim"}</button>
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

function describeEntry(entry) {
  switch (entry.type) {
    case "IdentityRegistered":
      return `${entry.account} — ${entry.did}`;
    case "AssetMinted":
      return `#${entry.tokenId} → ${entry.owner}`;
    case "AssetTransferred":
      return `#${entry.tokenId}: ${entry.from} → ${entry.to}`;
    case "AssetReclaimed":
      return `#${entry.tokenId}: ${entry.from} → ${entry.to} (reclaimed)`;
    default:
      return JSON.stringify(entry);
  }
}

const box = { border: "1px solid #ccc", padding: 16, marginBottom: 16 };
const section = { marginTop: 16, paddingTop: 16, borderTop: "1px solid #eee" };
const styles = {
  error: { color: "#b00020" },
  scroll: { maxHeight: 240, overflowY: "auto" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", borderBottom: "1px solid #ccc", padding: "4px 8px", position: "sticky", top: 0, background: "#fff" },
  td: { borderBottom: "1px solid #eee", padding: "4px 8px" }
};
