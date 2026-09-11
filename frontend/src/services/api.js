// All READS go through the backend API rather than querying the chain
// directly from the browser (see backend/src/routes/*.js) - the backend
// already indexes/serves this data and is faster/simpler than re-deriving
// it client-side. WRITES live in ./contractService.js instead.
import { getApiAuthHeaders, clearApiAuthCache } from "./apiAuth";

const API_URL = process.env.REACT_APP_API_URL || "http://localhost:4000";

async function request(path) {
  const res = await fetch(`${API_URL}${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body;
}

// For routes gated by backend/src/auth/apiAuth.js's requireRole middleware
// (audit log, compliance records, anomalies, pending approvals). Attaches a
// cached (or freshly signed) proof-of-address signature; on a 401
// specifically - missing/expired/invalid signature, as opposed to a 403
// wrong-role rejection - clears the cache and retries ONCE with a fresh
// one. That's what makes an expired session "prompt to re-sign" instead of
// just failing: signing triggers a MetaMask popup the user sees and can
// act on. A 403 never retries - signing again as the same address can't
// change which role it holds.
async function requestAuthed(path, signer, address, { method = "GET", body: requestBody } = {}) {
  if (!signer || !address) {
    throw new Error("Connect your wallet to view this data.");
  }
  for (let attempt = 0; attempt < 2; attempt++) {
    const headers = await getApiAuthHeaders(signer, address, { forceRefresh: attempt > 0 });
    const res = await fetch(`${API_URL}${path}`, {
      method,
      headers: requestBody ? { ...headers, "Content-Type": "application/json" } : headers,
      body: requestBody ? JSON.stringify(requestBody) : undefined
    });
    if (res.ok) return res.json();
    const body = await res.json().catch(() => ({}));
    if (res.status === 401 && attempt === 0) {
      clearApiAuthCache();
      continue;
    }
    throw new Error(body.error || `Request failed: ${res.status}`);
  }
}

export const getAssets = () => request("/api/assets");
export const getAsset = (tokenId) => request(`/api/assets/${tokenId}`);
export const getAssetsByOwner = (address) => request(`/api/assets/owner/${address}`);
export const getAssetHistory = (tokenId) => request(`/api/assets/${tokenId}/history`);
export const getIdentity = (address) => request(`/api/identity/${address}`);

export const getAuditLog = (signer, address) => requestAuthed("/api/audit", signer, address);
export const getAnomalies = (signer, address) => requestAuthed("/api/audit/anomalies", signer, address);
export const getComplianceRecord = (targetAddress, signer, callerAddress) =>
  requestAuthed(`/api/identity/${targetAddress}/compliance`, signer, callerAddress);
export const getPendingApprovals = (signer, address) => requestAuthed("/api/approvals/pending", signer, address);
export const acknowledgeAnomaly = (anomalyId, signer, address) =>
  requestAuthed("/api/audit/anomalies/acknowledge", signer, address, { method: "POST", body: { anomalyId } });
