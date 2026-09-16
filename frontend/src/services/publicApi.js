// The read-only, authentication-free slice of the platform API - the only
// data source the public verification page is allowed to touch.
//
// This file is deliberately separate from ./api.js, and deliberately imports
// NOTHING but ../config/origins. ./api.js also carries the role-gated calls,
// which pull in ./apiAuth -> ./contractService -> ethers' BrowserProvider;
// VerifyPage importing ./api therefore put a wallet-dependent module in the
// public page's import graph. Nothing in that chain runs at module load, so it
// never actually crashed a wallet-free visitor - but the public page having a
// static path to MetaMask wiring at all is the kind of thing that turns into a
// real break the first time someone adds a top-level side effect to it. Splitting
// the surface makes "the verify page cannot reach the wallet" structural rather
// than a property you have to re-verify by reading three files.
//
// Every route below is unauthenticated BY DESIGN on the backend (no requireRole
// middleware - see backend/src/index.js's publicCors mount and the read-only
// guard alongside it). A phone scanning a QR code has no wallet and cannot
// produce an EIP-712 signature, so anything it needs has to live here.
import { API_BASE_URL } from "../config/origins";

async function request(path) {
  const res = await fetch(`${API_BASE_URL}${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body;
}

export const getAssets = () => request("/api/assets");
export const getAsset = (tokenId) => request(`/api/assets/${tokenId}`);
export const getAssetsByOwner = (address) => request(`/api/assets/owner/${address}`);
export const getAssetHistory = (tokenId) => request(`/api/assets/${tokenId}/history`);
export const getIdentity = (address) => request(`/api/identity/${address}`);
