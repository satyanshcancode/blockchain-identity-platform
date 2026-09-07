const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const RoleRegistry = await hre.ethers.getContractFactory("RoleRegistry");
  const roleRegistry = await RoleRegistry.deploy(deployer.address);
  await roleRegistry.waitForDeployment();
  const roleRegistryAddress = await roleRegistry.getAddress();
  console.log("RoleRegistry:", roleRegistryAddress);

  const IdentityRegistry = await hre.ethers.getContractFactory("IdentityRegistry");
  const identityRegistry = await IdentityRegistry.deploy(roleRegistryAddress);
  await identityRegistry.waitForDeployment();
  const identityRegistryAddress = await identityRegistry.getAddress();
  console.log("IdentityRegistry:", identityRegistryAddress);

  const AssetNFT = await hre.ethers.getContractFactory("AssetNFT");
  const assetNFT = await AssetNFT.deploy(roleRegistryAddress, identityRegistryAddress);
  await assetNFT.waitForDeployment();
  const assetNFTAddress = await assetNFT.getAddress();
  console.log("AssetNFT:", assetNFTAddress);

  const addresses = {
    ROLE_REGISTRY_ADDRESS: roleRegistryAddress,
    IDENTITY_REGISTRY_ADDRESS: identityRegistryAddress,
    ASSET_NFT_ADDRESS: assetNFTAddress,
    deployedAt: new Date().toISOString()
  };

  // /shared is a Docker volume also mounted into the backend container (see
  // docker-compose.yml). When present, write the freshly deployed addresses
  // there so the backend picks them up automatically on startup instead of
  // needing them hand-copied into docker-compose.yml after every redeploy.
  const sharedDir = "/shared";
  if (fs.existsSync(sharedDir)) {
    const outPath = path.join(sharedDir, "addresses.json");
    fs.writeFileSync(outPath, JSON.stringify(addresses, null, 2));
    console.log("Wrote deployed addresses to", outPath);
  } else {
    console.log("\nCopy these addresses into backend/.env manually.");
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});