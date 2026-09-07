import React from "react";
import { useWallet } from "../context/WalletContext";

const EXPECTED_CHAIN_ID = Number(process.env.REACT_APP_CHAIN_ID || 31337);

function roleLabels(roles) {
  const labels = [];
  if (roles.isAdmin) labels.push("Admin");
  if (roles.isManager) labels.push("Manager");
  if (roles.isAuditor) labels.push("Auditor");
  if (roles.isUser) labels.push("User");
  return labels;
}

export default function WalletConnect() {
  const { address, chainId, roles, error, connecting, hasMetaMask, connect } = useWallet();

  if (!hasMetaMask) {
    return (
      <div style={styles.bar}>
        <strong>MetaMask not detected.</strong>{" "}
        Install the <a href="https://metamask.io/" target="_blank" rel="noreferrer">MetaMask extension</a> to use this app.
      </div>
    );
  }

  if (!address) {
    return (
      <div style={styles.bar}>
        <button onClick={connect} disabled={connecting}>
          {connecting ? "Connecting..." : "Connect wallet"}
        </button>
        {error && <span style={styles.error}> {error}</span>}
      </div>
    );
  }

  const labels = roleLabels(roles);
  const wrongNetwork = chainId !== EXPECTED_CHAIN_ID;

  return (
    <div style={styles.bar}>
      <span><strong>Connected:</strong> {address}</span>
      <span style={{ marginLeft: 16 }}>
        <strong>Roles:</strong> {labels.length > 0 ? labels.join(", ") : "none"}
      </span>
      {wrongNetwork && (
        <span style={styles.warning}>
          {" "}Wrong network (chain {chainId}, expected {EXPECTED_CHAIN_ID}) - switch networks in MetaMask.
        </span>
      )}
      {error && <span style={styles.error}> {error}</span>}
    </div>
  );
}

const styles = {
  bar: { padding: 12, background: "#f5f5f5", borderBottom: "1px solid #ccc", marginBottom: 16 },
  error: { color: "#b00020" },
  warning: { color: "#b06000" }
};
