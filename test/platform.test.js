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

// Reads the ActionProposed event out of a revokeIdentity()/reclaimAsset()
// transaction's receipt to get the proposal id ApprovalRegistry assigned it -
// the real (non-static) transaction doesn't hand back its return value
// directly, so the id has to come from the log the same way a real caller
// (e.g. the frontend) would get it.
async function getProposalId(tx, approvalRegistry) {
  const receipt = await tx.wait();
  for (const log of receipt.logs) {
    try {
      const parsed = approvalRegistry.interface.parseLog(log);
      if (parsed && parsed.name === "ActionProposed") return parsed.args.proposalId;
    } catch {
      // Not a log ApprovalRegistry's interface recognizes - skip it.
    }
  }
  throw new Error("ActionProposed event not found in transaction receipt");
}

describe("Platform core flow", function () {
  async function deployPlatform() {
    const [admin, manager, auditor, user, user2, outsider, coSigner2, coSigner3] = await ethers.getSigners();

    const RoleRegistry = await ethers.getContractFactory("RoleRegistry");
    const roles = await RoleRegistry.deploy(admin.address);
    await roles.waitForDeployment();

    const ADMIN_ROLE = await roles.ADMIN_ROLE();
    const MANAGER_ROLE = await roles.MANAGER_ROLE();
    const AUDITOR_ROLE = await roles.AUDITOR_ROLE();
    const USER_ROLE = await roles.USER_ROLE();
    const CO_SIGNER_ROLE = await roles.CO_SIGNER_ROLE();

    await roles.assignRole(MANAGER_ROLE, manager.address);
    await roles.assignRole(AUDITOR_ROLE, auditor.address);
    await roles.assignRole(USER_ROLE, user.address);
    await roles.assignRole(USER_ROLE, user2.address);

    // 3 designated co-signers (2-of-3 required) - admin plus two more,
    // deliberately independent of ADMIN_ROLE membership (manager/auditor/
    // user/user2/outsider hold no CO_SIGNER_ROLE at all here).
    await roles.assignRole(CO_SIGNER_ROLE, admin.address);
    await roles.assignRole(CO_SIGNER_ROLE, coSigner2.address);
    await roles.assignRole(CO_SIGNER_ROLE, coSigner3.address);

    const ApprovalRegistry = await ethers.getContractFactory("ApprovalRegistry");
    const approvalRegistry = await ApprovalRegistry.deploy(await roles.getAddress());
    await approvalRegistry.waitForDeployment();

    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    const identities = await IdentityRegistry.deploy(await roles.getAddress(), await approvalRegistry.getAddress());
    await identities.waitForDeployment();

    const user1Sig = await signRegistration(identities, user, user.address, "did:ethr:0xUser", "ipfs://profile");
    await identities.registerIdentity(user.address, "did:ethr:0xUser", "ipfs://profile", user1Sig);

    const user2Sig = await signRegistration(identities, user2, user2.address, "did:ethr:0xUser2", "ipfs://profile2");
    await identities.registerIdentity(user2.address, "did:ethr:0xUser2", "ipfs://profile2", user2Sig);

    const AssetNFT = await ethers.getContractFactory("AssetNFT");
    const assets = await AssetNFT.deploy(
      await roles.getAddress(),
      await identities.getAddress(),
      await approvalRegistry.getAddress()
    );
    await assets.waitForDeployment();

    await approvalRegistry.setAuthorizedCaller(await identities.getAddress(), true);
    await approvalRegistry.setAuthorizedCaller(await assets.getAddress(), true);

    return {
      admin,
      manager,
      auditor,
      user,
      user2,
      outsider,
      coSigner2,
      coSigner3,
      roles,
      approvalRegistry,
      identities,
      assets,
      ADMIN_ROLE,
      MANAGER_ROLE,
      AUDITOR_ROLE,
      USER_ROLE,
      CO_SIGNER_ROLE
    };
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
    const { admin, outsider, roles, approvalRegistry } = await deployPlatform();

    const [, , , , , , , , freshAccount] = await ethers.getSigners();
    const IdentityRegistry = await ethers.getContractFactory("IdentityRegistry");
    const freshIdentities = await IdentityRegistry.deploy(await roles.getAddress(), await approvalRegistry.getAddress());
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
    const { admin, coSigner2, manager, user, user2, identities, assets, approvalRegistry } = await deployPlatform();

    await assets.connect(manager).mintAsset(user.address, "ipfs://asset-1");

    const tx = await identities.connect(admin).revokeIdentity(user.address);
    const proposalId = await getProposalId(tx, approvalRegistry);
    await identities.connect(coSigner2).approveRevokeIdentity(proposalId);
    expect((await identities.getIdentity(user.address)).active).to.equal(false);

    await expect(assets.connect(user).transferAsset(user2.address, 0))
      .to.be.revertedWith("Sender identity not active");

    // Asset didn't move.
    expect(await assets.ownerOf(0)).to.equal(user.address);
  });

  it("lets co-signers reclaim an asset from a revoked identity to an active one, via 2-of-N approval", async function () {
    const { admin, coSigner2, manager, user, user2, auditor, identities, assets, approvalRegistry } = await deployPlatform();

    await assets.connect(manager).mintAsset(user.address, "ipfs://asset-1");

    const revokeTx = await identities.connect(admin).revokeIdentity(user.address);
    const revokeProposalId = await getProposalId(revokeTx, approvalRegistry);
    await identities.connect(coSigner2).approveRevokeIdentity(revokeProposalId);

    // Proposing the reclaim alone doesn't move it yet.
    const reclaimTx = await assets.connect(admin).reclaimAsset(0, user2.address);
    const reclaimProposalId = await getProposalId(reclaimTx, approvalRegistry);
    expect(await assets.ownerOf(0)).to.equal(user.address);

    await expect(assets.connect(coSigner2).approveReclaimAsset(reclaimProposalId))
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

  it("refuses to even propose reclaimAsset while the current owner's identity is still active", async function () {
    const { admin, manager, user, user2, assets } = await deployPlatform();

    await assets.connect(manager).mintAsset(user.address, "ipfs://asset-1");

    // user's identity was never revoked - reclaim must not act as a general
    // force-transfer. Checked at propose time (fail fast) as well as at
    // approve/execute time, so a doomed proposal never gets created for
    // co-signers to waste an approval on.
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
    const { admin, coSigner2, manager, user, user2, outsider, identities, assets, approvalRegistry } = await deployPlatform();

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

    const revokeTx = await identities.connect(admin).revokeIdentity(outsider.address);
    const revokeProposalId = await getProposalId(revokeTx, approvalRegistry);
    await identities.connect(coSigner2).approveRevokeIdentity(revokeProposalId);

    await assets.connect(admin).pause();

    // Manager, who is otherwise authorized to mint, is blocked by the pause itself.
    await expect(assets.connect(manager).mintAsset(user.address, "ipfs://asset-3"))
      .to.be.revertedWithCustomError(assets, "EnforcedPause");

    // A user with a valid, ownable transfer is blocked by the pause itself.
    await expect(assets.connect(user).transferAsset(user2.address, 0))
      .to.be.revertedWithCustomError(assets, "EnforcedPause");

    // A co-signer proposing an otherwise-valid reclaim is blocked by the pause itself.
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

    const reclaimTx = await assets.connect(admin).reclaimAsset(1, user.address);
    const reclaimProposalId = await getProposalId(reclaimTx, approvalRegistry);
    await expect(assets.connect(coSigner2).approveReclaimAsset(reclaimProposalId))
      .to.emit(assets, "AssetReclaimed");

    expect(await assets.ownerOf(0)).to.equal(user2.address);
    expect(await assets.ownerOf(1)).to.equal(user.address);
  });

  it("lets only admin pause and unpause IdentityRegistry, emitting IdentityRegistryPaused/IdentityRegistryUnpaused", async function () {
    const { admin, manager, auditor, identities } = await deployPlatform();

    await expect(identities.connect(manager).pause()).to.be.revertedWith("Not admin");
    await expect(identities.connect(auditor).pause()).to.be.revertedWith("Not admin");
    expect(await identities.paused()).to.equal(false);

    await expect(identities.connect(admin).pause())
      .to.emit(identities, "IdentityRegistryPaused")
      .withArgs(admin.address);
    expect(await identities.paused()).to.equal(true);

    await expect(identities.connect(manager).unpause()).to.be.revertedWith("Not admin");
    expect(await identities.paused()).to.equal(true);

    await expect(identities.connect(admin).unpause())
      .to.emit(identities, "IdentityRegistryUnpaused")
      .withArgs(admin.address);
    expect(await identities.paused()).to.equal(false);
  });

  it("blocks registerIdentity, revokeIdentity, approveRevokeIdentity, and updateMetadata while IdentityRegistry is paused - independently of AssetNFT's own pause - and restores them after unpause", async function () {
    const { admin, coSigner2, manager, user, identities, assets, approvalRegistry } = await deployPlatform();

    // Propose a revoke BEFORE pausing, so there's a pending proposal on hand
    // to try (and fail) approving once paused.
    const revokeTx = await identities.connect(admin).revokeIdentity(user.address);
    const proposalId = await getProposalId(revokeTx, approvalRegistry);

    const freshSig = await signRegistration(
      identities, coSigner2, coSigner2.address, "did:ethr:0xFreshPause", "ipfs://fresh-pause"
    );

    await identities.connect(admin).pause();
    expect(await identities.paused()).to.equal(true);

    await expect(
      identities.connect(admin).registerIdentity(coSigner2.address, "did:ethr:0xFreshPause", "ipfs://fresh-pause", freshSig)
    ).to.be.revertedWithCustomError(identities, "EnforcedPause");

    await expect(identities.connect(admin).revokeIdentity(coSigner2.address))
      .to.be.revertedWithCustomError(identities, "EnforcedPause");

    await expect(identities.connect(coSigner2).approveRevokeIdentity(proposalId))
      .to.be.revertedWithCustomError(identities, "EnforcedPause");

    await expect(identities.connect(user).updateMetadata("ipfs://blocked"))
      .to.be.revertedWithCustomError(identities, "EnforcedPause");

    // AssetNFT has its own, separate pause state - unaffected by IdentityRegistry's.
    await expect(assets.connect(manager).mintAsset(user.address, "ipfs://still-works"))
      .to.emit(assets, "AssetMinted");

    // Nothing moved: the pending revoke proposal never executed.
    expect((await identities.getIdentity(user.address)).active).to.equal(true);

    await identities.connect(admin).unpause();
    expect(await identities.paused()).to.equal(false);

    // The exact same operations now succeed normally.
    await expect(
      identities.connect(admin).registerIdentity(coSigner2.address, "did:ethr:0xFreshPause", "ipfs://fresh-pause", freshSig)
    ).to.emit(identities, "IdentityRegistered");

    await expect(identities.connect(user).updateMetadata("ipfs://unblocked"))
      .to.emit(identities, "IdentityMetadataUpdated");

    await expect(identities.connect(coSigner2).approveRevokeIdentity(proposalId))
      .to.emit(identities, "IdentityRevoked")
      .withArgs(user.address);
  });

  it("does not execute a proposal on a single co-signer's call, and rejects the proposer approving their own proposal again", async function () {
    const { admin, coSigner2, coSigner3, user, identities, approvalRegistry } = await deployPlatform();

    const tx = await identities.connect(admin).revokeIdentity(user.address);
    const proposalId = await getProposalId(tx, approvalRegistry);

    // The proposer's call counts as the first approval, but that alone
    // doesn't execute anything yet.
    expect((await identities.getIdentity(user.address)).active).to.equal(true);
    let proposal = await approvalRegistry.getProposal(proposalId);
    expect(proposal.approvalCount).to.equal(1);
    expect(proposal.executed).to.equal(false);

    // The same co-signer (the proposer) approving their own proposal again
    // does not count as a second approval.
    await expect(identities.connect(admin).approveRevokeIdentity(proposalId))
      .to.be.revertedWith("Already approved");
    proposal = await approvalRegistry.getProposal(proposalId);
    expect(proposal.approvalCount).to.equal(1);
    expect((await identities.getIdentity(user.address)).active).to.equal(true);

    // A second, DIFFERENT co-signer's approval executes it.
    await expect(identities.connect(coSigner2).approveRevokeIdentity(proposalId))
      .to.emit(identities, "IdentityRevoked")
      .withArgs(user.address);
    expect((await identities.getIdentity(user.address)).active).to.equal(false);

    // Approving an already-executed proposal is rejected too.
    await expect(identities.connect(coSigner3).approveRevokeIdentity(proposalId))
      .to.be.revertedWith("Already executed");
  });

  it("does not let a non-co-signer propose or approve - even one who separately holds ADMIN_ROLE", async function () {
    const { admin, manager, outsider, user, roles, ADMIN_ROLE, identities, approvalRegistry } = await deployPlatform();

    await expect(identities.connect(manager).revokeIdentity(user.address))
      .to.be.revertedWith("Not a co-signer");

    // Being ADMIN_ROLE alone still isn't enough - co-signer status is
    // deliberately independent, per RoleRegistry's CO_SIGNER_ROLE design.
    await roles.assignRole(ADMIN_ROLE, outsider.address);
    await expect(identities.connect(outsider).revokeIdentity(user.address))
      .to.be.revertedWith("Not a co-signer");

    const tx = await identities.connect(admin).revokeIdentity(user.address);
    const proposalId = await getProposalId(tx, approvalRegistry);

    await expect(identities.connect(manager).approveRevokeIdentity(proposalId))
      .to.be.revertedWith("Not a co-signer");
    await expect(identities.connect(outsider).approveRevokeIdentity(proposalId))
      .to.be.revertedWith("Not a co-signer");

    // Still not executed.
    expect((await identities.getIdentity(user.address)).active).to.equal(true);
  });
});