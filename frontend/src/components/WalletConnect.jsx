import React from "react";
import { useWallet } from "../context/WalletContext";

const EXPECTED_CHAIN_ID = Number(process.env.REACT_APP_CHAIN_ID || 31337);

function roleLabels(roles) {
  const labels = [];
  if (roles.isAdmin) labels.push("Admin");
  if (roles.isManager) labels.push("Manager");
  if (roles.isAuditor) labels.push("Auditor");
  if (roles.isUser) labels.push("User");
  if (roles.isCoSigner) labels.push("Co-signer");
  return labels;
}

export default function WalletConnect() {
  const { address, chainId, roles, error, connecting, hasMetaMask, connect } = useWallet();

  if (!hasMetaMask) {
    return (
      <div className="wallet-bar wallet-bar--notice">
        <span>
          <strong>MetaMask not detected.</strong>{" "}
          Install the <a href="https://metamask.io/" target="_blank" rel="noreferrer">MetaMask extension</a> to use this app.
        </span>
      </div>
    );
  }

  if (!address) {
    return (
      <div className="wallet-bar">
        <button className="btn btn--sm" onClick={connect} disabled={connecting}>
          {connecting ? "Connecting..." : "Connect wallet"}
        </button>
        {error && <span className="text-error"> {error}</span>}
      </div>
    );
  }

  const labels = roleLabels(roles);
  const wrongNetwork = chainId !== EXPECTED_CHAIN_ID;

  return (
    <div className="wallet-bar">
      <span className="wallet-bar__group">
        <span className="wallet-bar__label">Connected</span>
        <span className="mono">{address}</span>
      </span>
      <span className="wallet-bar__group">
        <span className="wallet-bar__label">Roles</span>
        {labels.length > 0 ? (
          <span className="wallet-bar__roles">
            {labels.map((label) => (
              <span key={label} className="badge badge--role">{label}</span>
            ))}
          </span>
        ) : (
          <span className="text-muted">none</span>
        )}
      </span>
      {wrongNetwork && (
        <span className="text-warning">
          Wrong network (chain {chainId}, expected {EXPECTED_CHAIN_ID}) - switch networks in MetaMask.
        </span>
      )}
      {error && <span className="text-error">{error}</span>}
    </div>
  );
}
