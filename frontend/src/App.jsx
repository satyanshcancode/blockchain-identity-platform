import React from "react";
import IdentityCard from "./components/IdentityCard";
import AssetList from "./components/AssetList";
import RoleManager from "./components/RoleManager";

export default function App() {
  return (
    <div style={{ padding: 24, fontFamily: "sans-serif" }}>
      <h1>Identity & Asset Platform</h1>
      <IdentityCard />
      <RoleManager />
      <AssetList />
    </div>
  );
}
