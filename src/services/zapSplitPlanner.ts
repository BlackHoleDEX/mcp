import BigNumber from "bignumber.js";
import { formatUnits } from "viem";

import {
  ALGEBRA_POOL_API_ABI,
  ALGEBRA_POOL_API_ADDRESS,
  BLACKHOLE_PAIR_ABI,
  BLACKHOLE_PAIR_API_V2_ADDRESS,
} from "../constants/contracts.js";
import { RouteStep } from "../utils/routing.js";
import { fetchTokenPrices } from "../utils/tokenPrices.js";
import { publicClient } from "../utils/viemClient.js";
import { computeBestQuote } from "./quoteService.js";

const Q96 = 2 ** 96;
const DEFAULT_SLIPPAGE_PERCENT = 1;

export type ZapSplitPoolType = "basic" | "cl";

export interface ComputeZapSplitPlanParams {
  poolType: ZapSplitPoolType;
  poolAddress: string;
  tokenA: string;
  tokenB: string;
  inputToken: string;
  inputTokenDecimals: number;
  inputAmountRaw: bigint;
  routeRecipient: string;
  tickLower?: number;
  tickUpper?: number;
  slippagePercent?: number;
}

export interface PlannedZapSwap {
  feeOnTransfer: boolean;
  amountInRaw: bigint;
  amountOutMinRaw: bigint;
  routes: RouteStep[];
}

export interface ZapSplitPlan {
  splitA: number;
  splitB: number;
  splitARaw: bigint;
  splitBRaw: bigint;
  amountAOutRaw: bigint;
  amountBOutRaw: bigint;
  amountAMinRaw: bigint;
  amountBMinRaw: bigint;
  swaps: PlannedZapSwap[];
}

function applySlippage(rawAmount: bigint, slippagePercent: number): bigint {
  const clamped = Math.min(Math.max(slippagePercent, 0), 99.99);
  const bps = BigInt(Math.floor(clamped * 100));
  return (rawAmount * (10000n - bps)) / 10000n;
}

function toAddressLower(value: string): string {
  return value.toLowerCase();
}

function normalizeSplitRatios(weightA: number, weightB: number) {
  const safeA = Number.isFinite(weightA) && weightA >= 0 ? weightA : 0.5;
  const safeB = Number.isFinite(weightB) && weightB >= 0 ? weightB : 0.5;
  const total = safeA + safeB;
  if (total <= 0) {
    return { splitA: 0.5, splitB: 0.5 };
  }
  return {
    splitA: safeA / total,
    splitB: safeB / total,
  };
}

async function getBasicPoolSplitRatios(
  poolAddress: string,
  tokenA: string,
  tokenB: string,
  routeRecipient: string,
) {
  const pair = (await publicClient.readContract({
    address: BLACKHOLE_PAIR_API_V2_ADDRESS as `0x${string}`,
    abi: BLACKHOLE_PAIR_ABI,
    functionName: "getPair",
    args: [poolAddress as `0x${string}`, routeRecipient as `0x${string}`],
  })) as any;

  const pairToken0 = (pair.token0 ?? pair[6] ?? "").toLowerCase();
  const pairToken1 = (pair.token1 ?? pair[11] ?? "").toLowerCase();
  const token0Decimals = Number(pair.token0_decimals ?? pair[8] ?? 18);
  const token1Decimals = Number(pair.token1_decimals ?? pair[13] ?? 18);
  const reserve0 = BigInt((pair.reserve0 ?? pair[9] ?? 0).toString());
  const reserve1 = BigInt((pair.reserve1 ?? pair[14] ?? 0).toString());

  const reserve0Human = new BigNumber(formatUnits(reserve0, token0Decimals));
  const reserve1Human = new BigNumber(formatUnits(reserve1, token1Decimals));

  let reserveAHuman = reserve0Human;
  let reserveBHuman = reserve1Human;
  if (pairToken0 === toAddressLower(tokenB) && pairToken1 === toAddressLower(tokenA)) {
    reserveAHuman = reserve1Human;
    reserveBHuman = reserve0Human;
  }

  if (reserveAHuman.lte(0) || reserveBHuman.lte(0)) {
    return { splitA: 0.5, splitB: 0.5 };
  }

  // Mirror the website: use USD value of each reserve for the split ratio.
  // Fall back to the pool's implied price if USD prices are unavailable.
  const prices = await fetchTokenPrices();
  const priceA = prices.get(toAddressLower(tokenA)) ?? 0;
  const priceB = prices.get(toAddressLower(tokenB)) ?? 0;

  let valueA: BigNumber;
  let valueB: BigNumber;
  if (priceA > 0 && priceB > 0) {
    valueA = reserveAHuman.multipliedBy(priceA);
    valueB = reserveBHuman.multipliedBy(priceB);
  } else {
    // Implied price fallback: price_A_in_B = reserveB / reserveA
    // valueA = reserveA × (reserveB/reserveA) = reserveB, valueB = reserveB → 50/50
    const impliedPriceAInB = reserveBHuman.dividedBy(reserveAHuman);
    valueA = reserveAHuman.multipliedBy(impliedPriceAInB);
    valueB = reserveBHuman;
  }

  const total = valueA.plus(valueB);
  if (!total.isFinite() || total.lte(0)) {
    return { splitA: 0.5, splitB: 0.5 };
  }
  return normalizeSplitRatios(
    valueA.dividedBy(total).toNumber(),
    valueB.dividedBy(total).toNumber(),
  );
}

function sqrtRatioAtTick(tick: number): number {
  return Math.pow(1.0001, tick / 2);
}

async function getCLPoolSplitRatios(
  poolAddress: string,
  tickLower: number,
  tickUpper: number,
  tokenA?: string,
  tokenB?: string,
): Promise<{ splitA: number; splitB: number }> {
  if (tickLower >= tickUpper) {
    return { splitA: 0.5, splitB: 0.5 };
  }

  const poolInfo = (await publicClient.readContract({
    address: ALGEBRA_POOL_API_ADDRESS as `0x${string}`,
    abi: ALGEBRA_POOL_API_ABI,
    functionName: "getPoolInfo",
    args: [poolAddress as `0x${string}`],
  })) as any;

  const tickCurrent = Number(poolInfo.tick ?? poolInfo[14] ?? 0);
  const sqrtPriceX96 = Number(poolInfo.sqrtPriceX96 ?? poolInfo[13] ?? 0);
  const token0Addr = (poolInfo.token0 ?? poolInfo[0] ?? "").toLowerCase();
  const token1Addr = (poolInfo.token1 ?? poolInfo[1] ?? "").toLowerCase();
  const token0Decimals = Number(poolInfo.token0Decimals ?? poolInfo[2] ?? 18);
  const token1Decimals = Number(poolInfo.token1Decimals ?? poolInfo[3] ?? 18);

  if (tickCurrent <= tickLower) return { splitA: 1, splitB: 0 };
  if (tickCurrent >= tickUpper) return { splitA: 0, splitB: 1 };
  if (!Number.isFinite(sqrtPriceX96) || sqrtPriceX96 <= 0) {
    return { splitA: 0.5, splitB: 0.5 };
  }

  const sqrtP = sqrtPriceX96 / Q96;
  const sqrtL = sqrtRatioAtTick(tickLower);
  const sqrtU = sqrtRatioAtTick(tickUpper);
  if (!(sqrtP > sqrtL && sqrtP < sqrtU)) {
    return { splitA: 0.5, splitB: 0.5 };
  }

  const amount0Unit = (sqrtU - sqrtP) / (sqrtU * sqrtP);
  const amount1Unit = sqrtP - sqrtL;
  if (!(amount0Unit > 0) || !(amount1Unit > 0)) {
    return { splitA: 0.5, splitB: 0.5 };
  }

  // Mirror the website: use USD value of each side. The pool's tokenA may map
  // to token0 or token1 depending on sort order; resolve whichever matches.
  const addrA = tokenA ? tokenA.toLowerCase() : token0Addr;
  const addrB = tokenB ? tokenB.toLowerCase() : token1Addr;
  const isAToken0 = addrA === token0Addr;

  const prices = await fetchTokenPrices();
  const priceToken0 = prices.get(token0Addr) ?? 0;
  const priceToken1 = prices.get(token1Addr) ?? 0;

  let value0: number;
  let value1: number;
  if (priceToken0 > 0 && priceToken1 > 0) {
    // Human-readable amounts × USD price
    value0 = (amount0Unit / Math.pow(10, token0Decimals)) * priceToken0;
    value1 = (amount1Unit / Math.pow(10, token1Decimals)) * priceToken1;
  } else {
    // Fallback: use pool's implied price (sqrtP² converts raw token0 → token1 units)
    value0 = amount0Unit * Math.pow(sqrtP, 2);
    value1 = amount1Unit;
  }

  // Return in tokenA/tokenB order (may differ from token0/token1)
  return isAToken0
    ? normalizeSplitRatios(value0, value1)
    : normalizeSplitRatios(value1, value0);
}

async function buildAutoSwaps(params: {
  tokenA: string;
  tokenB: string;
  inputToken: string;
  inputTokenDecimals: number;
  inputAmountRaw: bigint;
  splitA: number;
  splitB: number;
  routeRecipient: string;
  slippagePercent: number;
}): Promise<{
  swaps: PlannedZapSwap[];
  amountAOutRaw: bigint;
  amountBOutRaw: bigint;
  splitARaw: bigint;
  splitBRaw: bigint;
}> {
  const {
    tokenA,
    tokenB,
    inputToken,
    inputTokenDecimals,
    inputAmountRaw,
    splitA,
    splitB,
    routeRecipient,
    slippagePercent,
  } = params;

  const splitABps = BigInt(Math.floor(Math.min(Math.max(splitA, 0), 1) * 10000));
  const splitARaw = (inputAmountRaw * splitABps) / 10000n;
  const splitBRaw = inputAmountRaw - splitARaw;

  const swapArr: PlannedZapSwap[] = [];

  let amountAOutRaw = 0n;
  if (toAddressLower(inputToken) === toAddressLower(tokenA)) {
    amountAOutRaw = splitARaw;
  } else if (splitARaw > 0n) {
    const quoteA = await computeBestQuote({
      tokenIn: inputToken,
      tokenOut: tokenA,
      amountIn: formatUnits(splitARaw, inputTokenDecimals),
      tokenInDecimals: inputTokenDecimals,
      userAddress: routeRecipient,
      useSplitRoutes: false,
    });
    amountAOutRaw = quoteA.amountOutRaw;
    swapArr.push({
      feeOnTransfer: false,
      amountInRaw: splitARaw,
      amountOutMinRaw: applySlippage(amountAOutRaw, slippagePercent),
      routes: quoteA.route,
    });
  }

  let amountBOutRaw = 0n;
  if (toAddressLower(inputToken) === toAddressLower(tokenB)) {
    amountBOutRaw = splitBRaw;
  } else if (splitBRaw > 0n) {
    const quoteB = await computeBestQuote({
      tokenIn: inputToken,
      tokenOut: tokenB,
      amountIn: formatUnits(splitBRaw, inputTokenDecimals),
      tokenInDecimals: inputTokenDecimals,
      userAddress: routeRecipient,
      useSplitRoutes: false,
    });
    amountBOutRaw = quoteB.amountOutRaw;
    swapArr.push({
      feeOnTransfer: false,
      amountInRaw: splitBRaw,
      amountOutMinRaw: applySlippage(amountBOutRaw, slippagePercent),
      routes: quoteB.route,
    });
  }

  return {
    swaps: swapArr,
    amountAOutRaw,
    amountBOutRaw,
    splitARaw,
    splitBRaw,
  };
}

export async function computeZapSplitPlan(
  params: ComputeZapSplitPlanParams,
): Promise<ZapSplitPlan> {
  const {
    poolType,
    poolAddress,
    tokenA,
    tokenB,
    inputToken,
    inputTokenDecimals,
    inputAmountRaw,
    routeRecipient,
    tickLower,
    tickUpper,
    slippagePercent = DEFAULT_SLIPPAGE_PERCENT,
  } = params;

  let splitRatios: { splitA: number; splitB: number };
  if (poolType === "basic") {
    splitRatios = await getBasicPoolSplitRatios(poolAddress, tokenA, tokenB, routeRecipient);
  } else {
    if (!Number.isFinite(tickLower) || !Number.isFinite(tickUpper)) {
      throw new Error("tickLower and tickUpper are required for CL split planning.");
    }
    splitRatios = await getCLPoolSplitRatios(poolAddress, tickLower as number, tickUpper as number, tokenA, tokenB);
  }

  const autoSwaps = await buildAutoSwaps({
    tokenA,
    tokenB,
    inputToken,
    inputTokenDecimals,
    inputAmountRaw,
    splitA: splitRatios.splitA,
    splitB: splitRatios.splitB,
    routeRecipient,
    slippagePercent,
  });

  return {
    splitA: splitRatios.splitA,
    splitB: splitRatios.splitB,
    splitARaw: autoSwaps.splitARaw,
    splitBRaw: autoSwaps.splitBRaw,
    amountAOutRaw: autoSwaps.amountAOutRaw,
    amountBOutRaw: autoSwaps.amountBOutRaw,
    amountAMinRaw: applySlippage(autoSwaps.amountAOutRaw, slippagePercent),
    amountBMinRaw: applySlippage(autoSwaps.amountBOutRaw, slippagePercent),
    swaps: autoSwaps.swaps,
  };
}
