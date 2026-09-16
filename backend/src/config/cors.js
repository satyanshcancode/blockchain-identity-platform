// Two CORS policies, applied per route group, because this API has two
// genuinely different audiences.
//
// The problem this replaces: a single app-wide
// `cors({ origin: FRONTEND_ORIGIN })` allowed exactly one origin,
// http://localhost:3000. That is correct for the operator console, but the
// public verification page is reached by people who are by definition NOT on
// this machine - someone scanning an asset's QR code on their phone loads the
// app from http://<lan-ip>:3000, and the browser then refused every API
// response because the Access-Control-Allow-Origin header came back naming
// localhost instead of the origin that asked. The routes themselves were never
// authenticated (no requireRole on any of them), so this failed as a silent
// CORS rejection rather than a 401 - which is what made it look like the verify
// page itself was broken.
//
// publicCors  - the read-only verification surface. Any origin, because a
//               public verification link is meant to work from an arbitrary
//               device, and there is no credential, cookie or header to leak:
//               responses carry only data that is already public on-chain.
//               Wildcard ACAO and credentials are mutually exclusive in the
//               CORS spec anyway, so this cannot be widened into an
//               ambient-authority hole by accident.
// privateCors - everything gated by requireRole (audit log, anomalies,
//               compliance records, pending approvals). Stays a strict
//               allowlist. Widening it was never necessary to fix the verify
//               page and is deliberately not done here.
const cors = require("cors");

const DEFAULT_FRONTEND_PORT = 3000;

// Origins permitted to call the role-gated routes. Built from, in order:
//   - PRIVATE_ORIGINS, an explicit comma-separated list (wins outright)
//   - FRONTEND_ORIGIN, the single-origin variable this used to read
//   - http://<PUBLIC_HOST>:3000, so an operator running the console over the
//     LAN (the same address they hand out for QR scanning) is not locked out
//     of the admin panel
//   - http://localhost:3000, always, so the documented local workflow works
//     with no configuration at all
function buildPrivateOrigins() {
  const explicit = (process.env.PRIVATE_ORIGINS || "")
    .split(",")
    .map((o) => o.trim().replace(/\/+$/, ""))
    .filter(Boolean);
  if (explicit.length > 0) return explicit;

  const origins = new Set([`http://localhost:${DEFAULT_FRONTEND_PORT}`, `http://127.0.0.1:${DEFAULT_FRONTEND_PORT}`]);
  if (process.env.FRONTEND_ORIGIN) origins.add(process.env.FRONTEND_ORIGIN.trim().replace(/\/+$/, ""));
  if (process.env.PUBLIC_HOST) {
    const host = process.env.PUBLIC_HOST.trim();
    const port = process.env.FRONTEND_PORT || DEFAULT_FRONTEND_PORT;
    if (host) origins.add(`http://${host}:${port}`);
  }
  return [...origins];
}

const PRIVATE_ORIGINS = buildPrivateOrigins();

// origin is undefined for same-origin/non-browser callers (curl, the
// frontend's own server-side tooling) - those carry no Origin header and CORS
// does not apply to them, so they must not be rejected here.
const privateCors = cors({
  origin(origin, callback) {
    if (!origin || PRIVATE_ORIGINS.includes(origin)) return callback(null, true);
    return callback(null, false);
  }
});

const publicCors = cors({
  origin: "*",
  methods: ["GET", "HEAD", "OPTIONS"]
});

// Structural backstop for "the public surface is strictly read-only". Today
// nothing mutating is reachable here to begin with: mint, transfer, revoke,
// reclaim and pause are wallet-signed calls the browser sends straight to the
// contracts, and the only POST the API has at all
// (/api/audit/anomalies/acknowledge) lives behind requireRole + privateCors.
// This exists so that stays true by construction - a future POST added to a
// publicly-mounted router is refused by the mount instead of quietly becoming
// an unauthenticated write endpoint.
function readOnlyOnly(req, res, next) {
  if (req.method === "GET" || req.method === "HEAD" || req.method === "OPTIONS") return next();
  return res.status(405).json({ error: "This endpoint is read-only." });
}

module.exports = { publicCors, privateCors, readOnlyOnly, PRIVATE_ORIGINS };
