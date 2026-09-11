const express = require("express");
const { ethers } = require("ethers");
const { getAllEvents } = require("../db");
const { requireRole } = require("../auth/apiAuth");

const router = express.Router();

const APPROVAL_ABI = [
  "function getProposal(uint256 proposalId) view returns (address targetContract, uint8 actionType, bytes data, address proposer, uint256 approvalCount, bool executed, uint256 proposedAt)"
];

const ACTION_TYPE_NAMES = ["RevokeIdentity", "ReclaimAsset"];

function getProvider() {
  return new ethers.JsonRpcProvider(process.env.RPC_URL);
}

// getProposal() itself has no on-chain access restriction (proposals are
// about to become public via events anyway), so unlike assets.js/
// identity.js's privileged reads, fetching the data needs no special
// signer - a plain read-only provider is enough. The route below is still
// caller-gated at the HTTP layer via requireRole() (see ../auth/apiAuth.js):
// auditors need this for compliance review, co-signers need it to decide
// what to approve, and the actual approve action stays separately gated
// on-chain by onlyCoSigner regardless of who can merely read this list.
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
// human-readable fields. Auditor/co-signer/admin - see the note above
// getApprovalContract() for why auditor is read-only-equivalent here (the
// approve action itself is unaffected, still onlyCoSigner on-chain).
router.get("/pending", requireRole("AUDITOR", "CO_SIGNER", "ADMIN"), async (req, res) => {
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
