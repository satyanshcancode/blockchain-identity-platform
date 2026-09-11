// Direct MetaMask <-> contract wiring. Per the platform's architecture,
// WRITES go straight through the connected wallet to the contracts (the
// user signs and pays gas); READS go through the backend API instead (see
// ./api.js) - this file intentionally has no read-heavy helpers like "list
// all assets," only the specific on-chain reads the UI needs synchronously
// (role checks, EIP-712 domain/nonce for signing).
import { BrowserProvider, Contract } from "ethers";

export const ROLE_REGISTRY_ADDRESS = process.env.REACT_APP_ROLE_REGISTRY_ADDRESS || "";
export const APPROVAL_REGISTRY_ADDRESS = process.env.REACT_APP_APPROVAL_REGISTRY_ADDRESS || "";
export const IDENTITY_REGISTRY_ADDRESS = process.env.REACT_APP_IDENTITY_REGISTRY_ADDRESS || "";
export const ASSET_NFT_ADDRESS = process.env.REACT_APP_ASSET_NFT_ADDRESS || "";

const ROLE_REGISTRY_ABI = [
  "function ADMIN_ROLE() view returns (bytes32)",
  "function MANAGER_ROLE() view returns (bytes32)",
  "function AUDITOR_ROLE() view returns (bytes32)",
  "function USER_ROLE() view returns (bytes32)",
  "function CO_SIGNER_ROLE() view returns (bytes32)",
  "function hasRole(bytes32 role, address account) view returns (bool)"
];

const APPROVAL_REGISTRY_ABI = ["function hasApproved(uint256 proposalId, address account) view returns (bool)"];

const IDENTITY_REGISTRY_ABI = [
  "function getIdentity(address account) view returns (tuple(string did,string metadataURI,bool active))",
  "function nonces(address account) view returns (uint256)",
  "function eip712Domain() view returns (bytes1 fields, string name, string version, uint256 chainId, address verifyingContract, bytes32 salt, uint256[] extensions)",
  "function registerIdentity(address account, string did, string metadataURI, bytes signature)",
  "function updateMetadata(string newMetadataURI)",
  "function revokeIdentity(address account) returns (uint256 proposalId)",
  "function approveRevokeIdentity(uint256 proposalId)",
  "function pause()",
  "function unpause()",
  "function paused() view returns (bool)",
  "error EnforcedPause()",
  "error ExpectedPause()"
];

const ASSET_NFT_ABI = [
  "function mintAsset(address to, string uri) returns (uint256)",
  "function transferAsset(address to, uint256 tokenId)",
  "function reclaimAsset(uint256 tokenId, address newOwner) returns (uint256 proposalId)",
  "function approveReclaimAsset(uint256 proposalId)",
  "function pause()",
  "function unpause()",
  "function paused() view returns (bool)",
  "error EnforcedPause()",
  "error ExpectedPause()"
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

export function getApprovalRegistry(signerOrProvider) {
  return new Contract(APPROVAL_REGISTRY_ADDRESS, APPROVAL_REGISTRY_ABI, signerOrProvider);
}

// The five roles are on-chain keccak256 constants (see RoleRegistry.sol) -
// read them from the contract rather than hardcoding the hash client-side,
// so this can't silently drift if the contract ever changes them.
export async function getRolesForAddress(roleRegistry, address) {
  const [ADMIN_ROLE, MANAGER_ROLE, AUDITOR_ROLE, USER_ROLE, CO_SIGNER_ROLE] = await Promise.all([
    roleRegistry.ADMIN_ROLE(),
    roleRegistry.MANAGER_ROLE(),
    roleRegistry.AUDITOR_ROLE(),
    roleRegistry.USER_ROLE(),
    roleRegistry.CO_SIGNER_ROLE()
  ]);
  const [isAdmin, isManager, isAuditor, isUser, isCoSigner] = await Promise.all([
    roleRegistry.hasRole(ADMIN_ROLE, address),
    roleRegistry.hasRole(MANAGER_ROLE, address),
    roleRegistry.hasRole(AUDITOR_ROLE, address),
    roleRegistry.hasRole(USER_ROLE, address),
    roleRegistry.hasRole(CO_SIGNER_ROLE, address)
  ]);
  return { isAdmin, isManager, isAuditor, isUser, isCoSigner };
}

// Live on-chain read via the connected wallet, not the backend - same
// exception the architecture makes for role checks and getPaused(): it's
// UI-gating state ("has this specific connected address already approved
// this proposal, so hide the button"), not an indexed audit record.
export async function hasApproved(signerOrProvider, proposalId, address) {
  return getApprovalRegistry(signerOrProvider).hasApproved(proposalId, address);
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
  const contract = getIdentityRegistry(signer);
  return withFriendlyPauseErrors(contract, async () => {
    const tx = await contract.updateMetadata(newMetadataURI);
    return tx.wait();
  });
}

// EnforcedPause/ExpectedPause are declared in both ASSET_NFT_ABI and
// IDENTITY_REGISTRY_ABI (AssetNFT and IdentityRegistry each have their own,
// independent Pausable state - see IdentityRegistry.sol's pause()/unpause()
// doc comment), but ethers v6 doesn't reliably auto-decode a custom error's
// name back out of a CALL_EXCEPTION for every provider/call path (confirmed
// against Hardhat Network: Interface.parseError() decodes the raw revert
// data correctly, but the error ethers actually throws still says "unknown
// custom error"). Decode err.data ourselves as a fallback so a paused
// revert always surfaces a clear message instead of that opaque one. The
// message is intentionally generic (not "asset operations are paused") since
// this same helper wraps calls into both contracts - callers already know
// which operation they attempted.
const PAUSE_ERROR_MESSAGES = {
  EnforcedPause: "This operation is paused right now - try again once it's unpaused.",
  ExpectedPause: "This operation is not currently paused."
};

function withFriendlyPauseErrors(contract, fn) {
  return fn().catch((err) => {
    let parsed = null;
    if (err.data) {
      try {
        parsed = contract.interface.parseError(err.data);
      } catch {
        // err.data wasn't a recognized custom error selector - fall through.
      }
    }
    if (parsed && PAUSE_ERROR_MESSAGES[parsed.name]) {
      throw new Error(PAUSE_ERROR_MESSAGES[parsed.name]);
    }
    throw err;
  });
}

export async function mintAsset(signer, to, uri) {
  const contract = getAssetNFT(signer);
  return withFriendlyPauseErrors(contract, async () => {
    const tx = await contract.mintAsset(to, uri);
    return tx.wait();
  });
}

export async function transferAsset(signer, to, tokenId) {
  const contract = getAssetNFT(signer);
  return withFriendlyPauseErrors(contract, async () => {
    const tx = await contract.transferAsset(to, tokenId);
    return tx.wait();
  });
}

// Submits a registration an admin received from someone else (via
// signRegistration()'s signature + calldata, or scripts/signRegistration.js)
// - the account/did/metadataURI must match exactly what was signed, or the
// contract's signature check reverts.
export async function registerIdentity(signer, account, did, metadataURI, signature) {
  const contract = getIdentityRegistry(signer);
  return withFriendlyPauseErrors(contract, async () => {
    const tx = await contract.registerIdentity(account, did, metadataURI, signature);
    return tx.wait();
  });
}

// High-risk, 2-of-N co-signer gated (see ApprovalRegistry.sol / RoleRegistry's
// CO_SIGNER_ROLE) - this call only PROPOSES a revocation, it does not revoke
// anything by itself. A second, different co-signer must call
// approveRevokeIdentity() with the resulting proposal id (see the Pending
// Approvals list, fed by GET /api/approvals/pending) before it takes effect.
export async function revokeIdentity(signer, account) {
  const contract = getIdentityRegistry(signer);
  return withFriendlyPauseErrors(contract, async () => {
    const tx = await contract.revokeIdentity(account);
    return tx.wait();
  });
}

export async function approveRevokeIdentity(signer, proposalId) {
  const contract = getIdentityRegistry(signer);
  return withFriendlyPauseErrors(contract, async () => {
    const tx = await contract.approveRevokeIdentity(proposalId);
    return tx.wait();
  });
}

// High-risk, 2-of-N co-signer gated - like revokeIdentity(), this only
// proposes a reclaim (see approveReclaimAsset() for the second step).
export async function reclaimAsset(signer, tokenId, newOwner) {
  const contract = getAssetNFT(signer);
  return withFriendlyPauseErrors(contract, async () => {
    const tx = await contract.reclaimAsset(tokenId, newOwner);
    return tx.wait();
  });
}

export async function approveReclaimAsset(signer, proposalId) {
  const contract = getAssetNFT(signer);
  return withFriendlyPauseErrors(contract, async () => {
    const tx = await contract.approveReclaimAsset(proposalId);
    return tx.wait();
  });
}

// Two INDEPENDENT emergency circuit breakers, not one - see IdentityRegistry.sol's
// pause()/unpause() doc comment for why they're separate contracts/states rather
// than a single shared flag. While AssetNFT is paused, mintAsset/transferAsset/
// reclaimAsset revert EnforcedPause; while IdentityRegistry is paused,
// registerIdentity/revokeIdentity/approveRevokeIdentity/updateMetadata do (see
// withFriendlyPauseErrors above). Both getXPaused() reads are live on-chain reads
// via the connected wallet, not the backend - same exception the architecture
// already makes for role checks, since it's UI-gating state tied to the
// connected signer, not an indexed audit record.
export async function pauseAssets(signer) {
  const contract = getAssetNFT(signer);
  return withFriendlyPauseErrors(contract, async () => {
    const tx = await contract.pause();
    return tx.wait();
  });
}

export async function unpauseAssets(signer) {
  const contract = getAssetNFT(signer);
  return withFriendlyPauseErrors(contract, async () => {
    const tx = await contract.unpause();
    return tx.wait();
  });
}

export async function getAssetsPaused(signerOrProvider) {
  return getAssetNFT(signerOrProvider).paused();
}

export async function pauseIdentity(signer) {
  const contract = getIdentityRegistry(signer);
  return withFriendlyPauseErrors(contract, async () => {
    const tx = await contract.pause();
    return tx.wait();
  });
}

export async function unpauseIdentity(signer) {
  const contract = getIdentityRegistry(signer);
  return withFriendlyPauseErrors(contract, async () => {
    const tx = await contract.unpause();
    return tx.wait();
  });
}

export async function getIdentityPaused(signerOrProvider) {
  return getIdentityRegistry(signerOrProvider).paused();
}
