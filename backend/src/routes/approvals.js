const express = require("express");
const { ethers } = require("ethers");
const { getAllEvents } = require("../db");

const router = express.Router();

const APPROVAL_ABI = [
  "function getProposal(uint256 proposalId) view returns (address targetContract, uint8 actionType, bytes data, address proposer, uint256 approvalCount, bool executed, uint256 proposedAt)"
];

const ACTION_TYPE_NAMES = ["RevokeIdentity", "ReclaimAsset"];

function getProvider() {
  return new ethers.JsonRpcProvider(process.env.RPC_URL);
}

// getProposal() has no on-chain access restriction (proposals are about to
// become public via events anyway, and co-signers need to see them to decide
// whether to approve) - no privileged signer needed, unlike
// assets.js/identity.js's auditor/admin-gated reads.
function getApprovalContract() {
  return new ethers.Contract(process.env.APPROVAL_REGISTRY_ADDRESS, APPROVAL_ABI, getProvider());
}

// ApprovalRegistry has no "list every proposal" getter, same reasoning as
// assets.js's knownTokenIds(): the set of ids we know about comes from the
// persisted event log, but each one's CURRENT approvalCount/executed status
// is always re-fetched live, since it can have changed since the event was
// recorded.
function knownProposalIds() {
  const ids = new Set();
  for (const entry of getAllEvents()) {
    if (entry.type === "ActionProposed") ids.add(entry.proposalId);
  }
  return [...ids].sort((a, b) => Number(a) - Number(b));
}

function decodeActionData(actionType, data) {
  const coder = ethers.AbiCoder.defaultAbiCoder();
  if (actionType === 0) {
    const [account] = coder.decode(["address"], data);
    return { account };
  }
  if (actionType === 1) {
    const [tokenId, newOwner] = coder.decode(["uint256", "address"], data);
    return { tokenId: tokenId.toString(), newOwner };
  }
  return {};
}

// GET /api/approvals/pending - every not-yet-executed proposal (revokeIdentity
// or reclaimAsset awaiting its second co-signer approval), decoded into
// human-readable fields.
router.get("/pending", async (req, res) => {
  try {
    const contract = getApprovalContract();
    const ids = knownProposalIds();
    const results = await Promise.allSettled(
      ids.map(async (proposalId) => {
        const p = await contract.getProposal(proposalId);
        const actionType = Number(p.actionType);
        return {
          proposalId,
          actionType: ACTION_TYPE_NAMES[actionType] || `Unknown(${actionType})`,
          ...decodeActionData(actionType, p.data),
          proposer: p.proposer,
          approvalCount: Number(p.approvalCount),
          requiredApprovals: 2,
          executed: p.executed,
          proposedAt: p.proposedAt.toString()
        };
      })
    );

    const proposals = [];
    results.forEach((result, i) => {
      if (result.status === "fulfilled") {
        if (!result.value.executed) proposals.push(result.value);
      } else {
        console.warn(`GET /api/approvals/pending: skipping proposal ${ids[i]} - on-chain read failed: ${result.reason.message}`);
      }
    });
    res.json(proposals);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

module.exports = router;
