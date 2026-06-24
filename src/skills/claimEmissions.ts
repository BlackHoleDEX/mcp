import { encodeFunctionData } from "viem";

import {
  ALGEBRA_POOL_API_ABI,
  BLACKHOLE_PAIR_ABI,
  BLACKHOLE_PAIR_API_V2_ADDRESS,
} from "../constants/contracts.js";
import { publicClient } from "../utils/viemClient.js";
import { resolveDeployer } from "../utils/customPoolDeployer.js";
import { getFarmingCenterForDeployer, getEternalFarmingForDeployer, getPoolAPIForDeployer } from "../utils/legacyContracts.js";
import { getEnvUserAddress } from "../utils/wallet.js";

type ClaimEmissionsMode = "v2" | "cl";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const GAUGE_MANAGER_ABI_V2 = [
  {
    inputs: [{ internalType: "address[]", name: "_gauges", type: "address[]" }],
    name: "claimRewards",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const ALGEBRA_ETERNAL_FARMING_ABI = [
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "incentiveKeys",
    outputs: [
      { internalType: "address", name: "rewardToken", type: "address" },
      { internalType: "address", name: "bonusRewardToken", type: "address" },
      { internalType: "address", name: "pool", type: "address" },
      { internalType: "uint256", name: "nonce", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const INCENTIVE_KEY_COMPONENT = {
  components: [
    { internalType: "address", name: "rewardToken", type: "address" },
    { internalType: "address", name: "bonusRewardToken", type: "address" },
    { internalType: "address", name: "pool", type: "address" },
    { internalType: "uint256", name: "nonce", type: "uint256" },
  ],
  internalType: "struct IncentiveKey",
  name: "key",
  type: "tuple",
} as const;

const FARMING_CENTER_ABI = [
  {
    inputs: [INCENTIVE_KEY_COMPONENT, { internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "collectRewards",
    outputs: [
      { internalType: "uint256", name: "reward", type: "uint256" },
      { internalType: "uint256", name: "bonusReward", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [INCENTIVE_KEY_COMPONENT, { internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "exitFarming",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [
      { internalType: "address", name: "rewardToken", type: "address" },
      { internalType: "address", name: "to", type: "address" },
      { internalType: "uint256", name: "amountRequested", type: "uint256" },
    ],
    name: "claimReward",
    outputs: [{ internalType: "uint256", name: "reward", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "bytes[]", name: "data", type: "bytes[]" }],
    name: "multicall",
    outputs: [{ internalType: "bytes[]", name: "results", type: "bytes[]" }],
    stateMutability: "payable",
    type: "function",
  },
] as const;

export interface ClaimEmissionsParams {
  mode: ClaimEmissionsMode;
  poolAddress: string;
  userAddress?: string;
  tokenId?: number;
  deployer?: string;
  isBonusReward?: boolean;
}

async function resolveV2GaugeContext(poolAddress: string, userAddress: string) {
  const [gaugeManagerAddress, pairInfo] = await Promise.all([
    publicClient.readContract({
      address: BLACKHOLE_PAIR_API_V2_ADDRESS as `0x${string}`,
      abi: BLACKHOLE_PAIR_ABI,
      functionName: "gaugeManager",
      args: [],
    }) as Promise<`0x${string}`>,
    publicClient.readContract({
      address: BLACKHOLE_PAIR_API_V2_ADDRESS as `0x${string}`,
      abi: BLACKHOLE_PAIR_ABI,
      functionName: "getPair",
      args: [poolAddress as `0x${string}`, userAddress as `0x${string}`],
    }) as Promise<any>,
  ]);

  const gaugeAddress = (pairInfo?.gauge ?? pairInfo?.[15] ?? ZERO_ADDRESS) as string;
  return { gaugeManagerAddress, gaugeAddress };
}

async function resolveCLFarmingContext(poolAddress: string, deployer?: string) {
  const poolApiAddress = getPoolAPIForDeployer(deployer);
  const farmingCenterAddress = getFarmingCenterForDeployer(deployer);
  const eternalFarmingAddress = getEternalFarmingForDeployer(deployer);

  const poolInfo = (await publicClient.readContract({
    address: poolApiAddress as `0x${string}`,
    abi: ALGEBRA_POOL_API_ABI,
    functionName: "getPoolInfo",
    args: [poolAddress as `0x${string}`],
  })) as any;

  const gaugeAddress = (poolInfo?.gauge ?? poolInfo?.[16] ?? ZERO_ADDRESS) as string;
  return { gaugeAddress, farmingCenterAddress, eternalFarmingAddress };
}

export async function handleClaimEmissionsSteps(params: ClaimEmissionsParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const { mode, poolAddress, tokenId, isBonusReward = false } = params;

  if (mode === "v2") {
    const { gaugeManagerAddress, gaugeAddress } = await resolveV2GaugeContext(
      poolAddress,
      userAddress,
    );
    if (!gaugeAddress || gaugeAddress.toLowerCase() === ZERO_ADDRESS) {
      throw new Error("No gauge found for provided v2 poolAddress.");
    }

    return {
      success: true,
      message: "Computed V2 emissions-claim transaction steps.",
      steps: [
        {
          title: "Execute claimRewards",
          description: "Claim staking emissions for staked V2 liquidity.",
          payload: {
            to: gaugeManagerAddress,
            abi: GAUGE_MANAGER_ABI_V2,
            functionName: "claimRewards",
            args: [[gaugeAddress]],
            value: "0",
          },
        },
      ],
    };
  }

  if (tokenId === undefined) {
    throw new Error("For mode='cl' provide tokenId.");
  }

  const resolvedDeployer = await resolveDeployer(params.deployer, poolAddress);
  const { gaugeAddress, farmingCenterAddress, eternalFarmingAddress: algebraEternalFarmingAddress } =
    await resolveCLFarmingContext(poolAddress, resolvedDeployer);
  if (!gaugeAddress || gaugeAddress.toLowerCase() === ZERO_ADDRESS) {
    throw new Error("No gauge found for provided CL poolAddress.");
  }

  const incentiveKeyData = (await publicClient.readContract({
    address: algebraEternalFarmingAddress as `0x${string}`,
    abi: ALGEBRA_ETERNAL_FARMING_ABI,
    functionName: "incentiveKeys",
    args: [poolAddress as `0x${string}`],
  })) as readonly [`0x${string}`, `0x${string}`, `0x${string}`, bigint];
  const [rewardToken, bonusRewardToken, incentivePool, nonce] = incentiveKeyData;

  const incentiveKey = {
    rewardToken,
    bonusRewardToken,
    pool: incentivePool,
    nonce,
  };
  const collectRewardsCalldata = encodeFunctionData({
    abi: FARMING_CENTER_ABI,
    functionName: "collectRewards",
    args: [incentiveKey, BigInt(tokenId)],
  });
  const claimRewardCalldata = encodeFunctionData({
    abi: FARMING_CENTER_ABI,
    functionName: "claimReward",
    args: [isBonusReward ? bonusRewardToken : rewardToken, userAddress as `0x${string}`, 0n],
  });

  return {
    success: true,
    message: "Computed CL emissions-claim transaction steps.",
    steps: [
      {
        title: "Execute farming center multicall",
        description:
          "Collect CL farming rewards and claim emissions from Farming Center.",
        payload: {
          to: farmingCenterAddress,
          abi: FARMING_CENTER_ABI,
          functionName: "multicall",
          args: [[collectRewardsCalldata, claimRewardCalldata]],
          value: "0",
        },
      },
    ],
  };
}

export const claimEmissionsTool = {
  name: "claim_emissions_steps",
  description: "Returns emission-claim transaction steps for staked v2 or CL positions.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["v2", "cl"], description: "Choose emissions claim mode: staked v2 pair or staked CL position." },
      poolAddress: { type: "string", description: "Pool/pair address used to resolve gauge and gauge manager." },
      tokenId: { type: "number", description: "CL position NFT tokenId (required for mode='cl')." },
      deployer: { type: "string", description: "Pool deployer address (mode='cl'). Pass from get_user_positions to route to the correct farming center (legacy vs current)." },
      isBonusReward: { type: "boolean", description: "CL bonus-reward flag for Farming Center claim path (mode='cl', default false)." },
      userAddress: { type: "string", description: "Optional. User wallet address used for pool context resolution. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
    },
    required: ["mode", "poolAddress"],
  },
};
