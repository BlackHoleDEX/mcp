import { formatUnits, parseUnits } from "viem";

import { RouteStep } from "../utils/routing.js";
import { computeBestQuote } from "./quoteService.js";

const DEFAULT_SLIPPAGE_PERCENT = 1;
const DEFAULT_REMOVE_SLIPPAGE_PERCENT = 1;

export interface ComputeZapRemovePlanParams {
  userAddress: string;
  tokenA: string;
  tokenB: string;
  tokenADecimals?: number;
  tokenBDecimals?: number;
  // Expected amounts of tokenA / tokenB coming out of liquidity removal.
  // Provide either raw or human-readable (raw takes precedence).
  expectedAmountARaw?: string;
  expectedAmountBRaw?: string;
  expectedAmountA?: string;
  expectedAmountB?: string;
  outputToken: string;
  outputTokenDecimals?: number;
  /** Slippage applied to each swap's amountOutMin and the overall minAmountOut. Default: 5%. */
  slippagePercent?: number;
  /** Slippage applied to amountAMin / amountBMin from LP removal. Default: 0.5%. */
  removeSlippagePercent?: number;
}

export interface PlannedZapRemoveSwap {
  feeOnTransfer: boolean;
  amountInRaw: bigint;
  amountOutMinRaw: bigint;
  routes: RouteStep[];
}

export interface ZapRemovePlan {
  expectedAmountARaw: bigint;
  expectedAmountBRaw: bigint;
  amountAMinRaw: bigint;
  amountBMinRaw: bigint;
  expectedOutputRaw: bigint;
  minAmountOutRaw: bigint;
  swaps: PlannedZapRemoveSwap[];
}

function applySlippage(rawAmount: bigint, slippagePercent: number): bigint {
  const clamped = Math.min(Math.max(slippagePercent, 0), 99.99);
  const bps = BigInt(Math.floor(clamped * 100));
  return (rawAmount * (10000n - bps)) / 10000n;
}

function resolveRaw(raw: string | undefined, human: string | undefined, decimals: number): bigint {
  if (raw !== undefined) return BigInt(raw);
  if (human !== undefined) return parseUnits(human, decimals);
  return 0n;
}

function toAddressLower(value: string): string {
  return value.toLowerCase();
}

export async function computeZapRemovePlan(
  params: ComputeZapRemovePlanParams,
): Promise<ZapRemovePlan> {
  const {
    userAddress,
    tokenA,
    tokenB,
    tokenADecimals = 18,
    tokenBDecimals = 18,
    outputToken,
    slippagePercent = DEFAULT_SLIPPAGE_PERCENT,
    removeSlippagePercent = DEFAULT_REMOVE_SLIPPAGE_PERCENT,
  } = params;

  const expectedAmountARaw = resolveRaw(
    params.expectedAmountARaw,
    params.expectedAmountA,
    tokenADecimals,
  );
  const expectedAmountBRaw = resolveRaw(
    params.expectedAmountBRaw,
    params.expectedAmountB,
    tokenBDecimals,
  );

  if (expectedAmountARaw <= 0n && expectedAmountBRaw <= 0n) {
    throw new Error(
      "Provide at least one of expectedAmountA / expectedAmountB (or *Raw equivalents) for auto-plan.",
    );
  }

  const swaps: PlannedZapRemoveSwap[] = [];
  let expectedOutputRaw = 0n;

  const sides: Array<{ token: string; amountRaw: bigint; decimals: number }> = [
    { token: tokenA, amountRaw: expectedAmountARaw, decimals: tokenADecimals },
    { token: tokenB, amountRaw: expectedAmountBRaw, decimals: tokenBDecimals },
  ];

  for (const side of sides) {
    if (side.amountRaw <= 0n) continue;
    if (toAddressLower(side.token) === toAddressLower(outputToken)) {
      expectedOutputRaw += side.amountRaw;
      continue;
    }
    const quote = await computeBestQuote({
      tokenIn: side.token,
      tokenOut: outputToken,
      amountIn: formatUnits(side.amountRaw, side.decimals),
      tokenInDecimals: side.decimals,
      userAddress,
      useSplitRoutes: false,
    });
    expectedOutputRaw += quote.amountOutRaw;
    swaps.push({
      feeOnTransfer: false,
      amountInRaw: side.amountRaw,
      amountOutMinRaw: applySlippage(quote.amountOutRaw, slippagePercent),
      routes: quote.route,
    });
  }

  return {
    expectedAmountARaw,
    expectedAmountBRaw,
    amountAMinRaw: applySlippage(expectedAmountARaw, removeSlippagePercent),
    amountBMinRaw: applySlippage(expectedAmountBRaw, removeSlippagePercent),
    expectedOutputRaw,
    minAmountOutRaw: applySlippage(expectedOutputRaw, slippagePercent),
    swaps,
  };
}
