import { parseUnits } from "viem";

import { computeZapSplitPlan, ZapSplitPoolType } from "../services/zapSplitPlanner.js";
import { normalizeTokenAddress } from "../utils/nativeToken.js";

export interface ZapSplitPlanParams {
  poolType: ZapSplitPoolType;
  poolAddress: string;
  tokenA: string;
  tokenB: string;
  inputToken: string;
  inputAmount: string;
  inputTokenDecimals?: number;
  routeRecipient: string;
  tickLower?: number;
  tickUpper?: number;
  slippagePercent?: number;
}

export async function handleZapSplitPlan(params: ZapSplitPlanParams) {
  const {
    poolType,
    poolAddress,
    tokenA,
    tokenB,
    inputToken,
    inputAmount,
    inputTokenDecimals = 18,
    routeRecipient,
    tickLower,
    tickUpper,
    slippagePercent,
  } = params;

  const normalizedInput = normalizeTokenAddress(inputToken);
  const amountRaw = parseUnits(inputAmount, inputTokenDecimals);

  const plan = await computeZapSplitPlan({
    poolType,
    poolAddress,
    tokenA: normalizeTokenAddress(tokenA),
    tokenB: normalizeTokenAddress(tokenB),
    inputToken: normalizedInput,
    inputTokenDecimals,
    inputAmountRaw: amountRaw,
    routeRecipient,
    tickLower,
    tickUpper,
    slippagePercent,
  });

  return {
    success: true,
    message: "Computed reusable zap split plan.",
    plan: {
      splitA: plan.splitA,
      splitB: plan.splitB,
      splitARaw: plan.splitARaw.toString(),
      splitBRaw: plan.splitBRaw.toString(),
      amountAOutRaw: plan.amountAOutRaw.toString(),
      amountBOutRaw: plan.amountBOutRaw.toString(),
      amountAMinRaw: plan.amountAMinRaw.toString(),
      amountBMinRaw: plan.amountBMinRaw.toString(),
      swaps: plan.swaps.map((swap) => ({
        feeOnTransfer: swap.feeOnTransfer,
        amountInRaw: swap.amountInRaw.toString(),
        amountOutMinRaw: swap.amountOutMinRaw.toString(),
        routes: swap.routes,
      })),
    },
  };
}

export const zapSplitPlanTool = {
  name: "zap_split_plan",
  description: "Returns a reusable split/route plan for zap liquidity operations.",
  inputSchema: {
    type: "object",
    properties: {
      poolType: { type: "string", enum: ["basic", "cl"], description: "Pool type to apply split-ratio logic." },
      poolAddress: { type: "string" },
      tokenA: { type: "string" },
      tokenB: { type: "string" },
      inputToken: { type: "string" },
      inputAmount: { type: "string" },
      inputTokenDecimals: { type: "number" },
      routeRecipient: { type: "string" },
      tickLower: { type: "number" },
      tickUpper: { type: "number" },
      slippagePercent: { type: "number" },
    },
    required: ["poolType", "poolAddress", "tokenA", "tokenB", "inputToken", "inputAmount", "routeRecipient"],
  },
};
