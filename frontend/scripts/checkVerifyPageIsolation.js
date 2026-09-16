// Asserts, mechanically, that the public verification page cannot reach the
// wallet. Walks the full static import closure starting at VerifyPage.jsx and
// fails if anything in it touches MetaMask/ethers/wallet context.
//
// This exists because the guarantee is easy to state and easy to silently
// break: VerifyPage previously imported ../services/api, which imports
// ./apiAuth, which imports ./contractService and ethers' BrowserProvider. No
// wallet code RAN for a wallet-free visitor, so nothing failed visibly - but
// the public page had a static path to wallet wiring, and the next top-level
// side effect added anywhere along that chain would have broken every QR scan
// with no test to catch it. A reviewer would have to read three files to
// notice. This turns that into one command.
//
// Run: node frontend/scripts/checkVerifyPageIsolation.js
const fs = require("fs");
const path = require("path");

const SRC = path.join(__dirname, "..", "src");
const ENTRY = path.join(SRC, "components", "VerifyPage.jsx");

// Substrings that mean "this module can talk to a wallet". Checked against
// module source in the closure, not just import paths, so a direct
// window.ethereum poke inside an otherwise-innocent helper is caught too.
const FORBIDDEN = [
  "window.ethereum",
  "BrowserProvider",
  "eth_requestAccounts",
  "signTypedData",
  "WalletContext",
  "useWallet",
  "contractService",
  "apiAuth"
];

const EXTENSIONS = ["", ".js", ".jsx", ".json"];

function resolveImport(fromFile, spec) {
  // Only local/relative imports are part of our own closure; bare specifiers
  // are node_modules (react, ethers, qrcode.react) and are reported separately.
  if (!spec.startsWith(".")) return { external: spec };
  const base = path.resolve(path.dirname(fromFile), spec);
  for (const ext of EXTENSIONS) {
    const candidate = base + ext;
    if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return { file: candidate };
  }
  for (const ext of [".js", ".jsx"]) {
    const candidate = path.join(base, "index" + ext);
    if (fs.existsSync(candidate)) return { file: candidate };
  }
  return { missing: spec };
}

// Covers `import ... from "x"`, bare `import "x"`, and `export ... from "x"`
// (api.js re-exports publicApi that way, so missing it would miss real edges).
const IMPORT_RE = /(?:^|\n)\s*(?:import|export)\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g;

function importsOf(source) {
  const specs = [];
  let m;
  while ((m = IMPORT_RE.exec(source)) !== null) specs.push(m[1]);
  return specs;
}

const visited = new Map(); // absolute path -> source
const externals = new Set();
const queue = [ENTRY];

while (queue.length > 0) {
  const file = queue.shift();
  if (visited.has(file)) continue;
  const source = fs.readFileSync(file, "utf8");
  visited.set(file, source);
  for (const spec of importsOf(source)) {
    const resolved = resolveImport(file, spec);
    if (resolved.file) queue.push(resolved.file);
    else if (resolved.external) externals.add(resolved.external);
    else console.warn(`  (unresolved import ${spec} in ${path.relative(SRC, file)})`);
  }
}

const rel = (f) => path.relative(path.join(SRC, ".."), f).replace(/\\/g, "/");

console.log(`VerifyPage static import closure (${visited.size} module(s)):`);
for (const file of visited.keys()) console.log(`  ${rel(file)}`);
console.log(`External packages: ${[...externals].sort().join(", ") || "(none)"}`);

const violations = [];
for (const [file, source] of visited) {
  // Strip comments before scanning: these files legitimately *discuss* the
  // wallet dependency they no longer have, and matching that prose would make
  // the check fail on its own documentation.
  const code = source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
  for (const needle of FORBIDDEN) {
    if (code.includes(needle)) violations.push(`${rel(file)}: ${needle}`);
  }
}

if (externals.has("ethers")) violations.push("closure pulls in the 'ethers' package");

if (violations.length > 0) {
  console.error("\nFAIL - the public verify page can reach wallet code:");
  for (const v of violations) console.error(`  ${v}`);
  process.exit(1);
}

console.log("\nPASS - no wallet/MetaMask/ethers dependency in the verify page's import closure.");
