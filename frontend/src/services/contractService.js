import { BrowserProvider, Contract } from "ethers";

// Fill in after deployment (see scripts/deploy.js output).
export const IDENTITY_REGISTRY_ADDRESS = "";
export const ASSET_NFT_ADDRESS = "";
export const ROLE_REGISTRY_ADDRESS = "";

export async function getSignerAndProvider() {
  if (!window.ethereum) throw new Error("MetaMask not found");
  const provider = new BrowserProvider(window.ethereum);
  await provider.send("eth_requestAccounts", []);
  const signer = await provider.getSigner();
  return { provider, signer };
}

// Example: export function getIdentityContract(signer) {
//   return new Contract(IDENTITY_REGISTRY_ADDRESS, IDENTITY_ABI, signer);
// }
