// Verifies that an HTTP caller actually controls an address holding a
// required on-chain role, via an EIP-712 signature - not the backend's own
// configured PRIVATE_KEY. Previously, routes like /api/identity/:address/
// compliance checked whether the BACKEND's key held AUDITOR_ROLE/ADMIN_ROLE
// before serving data - which authenticates nothing about who is actually
// making the HTTP request, since the backend always holds that role by
// design. Anyone with network access to the API got full auditor-level
// reads. requireRole() below is the real boundary: it recovers the caller's
// address from a signature they produce with their own wallet, then checks
// THAT address's role.
//
// Deliberately a NEW EIP-712 domain, not a reuse of IdentityRegistry's
// RegisterIdentity signing (see contracts/IdentityRegistry.sol) - that
// domain/type pair means "I consent to this exact DID binding," a
// different intent that shouldn't be reusable as API-session proof, and
// vice versa. Same underlying mechanism (typed-data sign + recover), new
// domain scoped to this purpose. The domain/types/purpose/validity window
// below MUST stay in sync with frontend/src/services/contractService.js's
// signApiAuth() - the frontend has to produce exactly what this recovers.
const { ethers } = require("ethers");

const API_AUTH_DOMAIN_NAME = "PlatformApiAuth";
const API_AUTH_DOMAIN_VERSION = "1";
const API_AUTH_PURPOSE = "Authenticate to the platform API";
const API_AUTH_TYPES = {
  ApiAuth: [
    { name: "purpose", type: "string" },
    { name: "issuedAt", type: "uint256" }
  ]
};

// How long a signature stays valid after its signed issuedAt. Deliberately
// a plain time window, not a persisted server-side nonce: every route this
// guards is read-only, so a signature replayed within its own window grants
// nothing beyond what the legitimate signer already had for that window -
// not worth the complexity a real anti-replay design would need (a used-
// signature table, cleanup, persistence across restarts) for a write path,
// which none of these are.
const API_AUTH_VALIDITY_MS = 10 * 60 * 1000;

// How far into the future issuedAt may claim to be before it's rejected
// outright. Without this, a far-future issuedAt would never look expired -
// "age <= VALIDITY_MS" alone can't catch that, since age would be negative.
const CLOCK_SKEW_TOLERANCE_MS = 60 * 1000;

const ROLE_REGISTRY_ABI = [
  "function hasRole(bytes32 role, address account) view returns (bool)",
  "function ADMIN_ROLE() view returns (bytes32)",
  "function MANAGER_ROLE() view returns (bytes32)",
  "function AUDITOR_ROLE() view returns (bytes32)",
  "function USER_ROLE() view returns (bytes32)",
  "function CO_SIGNER_ROLE() view returns (bytes32)"
];

const ROLE_GETTERS = {
  ADMIN: "ADMIN_ROLE",
  MANAGER: "MANAGER_ROLE",
  AUDITOR: "AUDITOR_ROLE",
  USER: "USER_ROLE",
  CO_SIGNER: "CO_SIGNER_ROLE"
};

function getProvider() {
  return new ethers.JsonRpcProvider(process.env.RPC_URL);
}

// The chain never changes mid-session, so this is safe to cache for the
// life of the process rather than fetching it on every request.
let cachedChainId = null;
async function getChainId(provider) {
  if (cachedChainId != null) return cachedChainId;
  const network = await provider.getNetwork();
  cachedChainId = Number(network.chainId);
  return cachedChainId;
}

// Express middleware factory: rejects the request with 401/403 unless the
// caller proves (via the signature described above) that they control an
// address holding at least one of `roleNames` (e.g. requireRole("AUDITOR",
// "ADMIN")). On success, attaches the recovered address as
// req.callerAddress for the route handler, and calls next().
function requireRole(...roleNames) {
  return async (req, res, next) => {
    const issuedAtHeader = req.get("X-Auth-Issued-At");
    const signature = req.get("X-Auth-Signature");
    if (!issuedAtHeader || !signature) {
      return res.status(401).json({ error: "Missing authentication - sign in with your wallet and try again." });
    }

    const issuedAt = Number(issuedAtHeader);
    if (!Number.isFinite(issuedAt)) {
      return res.status(401).json({ error: "Malformed authentication - sign in with your wallet and try again." });
    }

    const now = Date.now();
    if (issuedAt > now + CLOCK_SKEW_TOLERANCE_MS) {
      return res.status(401).json({ error: "Invalid authentication timestamp - sign in with your wallet and try again." });
    }
    if (now - issuedAt > API_AUTH_VALIDITY_MS) {
      return res.status(401).json({ error: "Your session has expired - sign in with your wallet and try again." });
    }

    const provider = getProvider();
    let signerAddress;
    try {
      const chainId = await getChainId(provider);
      const domain = {
        name: API_AUTH_DOMAIN_NAME,
        version: API_AUTH_DOMAIN_VERSION,
        chainId,
        verifyingContract: process.env.ROLE_REGISTRY_ADDRESS
      };
      signerAddress = ethers.verifyTypedData(domain, API_AUTH_TYPES, { purpose: API_AUTH_PURPOSE, issuedAt }, signature);
    } catch {
      return res.status(401).json({ error: "Invalid signature - sign in with your wallet and try again." });
    }

    try {
      const roleRegistry = new ethers.Contract(process.env.ROLE_REGISTRY_ADDRESS, ROLE_REGISTRY_ABI, provider);
      const roleHashes = await Promise.all(roleNames.map((name) => roleRegistry[ROLE_GETTERS[name]]()));
      const matches = await Promise.all(roleHashes.map((hash) => roleRegistry.hasRole(hash, signerAddress)));
      if (!matches.some(Boolean)) {
        return res.status(403).json({
          error: `Address ${signerAddress} does not hold the required role (${roleNames.join(" or ")}).`
        });
      }
    } catch (err) {
      return res.status(500).json({ error: `Role check failed: ${err.message}` });
    }

    req.callerAddress = signerAddress;
    next();
  };
}

module.exports = {
  requireRole,
  API_AUTH_DOMAIN_NAME,
  API_AUTH_DOMAIN_VERSION,
  API_AUTH_TYPES,
  API_AUTH_PURPOSE,
  API_AUTH_VALIDITY_MS
};
