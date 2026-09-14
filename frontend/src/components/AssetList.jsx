import React, { useCallback, useEffect, useState } from "react";
import { QRCodeSVG } from "qrcode.react";
import { useWallet } from "../context/WalletContext";
import { getAssets, getAssetsByOwner } from "../services/api";
import { mintAsset, transferAsset } from "../services/contractService";

// window.location.origin so the URL is absolute and actually reachable when
// scanned from a phone (a QR code has no notion of "relative to this app"),
// not just a path for in-app navigation.
function verifyUrl(tokenId) {
  return `${window.location.origin}/verify/${tokenId}`;
}

export default function AssetList() {
  const { address, signer, roles } = useWallet();
  const [assets, setAssets] = useState([]);
  const [mineOnly, setMineOnly] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [mintTo, setMintTo] = useState("");
  const [mintUri, setMintUri] = useState("");
  const [mintBusy, setMintBusy] = useState(false);
  const [mintStatus, setMintStatus] = useState(null);

  const [transferTargets, setTransferTargets] = useState({});
  const [transferBusyId, setTransferBusyId] = useState(null);
  const [transferStatus, setTransferStatus] = useState(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setAssets(mineOnly && address ? await getAssetsByOwner(address) : await getAssets());
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [mineOnly, address]);

  useEffect(() => {
    load();
  }, [load]);

  const canMint = roles.isAdmin || roles.isManager;

  const handleMint = async (e) => {
    e.preventDefault();
    setMintBusy(true);
    setMintStatus(null);
    setError(null);
    try {
      await mintAsset(signer, mintTo, mintUri);
      setMintStatus("Asset minted. It may take a few seconds to appear below - reload if it doesn't yet.");
      setMintTo("");
      setMintUri("");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setMintBusy(false);
    }
  };

  const handleTransfer = async (tokenId) => {
    const to = transferTargets[tokenId];
    if (!to) return;
    setTransferBusyId(tokenId);
    setTransferStatus(null);
    setError(null);
    try {
      await transferAsset(signer, to, tokenId);
      setTransferStatus(`Asset #${tokenId} transferred. It may take a few seconds to update below - reload if it doesn't yet.`);
      setTransferTargets((prev) => ({ ...prev, [tokenId]: "" }));
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setTransferBusyId(null);
    }
  };

  return (
    <div className="panel">
      <h2 className="page-title">Assets</h2>
      <div className="toolbar">
        <label className="checkbox-field">
          <input
            type="checkbox"
            checked={mineOnly}
            onChange={(e) => setMineOnly(e.target.checked)}
            disabled={!address}
          />
          My assets only
        </label>
        <button className="btn btn--secondary btn--sm" onClick={load} disabled={loading}>
          {loading ? "Loading..." : "Refresh"}
        </button>
      </div>

      {error && <p className="alert alert--error">{error}</p>}

      {assets.length === 0 && !loading ? (
        <p className="text-muted">No assets found.</p>
      ) : (
        <div className="table-scroll">
          <table className="data-table">
            <thead>
              <tr>
                <th>Token ID</th>
                <th>Owner</th>
                <th>Metadata URI</th>
                <th>Verify</th>
                {address && roles.isUser && <th>Transfer</th>}
              </tr>
            </thead>
            <tbody>
              {assets.map((asset) => {
                const isMine = address && asset.owner.toLowerCase() === address.toLowerCase();
                return (
                  <tr key={asset.tokenId}>
                    <td>{asset.tokenId}</td>
                    <td className="mono">{asset.owner}</td>
                    <td className="mono">{asset.uri}</td>
                    <td>
                      <div className="verify-cell">
                        <a href={verifyUrl(asset.tokenId)} target="_blank" rel="noreferrer">
                          Verify
                        </a>
                        <QRCodeSVG value={verifyUrl(asset.tokenId)} size={64} />
                      </div>
                    </td>
                    {address && roles.isUser && (
                      <td>
                        {isMine && (
                          <div className="inline-form">
                            <input
                              className="mono-input"
                              placeholder="recipient address"
                              value={transferTargets[asset.tokenId] || ""}
                              onChange={(e) =>
                                setTransferTargets((prev) => ({ ...prev, [asset.tokenId]: e.target.value }))
                              }
                            />
                            <button
                              className="btn btn--sm"
                              onClick={() => handleTransfer(asset.tokenId)}
                              disabled={transferBusyId === asset.tokenId || !transferTargets[asset.tokenId]}
                            >
                              {transferBusyId === asset.tokenId ? "Sending..." : "Transfer"}
                            </button>
                          </div>
                        )}
                      </td>
                    )}
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
      {transferStatus && <p className="alert alert--success mt-3">{transferStatus}</p>}

      {canMint && (
        <form onSubmit={handleMint} className="subsection">
          <h3 className="subsection__title">Mint asset</h3>
          <label className="field">
            <span className="field__label-text">Recipient address</span>
            <input className="mono-input" value={mintTo} onChange={(e) => setMintTo(e.target.value)} placeholder="0x..." required />
          </label>
          <label className="field">
            <span className="field__label-text">Metadata URI</span>
            <input value={mintUri} onChange={(e) => setMintUri(e.target.value)} placeholder="ipfs://..." required />
          </label>
          <button type="submit" className="btn" disabled={mintBusy}>{mintBusy ? "Minting..." : "Mint"}</button>
          {mintStatus && <p className="alert alert--success mt-3">{mintStatus}</p>}
        </form>
      )}
    </div>
  );
}
