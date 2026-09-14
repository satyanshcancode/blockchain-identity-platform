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
    <div className="verify-page">
      <div className="verify-card">
        <div className="verify-card__header">
          <div className="verify-card__eyebrow">Authenticated ownership &amp; transfer record</div>
          <h1 className="verify-card__title">Asset #{tokenId}</h1>
        </div>
        <div className="verify-card__body">
          {loading && <p className="text-muted">Loading...</p>}

          {notFound && (
            <p className="alert alert--error">No asset with token ID "{tokenId}" exists on this platform.</p>
          )}

          {error && <p className="alert alert--error">{error}</p>}

          {!loading && !notFound && !error && asset && (
            <>
              {ownerIdentity && !ownerIdentity.active && (
                <div className="banner banner--critical">
                  <div className="banner__body">
                    ⚠ This asset's current holder has a <strong>revoked</strong> identity.
                  </div>
                </div>
              )}

              <section className="verify-section">
                <h2 className="verify-section__title">Current status</h2>
                <dl className="kv-list">
                  <dt>Owner</dt>
                  <dd>{asset.owner}</dd>
                  <dt>Metadata URI</dt>
                  <dd>{asset.uri}</dd>
                  {ownerIdentity && (
                    <>
                      <dt>Owner identity</dt>
                      <dd>
                        {ownerIdentity.did || "(unregistered)"}{" "}
                        <span className={`badge ${ownerIdentity.active ? "badge--active" : "badge--revoked"}`}>
                          {ownerIdentity.active ? "Active" : "Revoked"}
                        </span>
                      </dd>
                    </>
                  )}
                </dl>
              </section>

              <section className="verify-section">
                <h2 className="verify-section__title">Full history</h2>
                {history && history.length > 0 ? (
                  <ol className="history-list">
                    {history.map((h, i) => (
                      <li key={i} className="history-item">
                        {h.from === "0x0000000000000000000000000000000000000000" ? (
                          <span>Minted to <span className="mono">{h.to}</span></span>
                        ) : (
                          <span>Transferred: <span className="mono">{h.from}</span> → <span className="mono">{h.to}</span></span>
                        )}
                        <div className="history-item__ts">{formatTs(h.timestamp)}</div>
                      </li>
                    ))}
                  </ol>
                ) : (
                  <p className="text-muted">No history available.</p>
                )}
              </section>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function formatTs(seconds) {
  return new Date(Number(seconds) * 1000).toLocaleString();
}
