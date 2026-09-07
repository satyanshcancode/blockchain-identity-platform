import React, { useState } from "react";

export default function IdentityCard() {
  const [address, setAddress] = useState("");

  return (
    <div style={{ border: "1px solid #ccc", padding: 16, marginBottom: 16 }}>
      <h2>My identity</h2>
      <p>Connect your wallet to view your DID and credential status.</p>
      <button onClick={() => setAddress("0x... (connect wallet here)")}>
        Connect wallet
      </button>
      {address && <p>Address: {address}</p>}
    </div>
  );
}
