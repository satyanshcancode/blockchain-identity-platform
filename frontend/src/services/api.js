// All READS go through the backend API rather than querying the chain
// directly from the browser (see backend/src/routes/*.js) - the backend
// already indexes/serves this data and is faster/simpler than re-deriving
// it client-side. WRITES live in ./contractService.js instead.
const API_URL = process.env.REACT_APP_API_URL || "http://localhost:4000";

async function request(path) {
  const res = await fetch(`${API_URL}${path}`);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error || `Request failed: ${res.status}`);
  return body;
}

export const getAssets = () => request("/api/assets");
export const getAsset = (tokenId) => request(`/api/assets/${tokenId}`);
export const getAssetsByOwner = (address) => request(`/api/assets/owner/${address}`);
export const getAssetHistory = (tokenId) => request(`/api/assets/${tokenId}/history`);
export const getAuditLog = () => request("/api/audit");
export const getIdentity = (address) => request(`/api/identity/${address}`);
export const getComplianceRecord = (address) => request(`/api/identity/${address}/compliance`);
export const getPendingApprovals = () => request("/api/approvals/pending");
