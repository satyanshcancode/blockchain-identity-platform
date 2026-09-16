// The ONE place the frontend decides what hostname the outside world reaches
// this deployment on. Everything that has to produce an absolute, off-device
// URL - the public API base for fetches, and the origin baked into asset QR
// codes - resolves through here, so there is a single knob to turn for a demo
// instead of a hardcoded "localhost" in each call site.
//
// Why this mattered: a QR code and an API base URL are the two things in this
// app that get *carried off the machine that generated them*. `localhost` in
// either one resolves, on the scanning phone, to the phone itself - so a QR
// scan failed before it ever reached the platform, and even when the page was
// loaded over the LAN its fetches went to a nonexistent API on the phone.
//
// Resolution order (identical for both values):
//   1. An explicit REACT_APP_* override - set this for anything real: a
//      reverse proxy, a domain name, an API on a different host than the UI.
//   2. The host the browser actually loaded this page from. This is the useful
//      default: open the app at http://192.168.1.50:3000 and both the QR
//      payload and the API base follow to 192.168.1.50 with no config at all.
//   3. localhost, for non-browser contexts (tests, any SSR/tooling pass) where
//      window doesn't exist.
//
// Note on (1): react-scripts inlines REACT_APP_* at dev-server boot / build
// time, not at page load - changing it needs a frontend restart, which is why
// (2) exists as a zero-restart fallback.

// The API is a separate service on its own port rather than a path on the UI's
// origin, so deriving it from window.location means swapping the port.
const API_PORT = 4000;

const LOOPBACK_HOSTNAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1", ""]);

function browserOrigin() {
  if (typeof window === "undefined" || !window.location) return null;
  return window.location.origin || null;
}

function browserApiOrigin() {
  if (typeof window === "undefined" || !window.location) return null;
  const { protocol, hostname } = window.location;
  if (!hostname) return null;
  return `${protocol}//${hostname}:${API_PORT}`;
}

// Trailing slashes would produce "//api/assets" once a path is appended.
function normalize(origin) {
  return origin ? origin.replace(/\/+$/, "") : origin;
}

// REACT_APP_API_URL is the name this used to go by (see .env.example history);
// still honored so an existing hand-written .env.local doesn't silently stop
// working, but REACT_APP_API_BASE_URL wins and is the documented name.
export const API_BASE_URL = normalize(
  process.env.REACT_APP_API_BASE_URL ||
    process.env.REACT_APP_API_URL ||
    browserApiOrigin() ||
    `http://localhost:${API_PORT}`
);

// The origin a verification QR code should point at. Same host as the UI in
// every normal setup, so window.location.origin is the right fallback.
export const PUBLIC_BASE_URL = normalize(
  process.env.REACT_APP_PUBLIC_BASE_URL || browserOrigin() || "http://localhost:3000"
);

// True when the QR origin above is loopback, i.e. a code generated right now
// would be unscannable from any other device. Surfaced in the UI (see
// AssetList.jsx) rather than left as a silent failure, because this is exactly
// the condition that makes a QR demo fail in front of an audience - the code
// scans fine, the phone just can't resolve where it points.
export function isQrOriginUnreachableOffDevice() {
  try {
    return LOOPBACK_HOSTNAMES.has(new URL(PUBLIC_BASE_URL).hostname);
  } catch {
    return false;
  }
}
