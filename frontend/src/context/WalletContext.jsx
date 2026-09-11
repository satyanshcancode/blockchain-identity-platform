import React, { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { connectWallet as connectWalletService, getRoleRegistry, getRolesForAddress } from "../services/contractService";

const WalletContext = createContext(null);

const EMPTY_ROLES = { isAdmin: false, isManager: false, isAuditor: false, isUser: false, isCoSigner: false };

export function WalletProvider({ children }) {
  const [address, setAddress] = useState(null);
  const [chainId, setChainId] = useState(null);
  const [signer, setSigner] = useState(null);
  const [provider, setProvider] = useState(null);
  const [roles, setRoles] = useState(EMPTY_ROLES);
  const [error, setError] = useState(null);
  const [connecting, setConnecting] = useState(false);

  const hasMetaMask = typeof window !== "undefined" && Boolean(window.ethereum);

  const refreshRoles = useCallback(async (addr, signerOrProvider) => {
    if (!addr || !signerOrProvider) {
      setRoles(EMPTY_ROLES);
      return;
    }
    try {
      const roleRegistry = getRoleRegistry(signerOrProvider);
      setRoles(await getRolesForAddress(roleRegistry, addr));
    } catch (err) {
      console.error("Failed to read roles from RoleRegistry:", err);
      setRoles(EMPTY_ROLES);
    }
  }, []);

  const disconnect = useCallback(() => {
    setAddress(null);
    setSigner(null);
    setProvider(null);
    setChainId(null);
    setRoles(EMPTY_ROLES);
  }, []);

  // MetaMask already remembers this site's permission grant, so calling this
  // again from the accountsChanged/chainChanged listeners below doesn't
  // reprompt the user - eth_requestAccounts resolves immediately once
  // permission has been granted once.
  const connect = useCallback(async () => {
    if (!hasMetaMask) {
      setError("MetaMask not detected. Install the MetaMask extension to connect a wallet.");
      return;
    }
    setConnecting(true);
    setError(null);
    try {
      const { provider: p, signer: s, address: addr, chainId: cid } = await connectWalletService();
      setProvider(p);
      setSigner(s);
      setAddress(addr);
      setChainId(cid);
      await refreshRoles(addr, s);
    } catch (err) {
      setError(err.message || String(err));
    } finally {
      setConnecting(false);
    }
  }, [hasMetaMask, refreshRoles]);

  useEffect(() => {
    if (!hasMetaMask) return undefined;

    const handleAccountsChanged = (accounts) => {
      if (!accounts || accounts.length === 0) {
        disconnect();
      } else {
        connect();
      }
    };
    const handleChainChanged = () => {
      connect();
    };

    window.ethereum.on("accountsChanged", handleAccountsChanged);
    window.ethereum.on("chainChanged", handleChainChanged);
    return () => {
      window.ethereum.removeListener("accountsChanged", handleAccountsChanged);
      window.ethereum.removeListener("chainChanged", handleChainChanged);
    };
  }, [hasMetaMask, connect, disconnect]);

  const value = useMemo(
    () => ({
      address,
      chainId,
      signer,
      provider,
      roles,
      error,
      connecting,
      hasMetaMask,
      connect,
      disconnect,
      refreshRoles: () => refreshRoles(address, signer)
    }),
    [address, chainId, signer, provider, roles, error, connecting, hasMetaMask, connect, disconnect, refreshRoles]
  );

  return <WalletContext.Provider value={value}>{children}</WalletContext.Provider>;
}

export function useWallet() {
  const ctx = useContext(WalletContext);
  if (!ctx) throw new Error("useWallet must be used within a WalletProvider");
  return ctx;
}
