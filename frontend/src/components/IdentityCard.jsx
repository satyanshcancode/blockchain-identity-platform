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
      <div className="panel">
        <h2 className="page-title">My identity</h2>
        <p className="text-muted">Connect your wallet to view your DID and credential status.</p>
      </div>
    );
  }

  const isRegistered = Boolean(identity && identity.active);

  const handleSign = async (e) => {
    e.preventDefault();
    setError(null);
    // HTML's `required` only blocks a totally empty field - typing just a
    // space satisfies it, which would then get signed and submitted as a
    // blank identity. Catching it here means it's never even signed.
    if (!regDid.trim()) {
      setError("DID cannot be empty or just whitespace.");
      return;
    }
    setRegBusy(true);
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
    <div className="panel">
      <h2 className="page-title">My identity</h2>
      {loading && <p className="text-muted">Loading...</p>}
      {error && <p className="alert alert--error">{error}</p>}

      {isRegistered ? (
        <dl className="kv-list">
          <dt>DID</dt>
          <dd>{identity.did}</dd>
          <dt>Metadata URI</dt>
          <dd>{identity.metadataURI}</dd>
          <dt>Status</dt>
          <dd><span className="badge badge--active">Active</span></dd>
        </dl>
      ) : (
        <div>
          <p>No active identity registered for this address yet.</p>
          <p className="hint-text">
            Registration must be submitted by an admin - the contract has no self-service
            path. Generate your consent signature below and send it, plus the calldata, to
            an admin to submit on-chain (the same signature scripts/signRegistration.js
            produces from the command line).
          </p>
          <form onSubmit={handleSign}>
            <label className="field">
              <span className="field__label-text">DID</span>
              <input value={regDid} onChange={(e) => setRegDid(e.target.value)} placeholder="did:ethr:0x..." required />
            </label>
            <label className="field">
              <span className="field__label-text">Metadata URI</span>
              <input value={regUri} onChange={(e) => setRegUri(e.target.value)} placeholder="ipfs://..." required />
            </label>
            <button type="submit" className="btn" disabled={regBusy}>{regBusy ? "Signing..." : "Generate signature"}</button>
          </form>
          {regResult && (
            <div className="subsection">
              <p>Send these to an admin:</p>
              <label className="field field--wide">
                <span className="field__label-text">Signature</span>
                <textarea
                  readOnly
                  value={regResult.signature}
                  rows={2}
                  className="mono-input"
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <label className="field field--wide">
                <span className="field__label-text">Calldata (registerIdentity)</span>
                <textarea
                  readOnly
                  value={regResult.calldata}
                  rows={3}
                  className="mono-input"
                  onFocus={(e) => e.target.select()}
                />
              </label>
              <p className="small-text">
                Nonce used: {regResult.nonce} — contract: <span className="mono">{regResult.contractAddress}</span>
              </p>
            </div>
          )}
        </div>
      )}

      {isRegistered && roles.isUser && (
        <form onSubmit={handleUpdate} className="subsection">
          <h3 className="subsection__title">Update my metadata</h3>
          <label className="field">
            <span className="field__label-text">New metadata URI</span>
            <input value={metaUri} onChange={(e) => setMetaUri(e.target.value)} placeholder="ipfs://..." required />
          </label>
          <button type="submit" className="btn" disabled={updateBusy}>{updateBusy ? "Submitting..." : "Update"}</button>
          {updateStatus && <p className="alert alert--success">{updateStatus}</p>}
        </form>
      )}
    </div>
  );
}
