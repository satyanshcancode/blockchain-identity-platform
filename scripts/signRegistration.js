// Run by the person being registered, using their OWN wallet, to produce the
// EIP-712 signature IdentityRegistry.registerIdentity() requires as proof of
// consent to the DID binding. The admin who calls registerIdentity() never
// needs this account's private key - only the signature this script prints.
//
// Usage:
//   DID="did:ethr:0xabc..." METADATA_URI="ipfs://profile" PRIVATE_KEY=0x... \
//     npx hardhat run scripts/signRegistration.js --network localhost
//
// Env vars:
//   PRIVATE_KEY                - the registrant's own key. If unset, falls back to
//                                 the network's first configured signer (local
//                                 Hardhat testing only - never omit this in production).
//   IDENTITY_REGISTRY_ADDRESS  - overrides the address read from /shared/addresses.json.
//   DID, METADATA_URI          - the identity being registered (required).
const fs = require("fs");
const hre = require("hardhat");

const SHARED_ADDRESSES_PATH = process.env.SHARED_ADDRESSES_PATH || "/shared/addresses.json";

function loadIdentityRegistryAddress() {
  if (process.env.IDENTITY_REGISTRY_ADDRESS) return process.env.IDENTITY_REGISTRY_ADDRESS;
  if (fs.existsSync(SHARED_ADDRESSES_PATH)) {
    const addresses = JSON.parse(fs.readFileSync(SHARED_ADDRESSES_PATH, "utf8"));
    if (addresses.IDENTITY_REGISTRY_ADDRESS) return addresses.IDENTITY_REGISTRY_ADDRESS;
  }
  throw new Error(
    `IdentityRegistry address not found - set IDENTITY_REGISTRY_ADDRESS or ensure ${SHARED_ADDRESSES_PATH} exists.`
  );
}

async function main() {
  const did = process.env.DID;
  const metadataURI = process.env.METADATA_URI;
  if (!did || !metadataURI) {
    throw new Error("Set DID and METADATA_URI environment variables before running this script.");
  }

  const signer = process.env.PRIVATE_KEY
    ? new hre.ethers.Wallet(process.env.PRIVATE_KEY, hre.ethers.provider)
    : (await hre.ethers.getSigners())[0];

  const identityRegistryAddress = loadIdentityRegistryAddress();
  const identities = await hre.ethers.getContractAt("IdentityRegistry", identityRegistryAddress);

  const account = await signer.getAddress();
  const nonce = await identities.nonces(account);

  // Read the domain straight off the deployed contract (ERC-5267) instead of
  // duplicating name/version/chainId by hand, so this script can't silently
  // drift out of sync with IdentityRegistry.sol's EIP712 constructor args.
  const domainInfo = await identities.eip712Domain();
  const domain = {
    name: domainInfo.name,
    version: domainInfo.version,
    chainId: domainInfo.chainId,
    verifyingContract: domainInfo.verifyingContract
  };
  const types = {
    RegisterIdentity: [
      { name: "account", type: "address" },
      { name: "did", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "nonce", type: "uint256" }
    ]
  };
  const value = { account, did, metadataURI, nonce };

  const signature = await signer.signTypedData(domain, types, value);

  console.log(JSON.stringify({ account, did, metadataURI, nonce: nonce.toString(), signature }, null, 2));
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
