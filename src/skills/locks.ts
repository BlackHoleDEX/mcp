import { parseUnits } from "viem";

import { ERC20_ABI } from "../constants/contracts.js";
import { hasSufficientAllowance } from "../utils/erc20.js";
import { publicClient } from "../utils/viemClient.js";
import { getEnvUserAddress } from "../utils/wallet.js";

type AdvancedLockAction = "extend" | "withdraw" | "lockPermanent" | "unlockPermanent" | "claimRebase";

const VOTING_ESCROW_ABI = [
  {
    inputs: [],
    name: "token",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_value", type: "uint256" },
      { internalType: "uint256", name: "_lock_duration", type: "uint256" },
      { internalType: "bool", name: "isSMNFT", type: "bool" },
    ],
    name: "create_lock",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_tokenId", type: "uint256" },
      { internalType: "uint256", name: "_value", type: "uint256" },
    ],
    name: "increase_amount",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_tokenId", type: "uint256" },
      { internalType: "uint256", name: "_lock_duration", type: "uint256" },
      { internalType: "bool", name: "isSMNFT", type: "bool" },
    ],
    name: "increase_unlock_time",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "_from", type: "uint256" },
      { internalType: "uint256", name: "_to", type: "uint256" },
    ],
    name: "merge",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
    name: "lockPermanent",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
    name: "unlockPermanent",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const REWARDS_DISTRIBUTOR_ABI = [
  {
    inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
    name: "claim",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

function getVotingEscrowAddress(): `0x${string}` {
  return "0xEac562811cc6abDbB2c9EE88719eCA4eE79Ad763";
}

function getRewardsDistributorAddress(): `0x${string}` {
  return "0x7c7BD86BaF240dB3DbCc3f7a22B35c5bAa83bA28";
}

type StepPayload = {
  to: string;
  abi: any;
  functionName: string;
  args: any[];
  value: string;
};

type Step = {
  title: string;
  description: string;
  payload: StepPayload;
};

export interface CreateLockParams {
  userAddress?: string;
  amount: string;
  lockDurationInSeconds: number;
  isSMNFT?: boolean;
  amountDecimals?: number;
}

export interface IncreaseLockParams {
  userAddress?: string;
  tokenId: number;
  amount: string;
  amountDecimals?: number;
}

export interface MergeLockParams {
  userAddress?: string;
  fromTokenId: number;
  toTokenId: number;
}

export interface AdvancedLockParams {
  action: AdvancedLockAction;
  userAddress?: string;
  lockDurationInSeconds?: number;
  isSMNFT?: boolean;
  tokenId?: number;
}

async function getLockTokenAddress(votingEscrow: `0x${string}`): Promise<`0x${string}`> {
  return (await publicClient.readContract({
    address: votingEscrow,
    abi: VOTING_ESCROW_ABI,
    functionName: "token",
    args: [],
  })) as `0x${string}`;
}

async function buildApprovalStep(
  lockToken: `0x${string}`,
  votingEscrow: `0x${string}`,
  amountRaw: bigint,
  owner: string,
): Promise<Step | null> {
  const approved = await hasSufficientAllowance(lockToken, owner, votingEscrow, amountRaw);
  if (approved) return null;
  return {
    title: "Approve Lock Token",
    description: "Approve Voting Escrow to spend lock token amount.",
    payload: {
      to: lockToken,
      abi: ERC20_ABI,
      functionName: "approve",
      args: [votingEscrow, amountRaw.toString()],
      value: "0",
    },
  };
}

export async function handleCreateLockSteps(params: CreateLockParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const votingEscrow = getVotingEscrowAddress();
  const amountRaw = parseUnits(params.amount, params.amountDecimals ?? 18);
  const lockToken = await getLockTokenAddress(votingEscrow);
  const approvalStep = await buildApprovalStep(lockToken, votingEscrow, amountRaw, userAddress);
  const steps: Step[] = approvalStep ? [approvalStep] : [];

  const isSMNFT = !!params.isSMNFT;
  steps.push({
    title: "Execute create_lock",
    description: isSMNFT
      ? "Create a new permanent Super Massive veNFT (SMveNFT) lock."
      : "Create a new timed veNFT lock.",
    payload: {
      to: votingEscrow,
      abi: VOTING_ESCROW_ABI,
      functionName: "create_lock",
      args: [amountRaw.toString(), Math.floor(params.lockDurationInSeconds), isSMNFT],
      value: "0",
    },
  });

  return {
    success: true,
    lockType: isSMNFT ? "smnt_permanent" : "timed",
    message: isSMNFT
      ? "Computed SMveNFT create-lock steps. This lock is PERMANENT — it never expires."
      : "Computed create-lock transaction steps.",
    steps,
  };
}

export async function handleIncreaseLockSteps(params: IncreaseLockParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const votingEscrow = getVotingEscrowAddress();
  const amountRaw = parseUnits(params.amount, params.amountDecimals ?? 18);
  const lockToken = await getLockTokenAddress(votingEscrow);
  const approvalStep = await buildApprovalStep(lockToken, votingEscrow, amountRaw, userAddress);
  const steps: Step[] = approvalStep ? [approvalStep] : [];

  steps.push({
    title: "Execute increase_amount",
    description: "Increase amount locked in an existing veNFT lock.",
    payload: {
      to: votingEscrow,
      abi: VOTING_ESCROW_ABI,
      functionName: "increase_amount",
      args: [BigInt(params.tokenId), amountRaw.toString()],
      value: "0",
    },
  });

  return {
    success: true,
    message: "Computed increase-lock transaction steps.",
    steps,
  };
}

export async function handleMergeLockSteps(params: MergeLockParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const votingEscrow = getVotingEscrowAddress();

  return {
    success: true,
    message: "Computed merge-lock transaction steps.",
    steps: [
      {
        title: "Execute merge",
        description: "Merge source lock into destination lock.",
        payload: {
          to: votingEscrow,
          abi: VOTING_ESCROW_ABI,
          functionName: "merge",
          args: [BigInt(params.fromTokenId), BigInt(params.toTokenId)],
          value: "0",
        },
      },
    ],
  };
}

export async function handleAdvancedLockSteps(params: AdvancedLockParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const votingEscrow = getVotingEscrowAddress();
  const action = params.action;
  const steps: Step[] = [];

  if (action === "extend") {
    if (params.tokenId === undefined || !Number.isFinite(params.lockDurationInSeconds)) {
      throw new Error("For action='extend' provide tokenId and lockDurationInSeconds.");
    }
    steps.push({
      title: "Execute increase_unlock_time",
      description: "Extend unlock duration for an existing lock.",
      payload: {
        to: votingEscrow,
        abi: VOTING_ESCROW_ABI,
        functionName: "increase_unlock_time",
        args: [
          BigInt(params.tokenId),
          Math.floor(params.lockDurationInSeconds as number),
          !!params.isSMNFT,
        ],
        value: "0",
      },
    });
  } else if (action === "withdraw") {
    if (params.tokenId === undefined) {
      throw new Error("For action='withdraw' provide tokenId.");
    }
    steps.push({
      title: "Execute withdraw",
      description: "Withdraw lock after expiry.",
      payload: {
        to: votingEscrow,
        abi: VOTING_ESCROW_ABI,
        functionName: "withdraw",
        args: [BigInt(params.tokenId)],
        value: "0",
      },
    });
  } else if (action === "lockPermanent") {
    if (params.tokenId === undefined) {
      throw new Error("For action='lockPermanent' provide tokenId.");
    }
    steps.push({
      title: "Execute lockPermanent",
      description: "Convert existing lock to permanent lock.",
      payload: {
        to: votingEscrow,
        abi: VOTING_ESCROW_ABI,
        functionName: "lockPermanent",
        args: [BigInt(params.tokenId)],
        value: "0",
      },
    });
  } else if (action === "unlockPermanent") {
    if (params.tokenId === undefined) {
      throw new Error("For action='unlockPermanent' provide tokenId.");
    }
    steps.push({
      title: "Execute unlockPermanent",
      description: "Remove permanent lock status from a lock.",
      payload: {
        to: votingEscrow,
        abi: VOTING_ESCROW_ABI,
        functionName: "unlockPermanent",
        args: [BigInt(params.tokenId)],
        value: "0",
      },
    });
  } else if (action === "claimRebase") {
    if (params.tokenId === undefined) {
      throw new Error("For action='claimRebase' provide tokenId.");
    }
    steps.push({
      title: "Claim Rebase",
      description: `Claim rebase (anti-dilution) rewards for veNFT #${params.tokenId} from RewardsDistributor.`,
      payload: {
        to: getRewardsDistributorAddress(),
        abi: REWARDS_DISTRIBUTOR_ABI,
        functionName: "claim",
        args: [BigInt(params.tokenId)],
        value: "0",
      },
    });
  } else {
    throw new Error(`Unsupported advanced lock action "${action}".`);
  }

  return {
    success: true,
    message:
      "Computed advanced lock transaction steps. Supported actions: extend, withdraw, lockPermanent, unlockPermanent.",
    steps,
  };
}

export const createLockTool = {
  name: "create_lock_steps",
  description:
    "Returns transaction steps to create a new veNFT lock. Two modes: (1) Timed lock — set lockDurationInSeconds up to 4 years; (2) Permanent SMveNFT lock — set isSMNFT=true; the lock never expires regardless of lockDurationInSeconds.",
  inputSchema: {
    type: "object",
    properties: {
      userAddress: { type: "string", description: "Optional. User wallet address. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      amount: { type: "string", description: "Human-readable token amount to lock." },
      amountDecimals: { type: "number", description: "Token decimals for amount parsing (default 18)." },
      lockDurationInSeconds: {
        type: "number",
        description: "Lock duration in seconds (max 4 years). Required by the contract but has no effect on expiry when isSMNFT=true.",
      },
      isSMNFT: {
        type: "boolean",
        description: "Set true to create a permanent Super Massive veNFT (SMveNFT). The lock will never expire and grants additional voting power. This is NOT a 4-year lock — it is permanently locked.",
      },
    },
    required: ["amount", "lockDurationInSeconds"],
  },
};

export const increaseLockTool = {
  name: "increase_lock_steps",
  description: "Returns transaction steps to increase amount on an existing veNFT lock.",
  inputSchema: {
    type: "object",
    properties: {
      userAddress: { type: "string", description: "Optional. User wallet address. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      tokenId: { type: "number" },
      amount: { type: "string", description: "Human-readable amount to add to lock." },
      amountDecimals: { type: "number", description: "Token decimals for amount parsing (default 18)." },
    },
    required: ["tokenId", "amount"],
  },
};

export const mergeLockTool = {
  name: "merge_lock_steps",
  description: "Returns transaction steps to merge one veNFT lock into another.",
  inputSchema: {
    type: "object",
    properties: {
      userAddress: { type: "string", description: "Optional. User wallet address. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      fromTokenId: { type: "number", description: "Source lock tokenId." },
      toTokenId: { type: "number", description: "Destination lock tokenId." },
    },
    required: ["fromTokenId", "toTokenId"],
  },
};

export const advancedLockTool = {
  name: "lock_advanced_steps",
  description:
    "Returns advanced veNFT lock operation steps. Actions: 'extend' (extend unlock time, max 4 years; set isSMNFT=true to make it a permanent SMveNFT instead), 'withdraw' (withdraw expired lock), 'lockPermanent' (convert existing lock to permanent — no expiry), 'unlockPermanent' (revert a permanent lock back to timed), 'claimRebase' (claim rebase/anti-dilution rewards from RewardsDistributor — use when get_user_locks shows non-zero rebaseClaimable). Note: SMveNFT (isSMNFT=true) and lockPermanent are both permanent but are distinct lock types.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["extend", "withdraw", "lockPermanent", "unlockPermanent", "claimRebase"] },
      userAddress: { type: "string", description: "Optional. User wallet address. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      tokenId: { type: "number" },
      lockDurationInSeconds: {
        type: "number",
        description:
          "Required for action='extend'. Lock duration in seconds (max 4 years). Ignored for expiry when isSMNFT=true.",
      },
      isSMNFT: {
        type: "boolean",
        description: "For action='extend': set true to extend as a permanent SMveNFT. The lock will never expire.",
      },
    },
    required: ["action"],
  },
};
