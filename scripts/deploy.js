const hre = require("hardhat");
const fs = require("fs");
const path = require("path");

// Local/dev-only designated co-signers for the 2-of-3 multi-sig approval
// flow on revokeIdentity()/reclaimAsset() (see ApprovalRegistry.sol) - the
// deployer plus Hardhat's default accounts #1 and #2. Override via
// CO_SIGNER_2/CO_SIGNER_3 env vars for a non-Hardhat network.
async function main() {
  const [deployer, defaultCoSigner2, defaultCoSigner3] = await hre.ethers.getSigners();
  console.log("Deploying with account:", deployer.address);

  const coSigner2 = process.env.CO_SIGNER_2 || defaultCoSigner2.address;
  const coSigner3 = process.env.CO_SIGNER_3 || defaultCoSigner3.address;

  const RoleRegistry = await hre.ethers.getContractFactory("RoleRegistry");
  const roleRegistry = await RoleRegistry.deploy(deployer.address);
  await roleRegistry.waitForDeployment();
  const roleRegistryAddress = await roleRegistry.getAddress();
  console.log("RoleRegistry:", roleRegistryAddress);

  const ApprovalRegistry = await hre.ethers.getContractFactory("ApprovalRegistry");
  const approvalRegistry = await ApprovalRegistry.deploy(roleRegistryAddress);
  await approvalRegistry.waitForDeployment();
  const approvalRegistryAddress = await approvalRegistry.getAddress();
  console.log("ApprovalRegistry:", approvalRegistryAddress);

  const IdentityRegistry = await hre.ethers.getContractFactory("IdentityRegistry");
  const identityRegistry = await IdentityRegistry.deploy(roleRegistryAddress, approvalRegistryAddress);
  await identityRegistry.waitForDeployment();
  const identityRegistryAddress = await identityRegistry.getAddress();
  console.log("IdentityRegistry:", identityRegistryAddress);

  const AssetNFT = await hre.ethers.getContractFactory("AssetNFT");
  const assetNFT = await AssetNFT.deploy(roleRegistryAddress, identityRegistryAddress, approvalRegistryAddress);
  await assetNFT.waitForDeployment();
  const assetNFTAddress = await assetNFT.getAddress();
  console.log("AssetNFT:", assetNFTAddress);

  // Wire up the multi-sig: designate 3 co-signers (2-of-3 required to
  // execute), and tell ApprovalRegistry which contracts are allowed to
  // propose/approve through it. Both steps need addresses that only exist
  // after the deployments above, so they can't happen at construction time.
  const CO_SIGNER_ROLE = await roleRegistry.CO_SIGNER_ROLE();
  await (await roleRegistry.assignRole(CO_SIGNER_ROLE, deployer.address)).wait();
  await (await roleRegistry.assignRole(CO_SIGNER_ROLE, coSigner2)).wait();
  await (await roleRegistry.assignRole(CO_SIGNER_ROLE, coSigner3)).wait();
  console.log("Co-signers:", deployer.address, coSigner2, coSigner3);

  await (await approvalRegistry.setAuthorizedCaller(identityRegistryAddress, true)).wait();
  await (await approvalRegistry.setAuthorizedCaller(assetNFTAddress, true)).wait();

  const addresses = {
    ROLE_REGISTRY_ADDRESS: roleRegistryAddress,
    APPROVAL_REGISTRY_ADDRESS: approvalRegistryAddress,
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
