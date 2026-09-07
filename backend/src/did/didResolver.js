// Resolves a DID / on-chain identity for a given address.
require("dotenv").config();
const { ethers } = require("ethers");

const abi = [
  "function getIdentity(address account) view returns (tuple(string did, string metadataURI, bool active))"
];

async function resolveDID(address) {
  const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
  const contract = new ethers.Contract(process.env.IDENTITY_REGISTRY_ADDRESS, abi, provider);
  return contract.getIdentity(address);
}

module.exports = { resolveDID };
