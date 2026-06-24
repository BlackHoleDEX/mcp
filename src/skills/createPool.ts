import BigNumber from "bignumber.js";

import { CUSTOM_POOL_DEPLOYERS_BY_TICK_SPACING } from "../common/constants/contracts/custom-pool-deployers.js";

const CUSTOM_POOL_DEPLOYER_ABI = [
  {
    inputs: [
      { internalType: "address", name: "creator", type: "address" },
      { internalType: "address", name: "tokenA", type: "address" },
      { internalType: "address", name: "tokenB", type: "address" },
      { internalType: "bytes", name: "data", type: "bytes" },
      { internalType: "uint160", name: "sqrtPriceX96", type: "uint160" },
    ],
    name: "createCustomPool",
    outputs: [{ internalType: "address", name: "pool", type: "address" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export interface CreateCLPoolParams {
  creator: string;
  tokenA: string;
  tokenB: string;
  deployerAddress?: string;
  tickSpacing?: number;
  initialPrice: string;
  tokenADecimals: number;
  tokenBDecimals: number;
  poolInitData?: string;
  userAddress: string;
}

export function handleCreateCLPoolSteps(params: CreateCLPoolParams) {
  const {
    creator,
    tokenA,
    tokenB,
    initialPrice,
    tokenADecimals,
    tokenBDecimals,
  } = params;
  const poolInitData = params.poolInitData ?? "0x";

  let deployerAddress = params.deployerAddress;
  if (!deployerAddress) {
    if (params.tickSpacing === undefined) {
      throw new Error(
        `Provide either deployerAddress or tickSpacing (one of ${Object.keys(CUSTOM_POOL_DEPLOYERS_BY_TICK_SPACING).join(", ")}).`,
      );
    }
    const resolved = CUSTOM_POOL_DEPLOYERS_BY_TICK_SPACING[params.tickSpacing];
    if (!resolved) {
      throw new Error(
        `No custom pool deployer configured for tickSpacing=${params.tickSpacing}. Known tick spacings: ${Object.keys(CUSTOM_POOL_DEPLOYERS_BY_TICK_SPACING).join(", ")}.`,
      );
    }
    deployerAddress = resolved;
  }

  const decimalAdjustment = new BigNumber(10).pow(tokenBDecimals - tokenADecimals);
  const normalizedPrice = new BigNumber(initialPrice).multipliedBy(decimalAdjustment);
  const sqrtPriceX96 = normalizedPrice
    .sqrt()
    .multipliedBy(new BigNumber(2).pow(96))
    .toFixed(0);

  return {
    success: true,
    message: "Computed createCustomPool transaction steps.",
    sqrtPriceX96,
    steps: [
      {
        title: "Execute createCustomPool",
        description: "Deploy a new concentrated-liquidity pool via the custom pool deployer.",
        payload: {
          to: deployerAddress,
          abi: CUSTOM_POOL_DEPLOYER_ABI,
          functionName: "createCustomPool",
          args: [creator, tokenA, tokenB, poolInitData, BigInt(sqrtPriceX96)],
          value: "0",
        },
      },
    ],
  };
}

export const createCLPoolTool = {
  name: "create_cl_pool_steps",
  description:
    "Returns transaction steps to deploy a new concentrated-liquidity pool via customPoolDeployer.createCustomPool. Pass tickSpacing (1/50/100/200) to auto-resolve deployerAddress, or pass deployerAddress directly.",
  inputSchema: {
    type: "object",
    properties: {
      creator: { type: "string", description: "Pool creator address (usually the user)." },
      tokenA: { type: "string", description: "Address of token A." },
      tokenB: { type: "string", description: "Address of token B." },
      deployerAddress: { type: "string", description: "Optional. Tick-spacing-specific custom pool deployer address. Auto-resolved from tickSpacing when omitted. Do NOT guess." },
      tickSpacing: { type: "number", enum: [1, 50, 100, 200], description: "CL tick spacing. Used to auto-resolve deployerAddress when it is omitted." },
      initialPrice: { type: "string", description: "Human-readable initial price (tokenB per tokenA)." },
      tokenADecimals: { type: "number", description: "Decimals of token A." },
      tokenBDecimals: { type: "number", description: "Decimals of token B." },
      poolInitData: { type: "string", description: "Optional bytes payload forwarded to deployer (default '0x')." },
      userAddress: { type: "string", description: "User wallet address (tx sender)." },
    },
    required: [
      "creator",
      "tokenA",
      "tokenB",
      "initialPrice",
      "tokenADecimals",
      "tokenBDecimals",
      "userAddress",
    ],
  },
};
