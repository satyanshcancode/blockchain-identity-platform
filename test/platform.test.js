const { expect } = require("chai");
const { ethers } = require("hardhat");

async function signRegistration(identities, signer, account, did, metadataURI) {
  const { chainId } = await ethers.provider.getNetwork();
  const domain = {
    name: "IdentityRegistry",
    version: "1",
    chainId,
    verifyingContract: await identities.getAddress()
  };
  const types = {
    RegisterIdentity: [
      { name: "account", type: "address" },
      { name: "did", type: "string" },
      { name: "metadataURI", type: "string" },
      { name: "nonce", type: "uint256" }
    ]
  };
  const nonce = await identities.nonces(account);
  const value = { account, did, metadataURI, nonce };
  return signer.signTypedData(domain, types, value);
}

describe("Platform core flow", function () {
  async function deployPlatform() {
    const [admin, manager, auditor, user, user2, outsider] = await ethers.getSigners();

    const RoleRegistry = await ethers.getContractFactory("RoleRegistry");
    const roles = await RoleRegistry.deploy(admin.address);
    await roles.waitForDeployment();

    const MANAGER_ROLE = await roles.MANAGER_ROLE();
    const AUDITOR_ROLE = await roles.AUDITOR_ROLE();
    const USER_ROLE = await roles.USER_ROLE();

    await roles.assignRole(MANAGER_ROLE, manager.address);
    await roles.assignRole(AUDITOR_ROLE, auditor.address);
    await roles.assignRole(USER_ROLE, user.address);
    await roles.assignRole(USER_ROLE, user2.address);

    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    const identities = await IdentityRegistry.deploy(await roles.getAddress());
    await identities.waitForDeployment();

    const user1Sig = await signRegistration(identities, user, user.address, "did:ethr:0xUser", "ipfs://profile");
    await identities.registerIdentity(user.address, "did:ethr:0xUser", "ipfs://profile", user1Sig);

    const user2Sig = await signRegistration(identities, user2, user2.address, "did:ethr:0xUser2", "ipfs://profile2");
    await identities.registerIdentity(user2.address, "did:ethr:0xUser2", "ipfs://profile2", user2Sig);

    const AssetNFT = await ethers.getContractFactory("AssetNFT");
    const assets = await AssetNFT.deploy(await roles.getAddress(), await identities.getAddress());
    await assets.waitForDeployment();

    return { admin, manager, auditor, user, user2, outsider, roles, identities, assets, MANAGER_ROLE, AUDITOR_ROLE, USER_ROLE };
  }

  it("registers an identity, assigns a role, and mints an asset", async function () {
    const { manager, user, identities, assets } = await deployPlatform();

    const id = await identities.getIdentity(user.address);
    expect(id.active).to.equal(true);

    await expect(assets.connect(manager).mintAsset(user.address, "ipfs://asset-1"))
      .to.emit(assets, "AssetMinted");

    expect(await assets.ownerOf(0)).to.equal(user.address);
  });

  it("requires the registered account's own EIP-712 signature, and rejects replay", async function () {
    const { admin, outsider, roles, identities } = await deployPlatform();

    const [, , , , , , freshAccount] = await ethers.getSigners();
    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    const freshIdentities = await IdentityRegistry.deploy(await roles.getAddress());
    await freshIdentities.waitForDeployment();

    // Signature from the wrong account is rejected.
    const wrongSig = await signRegistration(
      freshIdentities, outsider, freshAccount.address, "did:ethr:0xFresh", "ipfs://fresh"
    );
    await expect(
      freshIdentities.connect(admin).registerIdentity(freshAccount.address, "did:ethr:0xFresh", "ipfs://fresh", wrongSig)
    ).to.be.revertedWith("Invalid registration signature");

    // Correct signature succeeds.
    const goodSig = await signRegistration(
      freshIdentities, freshAccount, freshAccount.address, "did:ethr:0xFresh", "ipfs://fresh"
    );
    await expect(
      freshIdentities.connect(admin).registerIdentity(freshAccount.address, "did:ethr:0xFresh", "ipfs://fresh", goodSig)
    ).to.emit(freshIdentities, "IdentityRegistered");

    // Replaying the same signature fails because the nonce already advanced.
    await expect(
      freshIdentities.connect(admin).registerIdentity(freshAccount.address, "did:ethr:0xFresh", "ipfs://fresh", goodSig)
    ).to.be.revertedWith("Invalid registration signature");
  });

  it("lets a USER_ROLE identity update their own metadata, but blocks non-users", async function () {
    const { user, outsider, identities } = await deployPlatform();

    await expect(identities.connect(user).updateMetadata("ipfs://profile-v2"))
      .to.emit(identities, "IdentityMetadataUpdated")
      .withArgs(user.address, "ipfs://profile-v2");

    const updated = await identities.getIdentity(user.address);
    expect(updated.metadataURI).to.equal("ipfs://profile-v2");

    // outsider has no USER_ROLE at all
    await expect(identities.connect(outsider).updateMetadata("ipfs://hijack"))
      .to.be.revertedWith("Not a registered user");
  });

  it("only lets AUDITOR_ROLE (or admin) read compliance records", async function () {
    const { admin, auditor, user, outsider, identities } = await deployPlatform();

    const asAuditor = await identities.connect(auditor).getComplianceRecord(user.address);
    expect(asAuditor.registeredAt).to.be.greaterThan(0);
    expect(asAuditor.revocationCount).to.equal(0);

    const asAdmin = await identities.connect(admin).getComplianceRecord(user.address);
    expect(asAdmin.registeredAt).to.equal(asAuditor.registeredAt);

    await expect(identities.connect(outsider).getComplianceRecord(user.address))
      .to.be.revertedWith("Not auditor or admin");
  });

  it("requires USER_ROLE to transfer an asset, and records provenance for auditors", async function () {
    const { manager, auditor, user, user2, outsider, identities, assets } = await deployPlatform();

    await assets.connect(manager).mintAsset(user.address, "ipfs://asset-1");

    // outsider holds no asset and no USER_ROLE — should fail on the role check first
    await expect(assets.connect(outsider).transferAsset(user2.address, 0))
      .to.be.revertedWith("Not a registered user");

    await expect(assets.connect(user).transferAsset(user2.address, 0))
      .to.emit(assets, "AssetTransferred")
      .withArgs(0, user.address, user2.address);

    expect(await assets.ownerOf(0)).to.equal(user2.address);

    const history = await assets.connect(auditor).getTransferHistory(0);
    expect(history.length).to.equal(2); // mint (0x0 -> user) + transfer (user -> user2)
    expect(history[0].from).to.equal(ethers.ZeroAddress);
    expect(history[1].to).to.equal(user2.address);

    await expect(assets.connect(outsider).getTransferHistory(0))
      .to.be.revertedWith("Not auditor or admin");
  });

  it("blocks a revoked identity from transferring an asset it already holds", async function () {
    const { admin, manager, user, user2, identities, assets } = await deployPlatform();

    await assets.connect(manager).mintAsset(user.address, "ipfs://asset-1");

    await identities.connect(admin).revokeIdentity(user.address);

    await expect(assets.connect(user).transferAsset(user2.address, 0))
      .to.be.revertedWith("Sender identity not active");

    // Asset didn't move.
    expect(await assets.ownerOf(0)).to.equal(user.address);
  });

  it("lets an admin reclaim an asset from a revoked identity to an active one", async function () {
    const { admin, manager, user, user2, auditor, identities, assets } = await deployPlatform();

    await assets.connect(manager).mintAsset(user.address, "ipfs://asset-1");
    await identities.connect(admin).revokeIdentity(user.address);

    await expect(assets.connect(admin).reclaimAsset(0, user2.address))
      .to.emit(assets, "AssetReclaimed")
      .withArgs(0, user.address, user2.address);

    expect(await assets.ownerOf(0)).to.equal(user2.address);

    // The reclaim shows up in provenance alongside the mint, distinguishable
    // from a normal transfer by cross-referencing revokedAt on the compliance record.
    const history = await assets.connect(auditor).getTransferHistory(0);
    expect(history.length).to.equal(2);
    expect(history[1].from).to.equal(user.address);
    expect(history[1].to).to.equal(user2.address);

    const compliance = await identities.connect(auditor).getComplianceRecord(user.address);
    expect(compliance.revokedAt).to.be.greaterThan(0);
    expect(history[1].timestamp).to.be.greaterThanOrEqual(compliance.revokedAt);
  });

  it("refuses reclaimAsset while the current owner's identity is still active", async function () {
    const { admin, manager, user, user2, assets } = await deployPlatform();

    await assets.connect(manager).mintAsset(user.address, "ipfs://asset-1");

    // user's identity was never revoked - reclaim must not act as a general force-transfer.
    await expect(assets.connect(admin).reclaimAsset(0, user2.address))
      .to.be.revertedWith("Current owner identity still active");

    expect(await assets.ownerOf(0)).to.equal(user.address);
  });

  it("lets only admin pause and unpause the platform, emitting PlatformPaused/PlatformUnpaused", async function () {
    const { admin, manager, auditor, assets } = await deployPlatform();

    await expect(assets.connect(manager).pause()).to.be.revertedWith("Not admin");
    await expect(assets.connect(auditor).pause()).to.be.revertedWith("Not admin");
    expect(await assets.paused()).to.equal(false);

    await expect(assets.connect(admin).pause())
      .to.emit(assets, "PlatformPaused")
      .withArgs(admin.address);
    expect(await assets.paused()).to.equal(true);

    await expect(assets.connect(manager).unpause()).to.be.revertedWith("Not admin");
    expect(await assets.paused()).to.equal(true);

    await expect(assets.connect(admin).unpause())
      .to.emit(assets, "PlatformUnpaused")
      .withArgs(admin.address);
    expect(await assets.paused()).to.equal(false);
  });

  it("blocks minting, transferring, and reclaiming while paused - even for admin/manager - and restores them after unpause", async function () {
    const { admin, manager, user, user2, outsider, identities, assets } = await deployPlatform();

    // A third identity, revoked below, so the reclaim precondition (owner
    // revoked) is set up without disturbing user2 - the transfer check later
    // needs user2 to still be a valid (active) recipient. No USER_ROLE
    // needed: outsider only ever receives/holds a token here, never calls
    // anything.
    const outsiderSig = await signRegistration(
      identities, outsider, outsider.address, "did:ethr:0xOutsider", "ipfs://outsider"
    );
    await identities.connect(admin).registerIdentity(outsider.address, "did:ethr:0xOutsider", "ipfs://outsider", outsiderSig);

    await assets.connect(manager).mintAsset(user.address, "ipfs://asset-1"); // token 0: user, stays active
    await assets.connect(manager).mintAsset(outsider.address, "ipfs://asset-2"); // token 1: outsider, about to be revoked
    await identities.connect(admin).revokeIdentity(outsider.address);

    await assets.connect(admin).pause();

    // Manager, who is otherwise authorized to mint, is blocked by the pause itself.
    await expect(assets.connect(manager).mintAsset(user.address, "ipfs://asset-3"))
      .to.be.revertedWithCustomError(assets, "EnforcedPause");

    // A user with a valid, ownable transfer is blocked by the pause itself.
    await expect(assets.connect(user).transferAsset(user2.address, 0))
      .to.be.revertedWithCustomError(assets, "EnforcedPause");

    // Admin, who is otherwise authorized to reclaim a revoked owner's asset, is
    // blocked by the pause itself.
    await expect(assets.connect(admin).reclaimAsset(1, user.address))
      .to.be.revertedWithCustomError(assets, "EnforcedPause");

    // Nothing moved while paused.
    expect(await assets.ownerOf(0)).to.equal(user.address);
    expect(await assets.ownerOf(1)).to.equal(outsider.address);

    await assets.connect(admin).unpause();

    // The exact same operations now succeed normally.
    await expect(assets.connect(manager).mintAsset(user.address, "ipfs://asset-3"))
      .to.emit(assets, "AssetMinted");
    await expect(assets.connect(user).transferAsset(user2.address, 0))
      .to.emit(assets, "AssetTransferred");
    await expect(assets.connect(admin).reclaimAsset(1, user.address))
      .to.emit(assets, "AssetReclaimed");

    expect(await assets.ownerOf(0)).to.equal(user2.address);
    expect(await assets.ownerOf(1)).to.equal(user.address);
  });
});