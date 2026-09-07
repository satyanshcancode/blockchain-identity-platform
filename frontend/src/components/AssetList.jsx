import React, { useCallback, useEffect, useState } from "react";
import { useWallet } from "../context/WalletContext";
import { getAssets, getAssetsByOwner } from "../services/api";
import { mintAsset, transferAsset } from "../services/contractService";

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
    <div style={box}>
      <h2>Assets</h2>
      <div style={{ marginBottom: 8 }}>
        <label>
          <input
            type="checkbox"
            checked={mineOnly}
            onChange={(e) => setMineOnly(e.target.checked)}
            disabled={!address}
          />{" "}
          My assets only
        </label>
        {" "}
        <button onClick={load} disabled={loading}>{loading ? "Loading..." : "Refresh"}</button>
      </div>

      {error && <p style={styles.error}>{error}</p>}

      {assets.length === 0 && !loading ? (
        <p>No assets found.</p>
      ) : (
        <table style={styles.table}>
          <thead>
            <tr>
              <th style={styles.th}>Token ID</th>
              <th style={styles.th}>Owner</th>
              <th style={styles.th}>Metadata URI</th>
              {address && roles.isUser && <th style={styles.th}>Transfer</th>}
            </tr>
          </thead>
          <tbody>
            {assets.map((asset) => {
              const isMine = address && asset.owner.toLowerCase() === address.toLowerCase();
              return (
                <tr key={asset.tokenId}>
                  <td style={styles.td}>{asset.tokenId}</td>
                  <td style={styles.td}>{asset.owner}</td>
                  <td style={styles.td}>{asset.uri}</td>
                  {address && roles.isUser && (
                    <td style={styles.td}>
                      {isMine && (
                        <>
                          <input
                            placeholder="recipient address"
                            value={transferTargets[asset.tokenId] || ""}
                            onChange={(e) =>
                              setTransferTargets((prev) => ({ ...prev, [asset.tokenId]: e.target.value }))
                            }
                            style={{ width: 160 }}
                          />
                          <button
                            onClick={() => handleTransfer(asset.tokenId)}
                            disabled={transferBusyId === asset.tokenId || !transferTargets[asset.tokenId]}
                          >
                            {transferBusyId === asset.tokenId ? "Sending..." : "Transfer"}
                          </button>
                        </>
                      )}
                    </td>
                  )}
                </tr>
              );
            })}
          </tbody>
        </table>
      )}
      {transferStatus && <p>{transferStatus}</p>}

      {canMint && (
        <form onSubmit={handleMint} style={{ marginTop: 16 }}>
          <h3>Mint asset</h3>
          <div>
            <label>
              Recipient address:{" "}
              <input value={mintTo} onChange={(e) => setMintTo(e.target.value)} placeholder="0x..." required />
            </label>
          </div>
          <div>
            <label>
              Metadata URI:{" "}
              <input value={mintUri} onChange={(e) => setMintUri(e.target.value)} placeholder="ipfs://..." required />
            </label>
          </div>
          <button type="submit" disabled={mintBusy}>{mintBusy ? "Minting..." : "Mint"}</button>
          {mintStatus && <p>{mintStatus}</p>}
        </form>
      )}
    </div>
  );
}

const box = { border: "1px solid #ccc", padding: 16, marginBottom: 16 };
const styles = {
  error: { color: "#b00020" },
  table: { width: "100%", borderCollapse: "collapse" },
  th: { textAlign: "left", borderBottom: "1px solid #ccc", padding: "4px 8px" },
  td: { borderBottom: "1px solid #eee", padding: "4px 8px" }
};
