import React, { useEffect, useState } from "react";
import { getAsset, getAssetHistory, getIdentity } from "../services/api";

// Public, wallet-free verification page - deliberately does NOT import or
// use WalletContext/useWallet. Anyone (no MetaMask, never touched crypto,
// scanning a QR code on a phone) must be able to load this and see an
// asset's authenticated history using only the backend's read API. See
// backend/src/routes/assets.js's getPrivilegedContract() - the
// auditor/admin-gated history read is signed with the backend's OWN key,
// not the visitor's, which is exactly what makes that true.
export default function VerifyPage({ tokenId }) {
  const [asset, setAsset] = useState(null);
  const [history, setHistory] = useState(null);
  const [ownerIdentity, setOwnerIdentity] = useState(null);
  const [loading, setLoading] = useState(true);
  const [notFound, setNotFound] = useState(false);
  const [error, setError] = useState(null);

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      setNotFound(false);
      setError(null);
      try {
        const assetData = await getAsset(tokenId);
        if (cancelled) return;
        setAsset(assetData);

        const [historyData, identityData] = await Promise.all([
          getAssetHistory(tokenId),
          getIdentity(assetData.owner)
        ]);
        if (cancelled) return;
        setHistory(historyData);
        setOwnerIdentity(identityData);
      } catch (err) {
        if (cancelled) return;
        if (/not found/i.test(err.message)) {
          setNotFound(true);
        } else {
          setError(err.message);
        }
      } finally {
        if (!cancelled) setLoading(false);
      }
    }

    load();
    return () => {
      cancelled = true;
    };
  }, [tokenId]);

  return (
    <div style={styles.page}>
      <div style={styles.card}>
        <h1 style={styles.title}>Asset #{tokenId}</h1>
        <p style={styles.subtitle}>Authenticated ownership &amp; transfer record</p>

        {loading && <p>Loading...</p>}

        {notFound && (
          <p style={styles.notFound}>No asset with token ID "{tokenId}" exists on this platform.</p>
        )}

        {error && <p style={styles.error}>{error}</p>}

        {!loading && !notFound && !error && asset && (
          <>
            {ownerIdentity && !ownerIdentity.active && (
              <div style={styles.warning}>
                ⚠ This asset's current holder has a <strong>revoked</strong> identity.
              </div>
            )}

            <section style={styles.section}>
              <h2 style={styles.h2}>Current status</h2>
              <dl style={styles.dl}>
                <dt style={styles.dt}>Owner</dt>
                <dd style={styles.dd}>{asset.owner}</dd>
                <dt style={styles.dt}>Metadata URI</dt>
                <dd style={styles.dd}>{asset.uri}</dd>
                {ownerIdentity && (
                  <>
                    <dt style={styles.dt}>Owner identity</dt>
                    <dd style={styles.dd}>
                      {ownerIdentity.did || "(unregistered)"} —{" "}
                      <strong style={ownerIdentity.active ? styles.active : styles.revoked}>
                        {ownerIdentity.active ? "Active" : "Revoked"}
                      </strong>
                    </dd>
                  </>
                )}
              </dl>
            </section>

            <section style={styles.section}>
              <h2 style={styles.h2}>Full history</h2>
              {history && history.length > 0 ? (
                <ol style={styles.history}>
                  {history.map((h, i) => (
                    <li key={i} style={styles.historyItem}>
                      {h.from === "0x0000000000000000000000000000000000000000" ? (
                        <span>Minted to {h.to}</span>
                      ) : (
                        <span>Transferred: {h.from} → {h.to}</span>
                      )}
                      <div style={styles.timestamp}>{formatTs(h.timestamp)}</div>
                    </li>
                  ))}
                </ol>
              ) : (
                <p>No history available.</p>
              )}
            </section>
          </>
        )}
      </div>
    </div>
  );
}

function formatTs(seconds) {
  return new Date(Number(seconds) * 1000).toLocaleString();
}

const styles = {
  page: { fontFamily: "sans-serif", minHeight: "100vh", background: "#f7f7f7", padding: 24 },
  card: { maxWidth: 640, margin: "0 auto", background: "#fff", border: "1px solid #ccc", borderRadius: 8, padding: 24 },
  title: { margin: "0 0 4px" },
  subtitle: { margin: "0 0 16px", color: "#666", fontSize: 14 },
  section: { marginTop: 20, paddingTop: 20, borderTop: "1px solid #eee" },
  h2: { fontSize: 16, margin: "0 0 8px" },
  dl: { margin: 0 },
  dt: { fontSize: 12, color: "#666", marginTop: 8 },
  dd: { margin: "2px 0 0", wordBreak: "break-all" },
  history: { paddingLeft: 20, margin: 0 },
  historyItem: { marginBottom: 10, wordBreak: "break-all" },
  timestamp: { fontSize: 12, color: "#666" },
  notFound: { color: "#b00020" },
  error: { color: "#b00020" },
  warning: {
    background: "#fff3cd",
    border: "1px solid #d1a300",
    color: "#7a5b00",
    padding: 12,
    borderRadius: 4,
    marginBottom: 16,
    fontWeight: "bold"
  },
  active: { color: "#1a7a1a" },
  revoked: { color: "#b00020" }
};
