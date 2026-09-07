// Listens for on-chain events and stores them for fast querying.
// Swap the in-memory array below for a real database (Postgres/Mongo) in production.
require("dotenv").config();
const { ethers } = require("ethers");

const provider = new ethers.JsonRpcProvider(process.env.RPC_URL);
const auditLog = [];

const identityAbi = ["event IdentityRegistered(address indexed account, string did, string metadataURI)"];
const assetAbi = [
  "event AssetMinted(uint256 indexed tokenId, address indexed owner, string uri)",
  "event AssetTransferred(uint256 indexed tokenId, address indexed from, address indexed to)",
  "event AssetReclaimed(uint256 indexed tokenId, address indexed from, address indexed to)"
];

async function start() {
  const identityContract = new ethers.Contract(process.env.IDENTITY_REGISTRY_ADDRESS, identityAbi, provider);
  const assetContract = new ethers.Contract(process.env.ASSET_NFT_ADDRESS, assetAbi, provider);

  identityContract.on("IdentityRegistered", (account, did, uri) => {
    auditLog.push({ type: "IdentityRegistered", account, did, uri, ts: Date.now() });
    console.log("Identity registered:", account, did);
  });

  assetContract.on("AssetMinted", (tokenId, owner, uri) => {
    auditLog.push({ type: "AssetMinted", tokenId: tokenId.toString(), owner, uri, ts: Date.now() });
    console.log("Asset minted:", tokenId.toString(), owner);
  });

  assetContract.on("AssetTransferred", (tokenId, from, to) => {
    auditLog.push({ type: "AssetTransferred", tokenId: tokenId.toString(), from, to, ts: Date.now() });
    console.log("Asset transferred:", tokenId.toString(), from, "->", to);
  });

  assetContract.on("AssetReclaimed", (tokenId, from, to) => {
    auditLog.push({ type: "AssetReclaimed", tokenId: tokenId.toString(), from, to, ts: Date.now() });
    console.log("Asset reclaimed:", tokenId.toString(), from, "->", to);
  });

  console.log("Indexer listening for events...");
}

start();
module.exports = { auditLog };
