import React, { useState } from "react";
import { WalletProvider, useWallet } from "./context/WalletContext";
import WalletConnect from "./components/WalletConnect";
import IdentityCard from "./components/IdentityCard";
import AssetList from "./components/AssetList";
import AdminAuditPanel from "./components/AdminAuditPanel";
import VerifyPage from "./components/VerifyPage";

// No router dependency: the app has exactly one real URL route (this one) -
// everything else is in-memory tab state (see Tabs below). Matched and
// rendered *before* WalletProvider mounts at all, so the public verification
// page can never end up depending on wallet state, even by accident - a
// visitor with no MetaMask and no wallet must be able to load it.
function matchVerifyRoute(pathname) {
  const match = pathname.match(/^\/verify\/([^/]+)\/?$/);
  return match ? decodeURIComponent(match[1]) : null;
}

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
    <>
      <nav className="tabs">
        {tabs.map((t) => (
          <button
            key={t.key}
            onClick={() => setTab(t.key)}
            className={t.key === activeTab ? "tab-btn tab-btn--active" : "tab-btn"}
          >
            {t.label}
          </button>
        ))}
      </nav>
      <main className="app-main">
        {activeTab === "identity" && <IdentityCard />}
        {activeTab === "assets" && <AssetList />}
        {activeTab === "admin" && <AdminAuditPanel />}
      </main>
    </>
  );
}

export default function App() {
  const verifyTokenId = matchVerifyRoute(window.location.pathname);
  if (verifyTokenId != null) {
    return <VerifyPage tokenId={verifyTokenId} />;
  }

  return (
    <WalletProvider>
      <div className="app-shell">
        <header className="app-header">
          <h1 className="app-header__title">Identity & Asset Platform</h1>
        </header>
        <WalletConnect />
        <Tabs />
      </div>
    </WalletProvider>
  );
}
