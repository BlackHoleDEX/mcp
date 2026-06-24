import { formatUnits } from 'viem';

import { computeBestQuote } from '../services/quoteService.js';

const DEFAULT_QUOTE_RECEIVER = '0x0000000000000000000000000000000000000001';

export interface QuoteParams {
  tokenIn: string;
  tokenOut: string;
  amountIn: string;
  tokenInDecimals?: number;
  tokenOutDecimals?: number;
  userAddress?: string;
  useSplitRoutes?: boolean;
  distributionPercent?: number;
  maxSplits?: number;
  minSplits?: number;
}

export async function handleQuote(params: QuoteParams) {
  const {
    tokenIn,
    tokenOut,
    amountIn,
    tokenInDecimals = 18,
    tokenOutDecimals = 18,
    userAddress = DEFAULT_QUOTE_RECEIVER,
    useSplitRoutes = false,
    distributionPercent,
    maxSplits,
    minSplits,
  } = params;

  const bestQuote = await computeBestQuote({
    tokenIn,
    tokenOut,
    amountIn,
    tokenInDecimals,
    userAddress,
    useSplitRoutes,
    distributionPercent,
    maxSplits,
    minSplits,
  });

  const splitDetails = bestQuote.routingPlan.splitDetails;

  return {
    success: true,
    message: `Computed ${bestQuote.routingPlan.mode} routing quote across ${bestQuote.routesScanned} route options.`,
    quote: {
      tokenIn,
      tokenOut,
      amountIn,
      routingMode: bestQuote.routingPlan.mode,
      amountInRaw: bestQuote.amountInRaw.toString(),
      amountOutRaw: bestQuote.amountOutRaw.toString(),
      amountOut: formatUnits(bestQuote.amountOutRaw, tokenOutDecimals),
      routeHops: bestQuote.route.length,
      route: bestQuote.route,
      amountsByHopRaw: bestQuote.amountsByHopRaw.map((amount) => amount.toString()),
      priceBeforeSwapRaw: bestQuote.priceBeforeSwapRaw.map((price) => price.toString()),
      priceAfterSwapRaw: bestQuote.priceAfterSwapRaw.map((price) => price.toString()),
      splitDetails: splitDetails
        ? {
            distributionPercent: splitDetails.distributionPercent,
            splitCount: splitDetails.splitCount,
            routes: splitDetails.routes.map((routeItem) => ({
              percent: routeItem.percent,
              bps: routeItem.bps,
              amountInRaw: routeItem.amountInRaw.toString(),
              amountOutRaw: routeItem.amountOutRaw.toString(),
              route: routeItem.route,
            })),
          }
        : null,
    },
  };
}

export const quoteTool = {
  name: "quote",
  description: "Returns the best output quote and route for a token swap on the Blackhole DEX.",
  inputSchema: {
    type: "object",
    properties: {
      tokenIn: { type: "string", description: "The address of the input token." },
      tokenOut: { type: "string", description: "The address of the output token." },
      amountIn: { type: "string", description: "The human-readable amount of the input token (e.g., '10')." },
      tokenInDecimals: { type: "number", description: "Decimals of the input token (defaults to 18)." },
      tokenOutDecimals: { type: "number", description: "Decimals of the output token (defaults to 18)." },
      userAddress: { type: "string", description: "Optional user address used for route context." },
      useSplitRoutes: { type: "boolean", description: "Enable split-route combination search (5% distribution increments, up to 4 splits). Defaults to false." },
      distributionPercent: { type: "number", description: "Optional split percentage granularity (e.g., 5). Used only when useSplitRoutes=true; defaults to 5." },
      maxSplits: { type: "number", description: "Optional maximum number of split routes in the combination. Used only when useSplitRoutes=true; defaults to 4." },
      minSplits: { type: "number", description: "Optional minimum number of split routes in the combination. Used only when useSplitRoutes=true; defaults to 0." },
    },
    required: ["tokenIn", "tokenOut", "amountIn"],
  },
};
