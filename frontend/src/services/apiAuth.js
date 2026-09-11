// Caches the API-auth signature (see contractService.js's signApiAuth) for
// its validity window, so browsing role-gated data doesn't prompt MetaMask
// on every request - only when the cache is empty, stale, or for a
// different address than the one currently connected.
import { signApiAuth } from "./contractService";

// Mirrors backend/src/auth/apiAuth.js's API_AUTH_VALIDITY_MS (10 minutes).
// REFRESH_MARGIN_MS re-signs a bit before the real expiry, so a request
// can't be built with a signature that turns out to be expired by the time
// the backend receives it.
const VALIDITY_MS = 10 * 60 * 1000;
const REFRESH_MARGIN_MS = 30 * 1000;

let cache = null; // { address, issuedAt, signature }

// Called on wallet disconnect/account switch (see WalletContext.jsx) so a
// stale signature can never be sent under a new session, even by accident.
export function clearApiAuthCache() {
  cache = null;
}

// A request-rejected-in-MetaMask error is thrown as ethers' own
// ACTION_REJECTED error, which reads reasonably already ("user rejected
// action") - wrapped here just to make the UI's error banner unambiguous
// about what to do next.
export async function getApiAuthHeaders(signer, address, { forceRefresh = false } = {}) {
  const now = Date.now();
  const fresh = cache && cache.address === address && now - cache.issuedAt < VALIDITY_MS - REFRESH_MARGIN_MS;

  if (forceRefresh || !fresh) {
    let issuedAt, signature;
    try {
      ({ issuedAt, signature } = await signApiAuth(signer));
    } catch (err) {
      if (err.code === "ACTION_REJECTED") {
        throw new Error("Signature request was rejected - try again to view this data.");
      }
      throw err;
    }
    cache = { address, issuedAt, signature };
  }

  return {
    "X-Auth-Issued-At": String(cache.issuedAt),
    "X-Auth-Signature": cache.signature
  };
}
