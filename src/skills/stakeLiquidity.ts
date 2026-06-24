import { encodeFunctionData, parseUnits } from "viem";

import {
  ALGEBRA_POOL_API_ABI,
  BLACKHOLE_PAIR_ABI,
  BLACKHOLE_PAIR_API_V2_ADDRESS,
  NONFUNGIBLE_POSITION_MANAGER_ABI,
} from "../constants/contracts.js";
import { getNFPMForDeployer } from "../utils/legacyContracts.js";
import { hasSufficientAllowance } from "../utils/erc20.js";
import { getFarmingCenterForDeployer, getEternalFarmingForDeployer, getPoolAPIForDeployer } from "../utils/legacyContracts.js";
import { resolveDeployer } from "../utils/customPoolDeployer.js";
import { publicClient } from "../utils/viemClient.js";
import { getEnvUserAddress } from "../utils/wallet.js";

type StakeMode = "v2" | "cl";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const GAUGE_MANAGER_GAUGES_ABI = [
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "gauges",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const GAUGE_V2_STAKE_ABI = [
  {
    inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
    name: "deposit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [],
    name: "withdrawAll",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const GAUGE_CL_STAKE_ABI = [
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "deposit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "withdraw",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

async function resolveGaugeAddress(poolAddress: string, mode: StakeMode, userAddress?: string, deployer?: string) {
  if (mode === "v2") {
    const pairInfo = (await publicClient.readContract({
      address: BLACKHOLE_PAIR_API_V2_ADDRESS as `0x${string}`,
      abi: BLACKHOLE_PAIR_ABI,
      functionName: "getPair",
      args: [poolAddress as `0x${string}`, (userAddress ?? ZERO_ADDRESS) as `0x${string}`],
    })) as any;
    return (pairInfo?.gauge ?? pairInfo?.[15] ?? ZERO_ADDRESS) as string;
  }
  const poolApiAddress = getPoolAPIForDeployer(deployer);
  const poolInfo = (await publicClient.readContract({
    address: poolApiAddress as `0x${string}`,
    abi: ALGEBRA_POOL_API_ABI,
    functionName: "getPoolInfo",
    args: [poolAddress as `0x${string}`],
  })) as any;
  return (poolInfo?.gauge ?? poolInfo?.[16] ?? ZERO_ADDRESS) as string;
}

async function resolveGaugeAddressViaManager(poolAddress: string, gaugeManagerAddress: string) {
  return (await publicClient.readContract({
    address: gaugeManagerAddress as `0x${string}`,
    abi: GAUGE_MANAGER_GAUGES_ABI,
    functionName: "gauges",
    args: [poolAddress as `0x${string}`],
  })) as string;
}

export interface StakeLiquidityParams {
  mode: StakeMode;
  userAddress?: string;
  deployer?: string;
  poolAddress?: string;
  gaugeAddress?: string;
  gaugeManagerAddress?: string;
  amount?: string;
  amountDecimals?: number;
  tokenId?: number;
}

export async function handleStakeLiquiditySteps(params: StakeLiquidityParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const { mode } = params;
  const deployer = mode === "cl" ? await resolveDeployer(params.deployer, params.poolAddress) : undefined;

  let gaugeAddress = params.gaugeAddress;
  if (!gaugeAddress) {
    if (!params.poolAddress) throw new Error("Provide either gaugeAddress or poolAddress.");
    gaugeAddress = params.gaugeManagerAddress
      ? await resolveGaugeAddressViaManager(params.poolAddress, params.gaugeManagerAddress)
      : await resolveGaugeAddress(params.poolAddress, mode, userAddress, deployer);
  }
  if (!gaugeAddress || gaugeAddress.toLowerCase() === ZERO_ADDRESS) {
    throw new Error("No gauge found for provided pool.");
  }

  if (mode === "v2") {
    if (params.amount === undefined) throw new Error("For mode='v2' provide amount.");
    if (!params.poolAddress) throw new Error("For mode='v2' provide poolAddress (LP token).");
    const decimals = params.amountDecimals ?? 18;
    const amountWei = parseUnits(params.amount, decimals);

    const approved = await hasSufficientAllowance(
      params.poolAddress,
      userAddress,
      gaugeAddress,
      amountWei,
    );

    const steps: Array<{
      title: string;
      description: string;
      waitForReceipt?: boolean;
      approval?: { tokenAddress: string; spender: string; amount: string };
      payload?: { to: string; abi: any; functionName: string; args: any[]; value: string };
    }> = [];

    if (!approved) {
      steps.push({
        title: "Approve LP token",
        description: "Approve the gauge to spend LP tokens.",
        waitForReceipt: true,
        approval: {
          tokenAddress: params.poolAddress,
          spender: gaugeAddress,
          amount: amountWei.toString(),
        },
      });
    }

    steps.push({
      title: "Execute deposit",
      description: "Stake LP tokens into the V2 gauge.",
      payload: {
        to: gaugeAddress,
        abi: GAUGE_V2_STAKE_ABI,
        functionName: "deposit",
        args: [amountWei],
        value: "0",
      },
    });

    return {
      success: true,
      sequential: true,
      message: "Computed V2 stake transaction steps.",
      steps,
    };
  }

  if (params.tokenId === undefined) throw new Error("For mode='cl' provide tokenId.");

  const nfpmAddress = getNFPMForDeployer(deployer);

  // Check if the gauge is already approved for this tokenId
  const approvedAddress = await publicClient.readContract({
    address: nfpmAddress as `0x${string}`,
    abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
    functionName: "getApproved",
    args: [BigInt(params.tokenId)],
  }) as string;

  const steps: any[] = [];

  if (approvedAddress.toLowerCase() !== gaugeAddress.toLowerCase()) {
    steps.push({
      title: "Approve gauge for NFT",
      description: "Approve the gauge to manage this CL position NFT.",
      waitForReceipt: true,
      payload: {
        to: nfpmAddress,
        abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
        functionName: "approve",
        args: [gaugeAddress, BigInt(params.tokenId)],
        value: "0",
      },
    });
  }

  steps.push({
    title: "Execute deposit",
    description: "Stake CL position NFT into the gauge.",
    payload: {
      to: gaugeAddress,
      abi: GAUGE_CL_STAKE_ABI,
      functionName: "deposit",
      args: [BigInt(params.tokenId)],
      value: "0",
    },
  });

  return {
    success: true,
    sequential: true,
    message: "Computed CL stake transaction steps.",
    steps,
  };
}

export async function handleUnstakeLiquiditySteps(params: StakeLiquidityParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const { mode } = params;
  const deployer = mode === "cl" ? await resolveDeployer(params.deployer, params.poolAddress) : undefined;

  let gaugeAddress = params.gaugeAddress;
  if (!gaugeAddress) {
    if (!params.poolAddress) throw new Error("Provide either gaugeAddress or poolAddress.");
    gaugeAddress = params.gaugeManagerAddress
      ? await resolveGaugeAddressViaManager(params.poolAddress, params.gaugeManagerAddress)
      : await resolveGaugeAddress(params.poolAddress, mode, userAddress, deployer);
  }
  if (!gaugeAddress || gaugeAddress.toLowerCase() === ZERO_ADDRESS) {
    throw new Error("No gauge found for provided pool.");
  }

  if (mode === "v2") {
    return {
      success: true,
      sequential: true,
      message: "Computed V2 unstake transaction steps.",
      steps: [
        {
          title: "Execute withdrawAll",
          description: "Unstake all LP tokens from the V2 gauge.",
          payload: {
            to: gaugeAddress,
            abi: GAUGE_V2_STAKE_ABI,
            functionName: "withdrawAll",
            args: [],
            value: "0",
          },
        },
      ],
    };
  }

  if (params.tokenId === undefined) throw new Error("For mode='cl' provide tokenId.");
  if (!params.poolAddress) throw new Error("For mode='cl' provide poolAddress to resolve the farming center.");

  // CL unstake = exitFarming + claimReward on the farming center (not gauge.withdraw)
  const farmingCenterAddress = getFarmingCenterForDeployer(deployer);
  const eternalFarmingAddress = getEternalFarmingForDeployer(deployer);

  const ETERNAL_FARMING_ABI = [
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

  const FARMING_CENTER_MULTICALL_ABI = [
    {
      inputs: [
        {
          components: [
            { internalType: "address", name: "rewardToken", type: "address" },
            { internalType: "address", name: "bonusRewardToken", type: "address" },
            { internalType: "address", name: "pool", type: "address" },
            { internalType: "uint256", name: "nonce", type: "uint256" },
          ],
          internalType: "struct IncentiveKey",
          name: "key",
          type: "tuple",
        },
        { internalType: "uint256", name: "tokenId", type: "uint256" },
      ],
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

  const incentiveKeyData = (await publicClient.readContract({
    address: eternalFarmingAddress as `0x${string}`,
    abi: ETERNAL_FARMING_ABI,
    functionName: "incentiveKeys",
    args: [params.poolAddress as `0x${string}`],
  })) as readonly [`0x${string}`, `0x${string}`, `0x${string}`, bigint];
  const [rewardToken, bonusRewardToken, incentivePool, nonce] = incentiveKeyData;
  const incentiveKey = { rewardToken, bonusRewardToken, pool: incentivePool, nonce };

  const exitFarmingCalldata = encodeFunctionData({
    abi: FARMING_CENTER_MULTICALL_ABI,
    functionName: "exitFarming",
    args: [incentiveKey, BigInt(params.tokenId)],
  });
  const claimRewardCalldata = encodeFunctionData({
    abi: FARMING_CENTER_MULTICALL_ABI,
    functionName: "claimReward",
    args: [rewardToken, userAddress as `0x${string}`, 0n],
  });

  return {
    success: true,
    sequential: true,
    message: "Computed CL unstake transaction steps.",
    steps: [
      {
        title: "Exit farming and claim rewards",
        description: "Exit CL farming incentive and claim all accumulated emissions in one multicall.",
        payload: {
          to: farmingCenterAddress,
          abi: FARMING_CENTER_MULTICALL_ABI,
          functionName: "multicall",
          args: [[exitFarmingCalldata, claimRewardCalldata]],
          value: "0",
        },
      },
    ],
  };
}

export const stakeLiquidityTool = {
  name: "stake_liquidity_steps",
  description:
    "Returns stake transaction steps for v2 LP tokens (by amount) or CL position NFT (by tokenId). Resolves gauge automatically from poolAddress if gaugeAddress is omitted. Steps must be executed sequentially — LP token approval (if needed) must confirm before the stake transaction.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["v2", "cl"], description: "Choose stake mode." },
      userAddress: { type: "string", description: "Optional. User wallet address (context for v2 pair lookup). Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      deployer: { type: "string", description: "Pool deployer address (mode='cl'). Pass when known (from get_user_positions) to use the correct pool API for gauge lookup. Takes precedence over poolAddress for deployer resolution." },
      poolAddress: { type: "string", description: "Pool/pair address (used to resolve gauge if gaugeAddress omitted; also used to resolve deployer if deployer is not provided)." },
      gaugeAddress: { type: "string", description: "Optional explicit gauge address." },
      gaugeManagerAddress: { type: "string", description: "Optional override; when given, resolves gauge via gaugeManager.gauges(pool)." },
      amount: { type: "string", description: "Human-readable LP amount (required for mode='v2')." },
      amountDecimals: { type: "number", description: "LP token decimals (mode='v2', default 18)." },
      tokenId: { type: "number", description: "Position NFT tokenId (required for mode='cl')." },
    },
    required: ["mode"],
  },
};

export const unstakeLiquidityTool = {
  name: "unstake_liquidity_steps",
  description:
    "Returns unstake transaction steps for v2 (withdrawAll) or CL (withdraw tokenId). Resolves gauge automatically from poolAddress if gaugeAddress is omitted.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["v2", "cl"] },
      userAddress: { type: "string", description: "Optional. User wallet address. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      deployer: { type: "string", description: "Pool deployer address (mode='cl'). Pass when known (from get_user_positions) to use the correct pool API for gauge lookup. Takes precedence over poolAddress for deployer resolution." },
      poolAddress: { type: "string", description: "Pool address (used to resolve gauge; also resolves deployer if deployer not provided)." },
      gaugeAddress: { type: "string" },
      gaugeManagerAddress: { type: "string" },
      tokenId: { type: "number", description: "Required for mode='cl'." },
    },
    required: ["mode"],
  },
};
