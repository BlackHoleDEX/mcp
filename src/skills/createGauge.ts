import { BLACKHOLE_PAIR_ABI, BLACKHOLE_PAIR_API_V2_ADDRESS } from "../constants/contracts.js";
import { publicClient } from "../utils/viemClient.js";
import { getEnvUserAddress } from "../utils/wallet.js";

const GAUGE_MANAGER_CREATE_ABI = [
  {
    inputs: [
      { internalType: "address", name: "_pool", type: "address" },
      { internalType: "uint256", name: "_gaugeType", type: "uint256" },
      { internalType: "address", name: "_bonusRewardToken", type: "address" },
    ],
    name: "createGaugeWithBonusReward",
    outputs: [
      { internalType: "address", name: "_gauge", type: "address" },
      { internalType: "address", name: "_internal_bribe", type: "address" },
      { internalType: "address", name: "_external_bribe", type: "address" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export interface CreateGaugeParams {
  poolAddress: string;
  gaugeType: number;
  bonusRewardToken: string;
  userAddress?: string;
  gaugeManagerAddress?: string;
}

export async function handleCreateGaugeSteps(params: CreateGaugeParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const { poolAddress, gaugeType, bonusRewardToken } = params;
  if (gaugeType !== 0 && gaugeType !== 1) {
    throw new Error("gaugeType must be 0 (basic) or 1 (concentrated).");
  }

  const gaugeManagerAddress =
    params.gaugeManagerAddress ??
    ((await publicClient.readContract({
      address: BLACKHOLE_PAIR_API_V2_ADDRESS as `0x${string}`,
      abi: BLACKHOLE_PAIR_ABI,
      functionName: "gaugeManager",
      args: [],
    })) as `0x${string}`);

  return {
    success: true,
    message: "Computed createGauge transaction steps.",
    steps: [
      {
        title: "Execute createGaugeWithBonusReward",
        description: "Create a new gauge (with bonus-reward token) for the given pool.",
        payload: {
          to: gaugeManagerAddress,
          abi: GAUGE_MANAGER_CREATE_ABI,
          functionName: "createGaugeWithBonusReward",
          args: [poolAddress, BigInt(gaugeType), bonusRewardToken],
          value: "0",
        },
      },
    ],
  };
}

export const createGaugeTool = {
  name: "create_gauge_steps",
  description:
    "Returns transaction steps to create a gauge on GaugeManager via createGaugeWithBonusReward.",
  inputSchema: {
    type: "object",
    properties: {
      poolAddress: { type: "string", description: "Pool/pair address to gauge-ify." },
      gaugeType: { type: "number", enum: [0, 1], description: "0 = basic V2 pool, 1 = concentrated liquidity pool." },
      bonusRewardToken: { type: "string", description: "Bonus reward token address (usually the protocol token)." },
      userAddress: { type: "string", description: "Optional. User wallet address (tx sender). Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      gaugeManagerAddress: { type: "string", description: "Optional override; defaults to pair API gaugeManager()." },
    },
    required: ["poolAddress", "gaugeType", "bonusRewardToken"],
  },
};
