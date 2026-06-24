import BigNumber from 'bignumber.js';
import { decodeFunctionResult, encodeFunctionData, parseUnits } from 'viem';

import { SERVER_CONFIG } from '../config.js';
import {
  MULTICALL3_ABI,
  ROUTER_HELPER_ABI,
  ROUTER_HELPER_ADDRESS,
} from '../constants/contracts.js';
import { getAmountDistribution } from '../utils/amountDistribution.js';
import { fetchAllCandidatePools } from '../utils/pairFetcher.js';
import { BaseRoute, RouteStep, computeAllRoutes } from '../utils/routing.js';
import {
  RouteWithQuote,
  RouteWithoutQuote,
  getBestRouteCombinationByQuotes,
} from '../utils/routeCombination.js';
import { publicClient } from '../utils/viemClient.js';

const QUOTE_MULTICALL_CHUNK_SIZES = [300, 150, 75, 40, 20, 10, 5, 1];
const MAX_SPLIT_CANDIDATE_ROUTES = 30;
const DEFAULT_DISTRIBUTION_PERCENT = 5;
const DEFAULT_MAX_SPLITS = 4;
const DEFAULT_MIN_SPLITS = 0;
/** Max price impact per hop before a route is rejected (mirrors website's 8% filter). */
const MAX_HOP_PRICE_IMPACT = 0.08;
/** Fee-on-transfer token addresses — multi-hop routes where any hop touches these are excluded before evaluation.
 *  Mirrors website's envConstants.feeOnTransferTokens (prodEnvConstants.ts). */
const FOT_TOKEN_ADDRESSES = [
  '0x5c09a9ce08c4b332ef1cc5f7cadb1158c32767ce', // fBOMB
];

export function isFOTToken(address: string): boolean {
  return FOT_TOKEN_ADDRESSES.some((t) => t.toLowerCase() === address.toLowerCase());
}

export interface ComputeBestQuoteParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  tokenInDecimals?: number;
  userAddress: string;
  useSplitRoutes?: boolean;
  distributionPercent?: number;
  maxSplits?: number;
  minSplits?: number;
}

export interface BestQuoteResult {
  amountInRaw: bigint;
  amountOutRaw: bigint;
  route: RouteStep[];
  amountsByHopRaw: bigint[];
  priceBeforeSwapRaw: bigint[];
  priceAfterSwapRaw: bigint[];
  routesScanned: number;
  routingPlan: {
    mode: 'single' | 'split';
    splitDetails?: {
      distributionPercent: number;
      splitCount: number;
      routes: Array<{
        percent: number;
        bps: number;
        amountInRaw: bigint;
        amountOutRaw: bigint;
        route: RouteStep[];
      }>;
    };
  };
}

interface RouteQuoteEvaluation {
  routeIndex: number;
  amountOutRaw: bigint;
  amountsByHopRaw: bigint[];
  priceBeforeSwapRaw: bigint[];
  priceAfterSwapRaw: bigint[];
}

/**
 * Price impact for a single hop using the sqrtPrice values from getAmountsOut.
 * Mirrors website's getBasicPriceImpact / getConcentratedPriceImpact in features/swap/utils.ts.
 *
 * Direction matters: CL pools always store sqrtPrice as sqrt(token1/token0) in Q64.96.
 * When swapping token1→token0 (isInverse=true), we invert the price so the impact is positive.
 * Returns signed fractional impact (0.05 = 5%). Returns 0 when either price is unavailable.
 */
function computeHopPriceImpact(sqrtBefore: bigint, sqrtAfter: bigint, hop: RouteStep): number {
  if (sqrtBefore === 0n || sqrtAfter === 0n) return 0;

  // isInverse: tokenFrom is token1 of the pool (swapping against the canonical direction)
  const isInverse = hop.from.toLowerCase() !== hop.token0.toLowerCase();

  let initialPrice: number;
  let newPrice: number;

  if (hop.concentrated) {
    // CL: price = (sqrtPriceX96 / 2^96)^2 — ratios: dividing cancels the 2^96 scale factor
    const before = Number(sqrtBefore);
    const after = Number(sqrtAfter);
    initialPrice = (before / after) * (before / after); // (sqrtBefore/sqrtAfter)^2 relative
    // Recompute as absolute prices for impact formula
    const Q96 = 2 ** 96;
    const p0 = (Number(sqrtBefore) / Q96) ** 2;
    const p1 = (Number(sqrtAfter) / Q96) ** 2;
    initialPrice = isInverse ? 1 / p0 : p0;
    newPrice = isInverse ? 1 / p1 : p1;
  } else {
    // Basic: price = sqrtRaw / 1e18
    const p0 = Number(sqrtBefore) / 1e18;
    const p1 = Number(sqrtAfter) / 1e18;
    initialPrice = isInverse ? 1 / p0 : p0;
    newPrice = isInverse ? 1 / p1 : p1;
  }

  if (initialPrice === 0) return 0;
  return (initialPrice - newPrice) / initialPrice;
}

/**
 * Returns true when every hop in the route stays within maxImpact.
 * Mirrors website's isRouteWithQuoteValid / priceImpactList.every(<=8%) check.
 */
function isRouteWithinPriceImpact(
  evaluation: RouteQuoteEvaluation,
  route: BaseRoute,
  maxImpact: number,
): boolean {
  const hops = route.routes;
  for (let i = 0; i < hops.length; i++) {
    const sqrtBefore = evaluation.priceBeforeSwapRaw[i] ?? 0n;
    const sqrtAfter = evaluation.priceAfterSwapRaw[i] ?? 0n;
    const impact = computeHopPriceImpact(sqrtBefore, sqrtAfter, hops[i]!);
    if (impact > maxImpact) return false;
  }
  return true;
}

export async function computeBestQuote(
  params: ComputeBestQuoteParams,
): Promise<BestQuoteResult> {
  const {
    tokenIn,
    tokenOut,
    amountIn,
    tokenInDecimals = 18,
    userAddress,
    useSplitRoutes = false,
    distributionPercent,
    maxSplits,
    minSplits,
  } = params;
  const effectiveDistributionPercent = normalizeDistributionPercent(distributionPercent);
  const effectiveMaxSplits = normalizeMaxSplits(maxSplits);
  const effectiveMinSplits = normalizeMinSplits(minSplits, effectiveMaxSplits);

  const amountInRaw = parseUnits(amountIn, tokenInDecimals);

  console.error('Fetching candidate pools...');
  const candidatePools = await fetchAllCandidatePools(userAddress);

  console.error('Computing permutations...');
  const allRoutes = computeAllRoutes(tokenIn, tokenOut, candidatePools, userAddress);

  if (allRoutes.length === 0) {
    throw new Error('No available path found between the specified tokens.');
  }

  // Pre-filter: exclude multi-hop routes where any hop touches a FOT token.
  // Mirrors website's routeChunks computation in useGetAmountsOut (router-v2.tsx).
  const filteredRoutes = allRoutes.filter(
    (route) =>
      route.routes.length === 1 ||
      !route.routes.some((hop) => isFOTToken(hop.from) || isFOTToken(hop.to)),
  );

  if (filteredRoutes.length === 0) {
    throw new Error('No available path found between the specified tokens.');
  }

  console.error(`Testing ${filteredRoutes.length} route paths via multicall...`);
  const routeEvaluations = await evaluateRouteQuotesWithAdaptiveChunking(
    filteredRoutes,
    amountInRaw,
  );

  // Route selection — mirrors website's topRoutesInfo / isRouteWithQuoteValid logic:
  //   1. Pick the best route (by output amount) where ALL hops have ≤8% price impact.
  //   2. If none pass the impact filter, fall back to the best 1-hop (direct) route.
  const validEvaluations = routeEvaluations.filter((e) => {
    const route = filteredRoutes[e.routeIndex];
    return route && isRouteWithinPriceImpact(e, route, MAX_HOP_PRICE_IMPACT);
  });

  const candidateEvaluations: RouteQuoteEvaluation[] =
    validEvaluations.length > 0
      ? validEvaluations
      : routeEvaluations.filter((e) => {
          const route = filteredRoutes[e.routeIndex];
          return route && route.routes.length === 1;
        });

  const bestSingleRoute = candidateEvaluations.reduce<RouteQuoteEvaluation | null>(
    (currentBest, candidate) => {
      if (!currentBest || candidate.amountOutRaw > currentBest.amountOutRaw) {
        return candidate;
      }
      return currentBest;
    },
    null,
  );

  if (!bestSingleRoute) {
    throw new Error('Failed to compute a valid quote for the provided token pair.');
  }

  let bestAmountOut = bestSingleRoute.amountOutRaw;
  let selectedPlan: BestQuoteResult['routingPlan'] = {
    mode: 'single',
  };

  // Only split among routes that passed the price impact filter — mirrors website's isRouteWithQuoteValid.
  if (useSplitRoutes && validEvaluations.length >= 2) {
    const splitCandidateRoutes = validEvaluations
      .sort((a, b) => {
        if (a.amountOutRaw === b.amountOutRaw) return 0;
        return a.amountOutRaw > b.amountOutRaw ? -1 : 1;
      })
      .slice(0, MAX_SPLIT_CANDIDATE_ROUTES)
      .map((evaluation) => filteredRoutes[evaluation.routeIndex])
      .filter((route): route is BaseRoute => Boolean(route));

    const splitCombination = await computeBestSplitCombination({
      routes: splitCandidateRoutes,
      amountInRaw,
      distributionPercent: effectiveDistributionPercent,
      maxSplits: effectiveMaxSplits,
      minSplits: effectiveMinSplits,
    });
    if (
      splitCombination &&
      splitCombination.outputAmountRaw > bestSingleRoute.amountOutRaw
    ) {
      bestAmountOut = splitCombination.outputAmountRaw;
      selectedPlan = {
        mode: 'split',
        splitDetails: {
          distributionPercent: effectiveDistributionPercent,
          splitCount: splitCombination.routes.length,
          routes: splitCombination.routes.map((routeItem) => ({
            percent: routeItem.percent,
            bps: routeItem.percent * 100,
            amountInRaw: routeItem.amountRaw,
            amountOutRaw: routeItem.quoteRaw,
            route: routeItem.route,
          })),
        },
      };
    }
  }

  return {
    amountInRaw,
    amountOutRaw: bestAmountOut,
    route: filteredRoutes[bestSingleRoute.routeIndex].routes,
    amountsByHopRaw: bestSingleRoute.amountsByHopRaw,
    priceBeforeSwapRaw: bestSingleRoute.priceBeforeSwapRaw,
    priceAfterSwapRaw: bestSingleRoute.priceAfterSwapRaw,
    routesScanned: filteredRoutes.length,
    routingPlan: selectedPlan,
  };
}

function buildMulticallCalls(routes: BaseRoute[], amountInRaw: bigint) {
  return routes.map((baseRoute) => ({
    target: ROUTER_HELPER_ADDRESS as `0x${string}`,
    callData: encodeFunctionData({
      abi: ROUTER_HELPER_ABI,
      functionName: 'getAmountsOut',
      args: [amountInRaw, baseRoute.routes as any],
    }),
  }));
}

function decodeRouteQuotes(
  multicallResult: Array<{ success: boolean; returnData: `0x${string}` }>,
  routeIndexOffset = 0,
): RouteQuoteEvaluation[] {
  const evaluations: RouteQuoteEvaluation[] = [];

  for (let i = 0; i < multicallResult.length; i += 1) {
    const { success, returnData } = multicallResult[i];
    if (!success || !returnData || returnData === '0x') {
      continue;
    }

    try {
      const [amounts, priceBeforeSwap, priceAfterSwap] = decodeFunctionResult({
        abi: ROUTER_HELPER_ABI,
        functionName: 'getAmountsOut',
        data: returnData,
      }) as [bigint[], bigint[], bigint[]];

      if (!amounts || amounts.length === 0) {
        continue;
      }

      const finalAmount = amounts[amounts.length - 1];
      if (finalAmount <= 0n) {
        continue;
      }

      evaluations.push({
        routeIndex: i + routeIndexOffset,
        amountOutRaw: finalAmount,
        amountsByHopRaw: amounts,
        priceBeforeSwapRaw: priceBeforeSwap ?? [],
        priceAfterSwapRaw: priceAfterSwap ?? [],
      });
    } catch {
      // Ignore decode errors for invalid/unavailable routes.
    }
  }

  return evaluations;
}

async function evaluateRouteQuotesWithAdaptiveChunking(
  routes: BaseRoute[],
  amountInRaw: bigint,
): Promise<RouteQuoteEvaluation[]> {
  for (const chunkSize of QUOTE_MULTICALL_CHUNK_SIZES) {
    try {
      const routeChunks = chunk(routes, chunkSize);
      const evaluationsForChunkSize: RouteQuoteEvaluation[] = [];
      let processedRoutes = 0;

      for (const routeChunk of routeChunks) {
        const multicallCalls = buildMulticallCalls(routeChunk, amountInRaw);
        const multicallResult = (await publicClient.readContract({
          address: SERVER_CONFIG.MULTICALL3_ADDRESS as `0x${string}`,
          abi: MULTICALL3_ABI,
          functionName: 'tryAggregate',
          args: [false, multicallCalls],
        })) as Array<{ success: boolean; returnData: `0x${string}` }>;

        const chunkEvaluations = decodeRouteQuotes(multicallResult, processedRoutes);
        evaluationsForChunkSize.push(...chunkEvaluations);
        processedRoutes += routeChunk.length;
      }

      return evaluationsForChunkSize;
    } catch {
      // Retry full quote evaluation with a smaller chunk size.
      continue;
    }
  }

  throw new Error(
    'Unable to evaluate quote routes due to RPC call limits. Please retry.',
  );
}

function toRawAmount(amount: BigNumber): bigint {
  const normalized = amount.integerValue(BigNumber.ROUND_FLOOR).toFixed(0);
  const raw = BigInt(normalized);
  return raw > 0n ? raw : 0n;
}

async function computeBestSplitCombination({
  routes,
  amountInRaw,
  distributionPercent,
  maxSplits,
  minSplits,
}: {
  routes: BaseRoute[];
  amountInRaw: bigint;
  distributionPercent: number;
  maxSplits: number;
  minSplits: number;
}): Promise<{
  outputAmountRaw: bigint;
  routes: Array<{
    percent: number;
    amountRaw: bigint;
    quoteRaw: bigint;
    route: RouteStep[];
  }>;
} | null> {
  const inputAmount = new BigNumber(amountInRaw.toString());
  const [percents, amounts] = getAmountDistribution(inputAmount, distributionPercent);

  const routesWithoutQuote: RouteWithoutQuote[] = amounts.reduce<RouteWithoutQuote[]>(
    (acc, curAmount, i) => [
      ...acc,
      ...routes.map((r) => ({
        ...r,
        amount: curAmount,
        percent: percents[i]!,
      })),
    ],
    [],
  );

  const routesWithQuote = await getRoutesWithQuote(routesWithoutQuote);
  if (routesWithQuote.length === 0) {
    return null;
  }

  const bestRouteCombination = getBestRouteCombinationByQuotes(
    inputAmount,
    routesWithQuote,
    {
      maxSplits,
      minSplits,
    },
  );
  if (!bestRouteCombination) {
    return null;
  }

  return {
    outputAmountRaw: toRawAmount(bestRouteCombination.outputAmount),
    routes: bestRouteCombination.routes.map((routeItem) => ({
      percent: routeItem.percent,
      amountRaw: toRawAmount(routeItem.amount),
      quoteRaw: toRawAmount(routeItem.quote),
      route: routeItem.route,
    })),
  };
}

function chunk<T>(items: T[], size: number): T[][] {
  if (items.length === 0) return [];
  const chunks: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

async function getRoutesWithQuote(
  routesWithoutQuote: RouteWithoutQuote[],
): Promise<RouteWithQuote[]> {
  for (const chunkSize of QUOTE_MULTICALL_CHUNK_SIZES) {
    try {
      const routeChunks = chunk(routesWithoutQuote, chunkSize);
      const validRoutes: RouteWithQuote[] = [];

      for (const routeChunk of routeChunks) {
        const multicallCalls = routeChunk.map((routeWithoutQuote) => {
          const routeAmountRaw = toRawAmount(routeWithoutQuote.amount);
          return {
            target: ROUTER_HELPER_ADDRESS as `0x${string}`,
            callData: encodeFunctionData({
              abi: ROUTER_HELPER_ABI,
              functionName: 'getAmountsOut',
              args: [routeAmountRaw, routeWithoutQuote.routes as any],
            }),
          };
        });

        const multicallResult = (await publicClient.readContract({
          address: SERVER_CONFIG.MULTICALL3_ADDRESS as `0x${string}`,
          abi: MULTICALL3_ABI,
          functionName: 'tryAggregate',
          args: [false, multicallCalls],
        })) as Array<{ success: boolean; returnData: `0x${string}` }>;

        for (let i = 0; i < multicallResult.length; i += 1) {
          const { success, returnData } = multicallResult[i];
          if (!success || !returnData || returnData === '0x') {
            continue;
          }

          const routeWithoutQuote = routeChunk[i];
          if (!routeWithoutQuote) continue;

          try {
            const [amounts] = decodeFunctionResult({
              abi: ROUTER_HELPER_ABI,
              functionName: 'getAmountsOut',
              data: returnData,
            }) as [bigint[], bigint[], bigint[]];

            if (!amounts || amounts.length === 0) {
              continue;
            }

            const finalAmount = amounts[amounts.length - 1];
            if (finalAmount <= 0n) {
              continue;
            }

            validRoutes.push({
              ...routeWithoutQuote,
              quote: new BigNumber(finalAmount.toString()),
              route: routeWithoutQuote.routes,
            });
          } catch {
            // Ignore decode failures.
          }
        }
      }

      validRoutes.sort((a, b) => b.quote.comparedTo(a.quote) || 0);
      return validRoutes;
    } catch {
      // Retry full split-quote evaluation with a smaller chunk size.
      continue;
    }
  }

  throw new Error(
    'Unable to evaluate split quote routes due to RPC call limits. Please retry.',
  );
}

function normalizeDistributionPercent(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_DISTRIBUTION_PERCENT;
  const normalized = Math.floor(value as number);
  if (normalized <= 0 || normalized > 100) {
    return DEFAULT_DISTRIBUTION_PERCENT;
  }
  return normalized;
}

function normalizeMaxSplits(value?: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MAX_SPLITS;
  const normalized = Math.floor(value as number);
  if (normalized < 1) return DEFAULT_MAX_SPLITS;
  return normalized;
}

function normalizeMinSplits(value: number | undefined, maxSplits: number): number {
  if (!Number.isFinite(value)) return DEFAULT_MIN_SPLITS;
  const normalized = Math.floor(value as number);
  if (normalized < 0) return DEFAULT_MIN_SPLITS;
  return normalized > maxSplits ? maxSplits : normalized;
}
