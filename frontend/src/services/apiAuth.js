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

// The in-flight signTypedData call, if any - { address, promise }. Without
// this, opening the Admin panel showed MetaMask's "1 of 3": its audit log,
// anomaly, and pending-approvals sections all mount at once and each calls
// getApiAuthHeaders() before any of them has awaited a result, so each one
// independently sees an empty/stale cache and starts its own signing call.
// Tracking the PROMISE (not just the eventual signature) lets concurrent
// callers for the same address share one signing call instead of each
// triggering a separate wallet prompt - keyed by address so a call for a
// DIFFERENT address (a mid-flight account switch) starts its own rather
// than risking the wrong address's signature.
let pending = null;

// Called on wallet disconnect/account switch (see WalletContext.jsx) so a
// stale signature - or a signing request already in flight for the wallet
// being left - can never be attributed to a new session, even by accident.
export function clearApiAuthCache() {
  cache = null;
  pending = null;
}

function toHeaders(entry) {
  return {
    "X-Auth-Issued-At": String(entry.issuedAt),
    "X-Auth-Signature": entry.signature
  };
}

// A request-rejected-in-MetaMask error is thrown as ethers' own
// ACTION_REJECTED error, which reads reasonably already ("user rejected
// action") - wrapped here just to make the UI's error banner unambiguous
// about what to do next. Every caller sharing the in-flight promise sees
// this same rejection, so a single "no" in the wallet fails all of them
// with one clear message rather than some succeeding and some hanging.
function friendlyRejection(err) {
  if (err.code === "ACTION_REJECTED") {
    return new Error("Signature request was rejected - try again to view this data.");
  }
  return err;
}

export async function getApiAuthHeaders(signer, address, { forceRefresh = false } = {}) {
  // Join an already-in-flight sign for this address rather than starting a
  // second one - this is the actual fix for the concurrent-prompt bug.
  // Checked before the freshness check below (even for forceRefresh
  // callers, e.g. a 401 retry): whatever's currently signing will produce a
  // fresh signature by the time it resolves either way, so there's never a
  // reason to start a redundant one just because the caller asked to force
  // a refresh.
  if (pending && pending.address === address) {
    try {
      return toHeaders(await pending.promise);
    } catch (err) {
      throw friendlyRejection(err);
    }
  }

  const now = Date.now();
  const fresh = cache && cache.address === address && now - cache.issuedAt < VALIDITY_MS - REFRESH_MARGIN_MS;
  if (!forceRefresh && fresh) {
    return toHeaders(cache);
  }

  // `promise` is the ONE object every consumer (this call, plus any
  // concurrent joiners reading pending.promise) awaits - the .finally()
  // cleanup lives on that same chain rather than a separate, un-awaited
  // derived promise, so a rejection can't produce an extra "unhandled
  // rejection" warning alongside the one everyone's already catching below.
  const promise = signApiAuth(signer)
    .then(({ issuedAt, signature }) => {
      const entry = { address, issuedAt, signature };
      cache = entry;
      return entry;
    })
    .finally(() => {
      if (pending && pending.promise === promise) pending = null;
    });
  pending = { address, promise };

  try {
    return toHeaders(await promise);
  } catch (err) {
    throw friendlyRejection(err);
  }
}
