// Direct MetaMask <-> contract wiring. Per the platform's architecture,
// WRITES go straight through the connected wallet to the contracts (the
// user signs and pays gas); READS go through the backend API instead (see
// ./api.js) - this file intentionally has no read-heavy helpers like "list
// all assets," only the specific on-chain reads the UI needs synchronously
// (role checks, EIP-712 domain/nonce for signing).
import { BrowserProvider, Contract } from "ethers";

export const ROLE_REGISTRY_ADDRESS = process.env.REACT_APP_ROLE_REGISTRY_ADDRESS || "";
export const IDENTITY_REGISTRY_ADDRESS = process.env.REACT_APP_IDENTITY_REGISTRY_ADDRESS || "";
export const ASSET_NFT_ADDRESS = process.env.REACT_APP_ASSET_NFT_ADDRESS || "";

const ROLE_REGISTRY_ABI = [
  "function ADMIN_ROLE() view returns (bytes32)",
  "function MANAGER_ROLE() view returns (bytes32)",
  "function AUDITOR_ROLE() view returns (bytes32)",
  "function USER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)"
];

const IDENTITY_REGISTRY_ABI = [
  "function getIdentity(address account) view returns (tuple(string did,string metadataURI,bool active))",
  "function nonces(address account) view returns (uint256)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function registerIdentity(address account, string did, string metadataURI, bytes signature)",
  "function updateMetadata(string newMetadataURI)",
  "function revokeIdentity(address account)"
];

const ASSET_NFT_ABI = [
  "function mintAsset(address to, string uri) returns (uint256)",
  "function transferAsset(address to, uint256 tokenId)",
  "function reclaimAsset(uint256 tokenId, address newOwner)"
];

export async function connectWallet() {
  if (!window.ethereum) throw new Error("MetaMask not found. Install the MetaMask browser extension.");
  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  const address = await signer.getAddress();
  const network = await provider.getNetwork();
  return { provider, signer, address, chainId: Number(network.chainId) };
}

export function getRoleRegistry(signerOrProvider) {
  return new Contract(ROLE_REGISTRY_ADDRESS, ROLE_REGISTRY_ABI, signerOrProvider);
}

export function getIdentityRegistry(signerOrProvider) {
  return new Contract(IDENTITY_REGISTRY_ADDRESS, IDENTITY_REGISTRY_ABI, signerOrProvider);
}

export function getAssetNFT(signerOrProvider) {
  return new Contract(ASSET_NFT_ADDRESS, ASSET_NFT_ABI, signerOrProvider);
}

// The four roles are on-chain keccak256 constants (see RoleRegistry.sol) -
// read them from the contract rather than hardcoding the hash client-side,
// so this can't silently drift if the contract ever changes them.
export async function getRolesForAddress(roleRegistry, address) {
  const [ADMIN_ROLE, MANAGER_ROLE, AUDITOR_ROLE, USER_ROLE] = await Promise.all([
    roleRegistry.ADMIN_ROLE(),
    roleRegistry.MANAGER_ROLE(),
    roleRegistry.AUDITOR_ROLE(),
    roleRegistry.USER_ROLE()
  ]);
  const [isAdmin, isManager, isAuditor, isUser] = await Promise.all([
    roleRegistry.hasRole(ADMIN_ROLE, address),
    roleRegistry.hasRole(MANAGER_ROLE, address),
    roleRegistry.hasRole(AUDITOR_ROLE, address),
    roleRegistry.hasRole(USER_ROLE, address)
  ]);
  return { isAdmin, isManager, isAuditor, isUser };
}

// Produces the EIP-712 signature (and ready-to-submit calldata) an admin
// needs to call IdentityRegistry.registerIdentity() on this account's
// behalf. There's no self-service on-chain registration path - the contract
// requires an admin to submit the transaction - so this only gets the user
// as far as something they can hand to an admin. Mirrors the signing logic
// in scripts/signRegistration.js, but using the browser wallet as the signer.
export async function signRegistration(signer, { did, metadataURI }) {
  const address = await signer.getAddress();
  const identities = getIdentityRegistry(signer);
  const nonce = await identities.nonces(address);
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
  const value = { account: address, did, metadataURI, nonce };
  const signature = await signer.signTypedData(domain, types, value);
  const calldata = identities.interface.encodeFunctionData("registerIdentity", [address, did, metadataURI, signature]);
  return {
    account: address,
    did,
    metadataURI,
    nonce: nonce.toString(),
    signature,
    calldata,
    contractAddress: IDENTITY_REGISTRY_ADDRESS
  };
}

export async function updateMetadata(signer, newMetadataURI) {
  const tx = await getIdentityRegistry(signer).updateMetadata(newMetadataURI);
  return tx.wait();
}

export async function mintAsset(signer, to, uri) {
  const tx = await getAssetNFT(signer).mintAsset(to, uri);
  return tx.wait();
}

export async function transferAsset(signer, to, tokenId) {
  const tx = await getAssetNFT(signer).transferAsset(to, tokenId);
  return tx.wait();
}

// Submits a registration an admin received from someone else (via
// signRegistration()'s signature + calldata, or scripts/signRegistration.js)
// - the account/did/metadataURI must match exactly what was signed, or the
// contract's signature check reverts.
export async function registerIdentity(signer, account, did, metadataURI, signature) {
  const tx = await getIdentityRegistry(signer).registerIdentity(account, did, metadataURI, signature);
  return tx.wait();
}

export async function revokeIdentity(signer, account) {
  const tx = await getIdentityRegistry(signer).revokeIdentity(account);
  return tx.wait();
}

export async function reclaimAsset(signer, tokenId, newOwner) {
  const tx = await getAssetNFT(signer).reclaimAsset(tokenId, newOwner);
  return tx.wait();
}
