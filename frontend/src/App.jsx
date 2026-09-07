import React, { useState } from "react";
import { WalletProvider, useWallet } from "./context/WalletContext";
import WalletConnect from "./components/WalletConnect";
import IdentityCard from "./components/IdentityCard";
import AssetList from "./components/AssetList";
import AdminAuditPanel from "./components/AdminAuditPanel";

const TABS = [
  { key: "identity", label: "Identity" },
  { key: "assets", label: "Assets" },
  // "admin" is added dynamically below, only for Admin/Auditor wallets - the
  // panel itself is never mounted for anyone else (see AdminAuditPanel.jsx).
];

function Tabs() {
  const { roles } = useWallet();
  const [tab, setTab] = useState("identity");

  const tabs = roles.isAdmin || roles.isAuditor ? [...TABS, { key: "admin", label: "Admin / Audit" }] : TABS;
  const activeTab = tabs.some((t) => t.key === tab) ? tab : "identity";

  return (
    <div>
      <nav style={styles.nav}>
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            style={t.key === activeTab ? styles.tabActive : styles.tab}
          >
            {t.label}
          </button>
        ))}
      </nav>
      {activeTab === "identity" && <IdentityCard />}
      {activeTab === "assets" && <AssetList />}
      {activeTab === "admin" && <AdminAuditPanel />}
    </div>
  );
}

export default function App() {
  return (
    <WalletProvider>
      <div style={{ fontFamily: "sans-serif" }}>
        <div style={{ padding: "0 24px" }}>
          <h1>Identity & Asset Platform</h1>
        </div>
        <WalletConnect />
        <div style={{ padding: "0 24px 24px" }}>
          <Tabs />
        </div>
      </div>
    </WalletProvider>
  );
}

const styles = {
  nav: { padding: "0 24px", marginBottom: 16, display: "flex", gap: 8 },
  tab: { padding: "6px 12px", background: "#eee", border: "1px solid #ccc", cursor: "pointer" },
  tabActive: { padding: "6px 12px", background: "#333", color: "#fff", border: "1px solid #333", cursor: "pointer" }
};
