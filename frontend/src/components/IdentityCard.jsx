import React, { useCallback, useEffect, useState } from "react";
import { useWallet } from "../context/WalletContext";
import { getIdentity } from "../services/api";
import { signRegistration, updateMetadata } from "../services/contractService";

export default function IdentityCard() {
  const { address, signer, roles } = useWallet();
  const [identity, setIdentity] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);

  const [regDid, setRegDid] = useState("");
  const [regUri, setRegUri] = useState("");
  const [regResult, setRegResult] = useState(null);
  const [regBusy, setRegBusy] = useState(false);

  const [metaUri, setMetaUri] = useState("");
  const [updateBusy, setUpdateBusy] = useState(false);
  const [updateStatus, setUpdateStatus] = useState(null);

  const load = useCallback(async () => {
    if (!address) return;
    setLoading(true);
    setError(null);
    try {
      setIdentity(await getIdentity(address));
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }, [address]);

  useEffect(() => {
    load();
    setRegResult(null);
    setUpdateStatus(null);
  }, [load]);

  if (!address) {
    return (
      <div style={box}>
        <h2>My identity</h2>
        <p>Connect your wallet to view your DID and credential status.</p>
      </div>
    );
  }

  const isRegistered = Boolean(identity && identity.active);

  const handleSign = async (e) => {
    e.preventDefault();
    setRegBusy(true);
    setError(null);
    try {
      setRegResult(await signRegistration(signer, { did: regDid, metadataURI: regUri }));
    } catch (err) {
      setError(err.message);
    } finally {
      setRegBusy(false);
    }
  };

  const handleUpdate = async (e) => {
    e.preventDefault();
    setUpdateBusy(true);
    setUpdateStatus(null);
    setError(null);
    try {
      await updateMetadata(signer, metaUri);
      setUpdateStatus("Metadata updated on-chain. It may take a few seconds to show below - reload if it doesn't yet.");
      setMetaUri("");
      await load();
    } catch (err) {
      setError(err.message);
    } finally {
      setUpdateBusy(false);
    }
  };

  return (
    <div style={box}>
      <h2>My identity</h2>
      {loading && <p>Loading...</p>}
      {error && <p style={styles.error}>{error}</p>}

      {isRegistered ? (
        <div>
          <p><strong>DID:</strong> {identity.did}</p>
          <p><strong>Metadata URI:</strong> {identity.metadataURI}</p>
          <p><strong>Status:</strong> Active</p>
        </div>
      ) : (
        <div>
          <p>No active identity registered for this address yet.</p>
          <p style={styles.hint}>
            Registration must be submitted by an admin - the contract has no self-service
            path. Generate your consent signature below and send it, plus the calldata, to
            an admin to submit on-chain (the same signature scripts/signRegistration.js
            produces from the command line).
          </p>
          <form onSubmit={handleSign}>
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
            <button type="submit" disabled={regBusy}>{regBusy ? "Signing..." : "Generate signature"}</button>
          </form>
          {regResult && (
            <div style={{ marginTop: 12 }}>
              <p>Send these to an admin:</p>
              <label>
                Signature
                <textarea readOnly value={regResult.signature} rows={2} style={styles.textarea} onFocus={(e) => e.target.select()} />
              </label>
              <label>
                Calldata (registerIdentity)
                <textarea readOnly value={regResult.calldata} rows={3} style={styles.textarea} onFocus={(e) => e.target.select()} />
              </label>
              <p style={styles.small}>
                Nonce used: {regResult.nonce} — contract: {regResult.contractAddress}
              </p>
            </div>
          )}
        </div>
      )}

      {isRegistered && roles.isUser && (
        <form onSubmit={handleUpdate} style={{ marginTop: 16 }}>
          <h3>Update my metadata</h3>
          <label>
            New metadata URI:{" "}
            <input value={metaUri} onChange={(e) => setMetaUri(e.target.value)} placeholder="ipfs://..." required />
          </label>
          <button type="submit" disabled={updateBusy}>{updateBusy ? "Submitting..." : "Update"}</button>
          {updateStatus && <p>{updateStatus}</p>}
        </form>
      )}
    </div>
  );
}

const box = { border: "1px solid #ccc", padding: 16, marginBottom: 16 };
const styles = {
  error: { color: "#b00020" },
  hint: { fontSize: 13, color: "#555" },
  small: { fontSize: 12, color: "#555" },
  textarea: { width: "100%", fontFamily: "monospace", fontSize: 12, display: "block" }
};
