import { parseUnits } from "viem";

import { hasSufficientAllowance } from "../utils/erc20.js";
import { getEnvUserAddress } from "../utils/wallet.js";

const BRIBE_ABI = [
  {
    inputs: [
      { internalType: "address", name: "_rewardsToken", type: "address" },
      { internalType: "uint256", name: "reward", type: "uint256" },
    ],
    name: "notifyRewardAmount",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export interface AddBribesParams {
  bribeAddress: string;
  rewardToken: string;
  amount: string;
  amountDecimals?: number;
  userAddress?: string;
}

export async function handleAddBribesSteps(params: AddBribesParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const { bribeAddress, rewardToken, amount } = params;
  const decimals = params.amountDecimals ?? 18;
  const amountWei = parseUnits(amount, decimals);

  const approved = await hasSufficientAllowance(rewardToken, userAddress, bribeAddress, amountWei);

  const steps: Array<{
    title: string;
    description: string;
    approval?: { tokenAddress: string; spender: string; amount: string };
    payload?: { to: string; abi: any; functionName: string; args: any[]; value: string };
  }> = [];

  if (!approved) {
    steps.push({
      title: "Approve reward token",
      description: "Approve the bribe contract to spend the reward token.",
      approval: {
        tokenAddress: rewardToken,
        spender: bribeAddress,
        amount: amountWei.toString(),
      },
    });
  }

  steps.push({
    title: "Execute notifyRewardAmount",
    description: "Deposit bribes into the bribe contract for voters.",
    payload: {
      to: bribeAddress,
      abi: BRIBE_ABI,
      functionName: "notifyRewardAmount",
      args: [rewardToken, amountWei],
      value: "0",
    },
  });

  return {
    success: true,
    message: "Computed addBribes transaction steps.",
    steps,
  };
}

export const addBribesTool = {
  name: "add_bribes_steps",
  description:
    "Add incentives (external bribes) to a gauge — 'incentive' and 'bribe' are interchangeable on Blackhole. Returns transaction steps to deposit tokens into a pool's external bribe contract via notifyRewardAmount. Incentives flow to veBLACK voters who vote for that gauge this epoch. Use vote_leaderboard with sortBy='externalBribesUsd' to find the bribeAddress for a pool.",
  inputSchema: {
    type: "object",
    properties: {
      bribeAddress: { type: "string", description: "External bribe contract address for the gauge." },
      rewardToken: { type: "string", description: "Reward token address being deposited as bribe." },
      amount: { type: "string", description: "Human-readable bribe amount." },
      amountDecimals: { type: "number", description: "Reward token decimals (default 18)." },
      userAddress: { type: "string", description: "Optional. User wallet address (tx sender). Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
    },
    required: ["bribeAddress", "rewardToken", "amount"],
  },
};
