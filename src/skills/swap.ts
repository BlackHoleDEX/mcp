import { formatUnits, parseUnits } from 'viem';

import {
  ERC20_ABI,
  ROUTER_V2_ABI,
  ROUTER_V2_ADDRESS,
} from '../constants/contracts.js';
import { computeBestQuote, isFOTToken } from '../services/quoteService.js';
import { hasSufficientAllowance } from '../utils/erc20.js';
import { getEnvUserAddress } from "../utils/wallet.js";
import { isNativeAvaxToken, normalizeTokenAddress } from '../utils/nativeToken.js';

const DEFAULT_SWAP_SLIPPAGE_PERCENT = 1;

function applySlippage(rawAmount: bigint, slippagePercent: number): bigint {
  const clamped = Math.min(Math.max(slippagePercent, 0), 99.99);
  const bps = BigInt(Math.floor(clamped * 100));
  return (rawAmount * (10000n - bps)) / 10000n;
}

export interface SwapParams {
  tokenIn: string;
  tokenOut: string;
  amountIn?: string;
  // Raw input amount (wei). Preferred for exact full-balance swaps; takes precedence over amountIn.
  amountInRaw?: string;
  amountOutMin?: string;
  // Raw min output amount (wei). Takes precedence over amountOutMin.
  amountOutMinRaw?: string;
  slippagePercent?: number;
  slippageConfirmed?: boolean;
  userAddress?: string;
  tokenInDecimals?: number;
  tokenOutDecimals?: number;
  useSplitRoutes?: boolean;
  distributionPercent?: number;
  maxSplits?: number;
  minSplits?: number;
  feeOnTransfer?: boolean;
}

export async function handleSwapSteps(params: SwapParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const {
    tokenIn,
    tokenOut,
    amountIn,
    amountInRaw: providedAmountInRaw,
    tokenInDecimals = 18,
    tokenOutDecimals = 18,
    useSplitRoutes = false,
    distributionPercent,
    maxSplits,
    minSplits,
    slippagePercent = DEFAULT_SWAP_SLIPPAGE_PERCENT,
    slippageConfirmed = false,
  } = params;

  if ((!amountIn || amountIn === '') && (!providedAmountInRaw || providedAmountInRaw === '')) {
    throw new Error("Provide amountIn or amountInRaw.");
  }
  const amountInRaw = providedAmountInRaw && providedAmountInRaw !== ''
    ? BigInt(providedAmountInRaw)
    : parseUnits(amountIn!, tokenInDecimals);
  const amountInForQuote = formatUnits(amountInRaw, tokenInDecimals);
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

  const isNativeIn = isNativeAvaxToken(tokenIn);
  const isNativeOut = isNativeAvaxToken(tokenOut);
  // Resolve effective token addresses for quote/approval (WAVAX for native AVAX)
  const effectiveTokenIn = normalizeTokenAddress(tokenIn);
  const effectiveTokenOut = normalizeTokenAddress(tokenOut);

  // FOT: explicit param wins, otherwise auto-detect from quoteService's known FOT list
  const isFOT = params.feeOnTransfer ?? (isFOTToken(effectiveTokenIn) || isFOTToken(effectiveTokenOut));

  const bestQuote = await computeBestQuote({
    tokenIn: effectiveTokenIn,
    tokenOut: effectiveTokenOut,
    amountIn: amountInForQuote,
    tokenInDecimals,
    userAddress,
    useSplitRoutes,
    distributionPercent,
    maxSplits,
    minSplits,
  });

  const computedAmountOutMinRaw = applySlippage(bestQuote.amountOutRaw, slippagePercent);
  const computedAmountOutMin = formatUnits(computedAmountOutMinRaw, tokenOutDecimals);

  if (!slippageConfirmed) {
    return {
      success: false,
      action_required: "confirm_slippage",
      message: [
        `Default swap slippage is **${slippagePercent}%**.`,
        `  • Expected output: ${formatUnits(bestQuote.amountOutRaw, tokenOutDecimals)}`,
        `  • Minimum you will receive: ${computedAmountOutMin} (after ${slippagePercent}% slippage)`,
        isFOT ? "  • Fee-on-transfer token detected — using SupportingFeeOnTransferTokens router functions." : "",
        "Present this to the user and ask if they want to keep this slippage or change it. Once confirmed, re-call this tool with slippageConfirmed=true (and slippagePercent set to any updated value).",
      ].filter(Boolean).join("\n"),
      slippage: {
        slippage_percent: slippagePercent,
        expected_amount_out: formatUnits(bestQuote.amountOutRaw, tokenOutDecimals),
        amount_out_min: computedAmountOutMin,
        feeOnTransfer: isFOT,
      },
    };
  }

  const amountOutMinRaw: bigint =
    params.amountOutMinRaw && params.amountOutMinRaw !== ''
      ? BigInt(params.amountOutMinRaw)
      : params.amountOutMin
        ? parseUnits(params.amountOutMin, tokenOutDecimals)
        : computedAmountOutMinRaw;

  const steps = [];

  // Step 1: Approve Token In — skipped for native AVAX (no ERC20 approval needed)
  if (!isNativeIn) {
    const approvalAlreadySufficient = await hasSufficientAllowance(
      effectiveTokenIn,
      userAddress,
      ROUTER_V2_ADDRESS,
      amountInRaw,
    );
    if (!approvalAlreadySufficient) {
      steps.push({
        title: 'Approve Token In',
        description: `Approve the Blackhole Router V2 to spend ${amountInForQuote} of Token ${effectiveTokenIn}`,
        waitForReceipt: true,
        payload: {
          to: effectiveTokenIn,
          abi: ERC20_ABI,
          functionName: 'approve',
          args: [ROUTER_V2_ADDRESS, amountInRaw.toString()],
          value: '0',
        },
      });
    }
  }

  if (
    bestQuote.routingPlan.mode === 'split' &&
    bestQuote.routingPlan.splitDetails &&
    bestQuote.routingPlan.splitDetails.routes.length > 1
  ) {
    const splitDetails = bestQuote.routingPlan.splitDetails;
    // Each per-route amountIn is floor-divided, so their sum can be 1–N wei short
    // of the total. Give the remainder to the last route so the router sees exact amounts.
    const splitAmounts = splitDetails.routes.map((r) => BigInt(r.amountInRaw.toString()));
    const splitSum = splitAmounts.reduce((a, b) => a + b, 0n);
    if (splitSum < amountInRaw && splitAmounts.length > 0) {
      splitAmounts[splitAmounts.length - 1]! += amountInRaw - splitSum;
    }
    const zapParams = {
      inputTokens: [effectiveTokenIn],
      amounts: [amountInRaw],
      outputToken: effectiveTokenOut,
      swaps: splitDetails.routes.map((splitRoute, i) => ({
        feeOnTransfer: isFOT,
        amountIn: splitAmounts[i]!,
        amountOutMin: BigInt(0),
        routes: splitRoute.route,
      })),
      minAmountOut: amountOutMinRaw,
      unwrapWETH: isNativeOut,
      usenative: isNativeIn,
      deadline,
      to: userAddress,
    };

    steps.push({
      title: 'Execute Split Swap (Zap)',
      description: `Execute split-route swap via zapToSingleToken (${splitDetails.splitCount} split routes)${isFOT ? ' [FOT]' : ''}.`,
      payload: {
        to: ROUTER_V2_ADDRESS,
        abi: ROUTER_V2_ABI,
        functionName: 'zapToSingleToken',
        args: [zapParams],
        value: isNativeIn ? amountInRaw.toString() : '0',
      },
    });
  } else {
    // Pick the correct router function based on native AVAX direction and FOT flag
    let swapFunctionName: string;
    let swapArgs: unknown[];
    let swapValue: string;

    if (isNativeIn) {
      swapFunctionName = isFOT
        ? 'swapExactETHForTokensSupportingFeeOnTransferTokens'
        : 'swapExactETHForTokens';
      swapArgs = [amountOutMinRaw, bestQuote.route, userAddress, deadline];
      swapValue = amountInRaw.toString();
    } else if (isNativeOut) {
      swapFunctionName = isFOT
        ? 'swapExactTokensForETHSupportingFeeOnTransferTokens'
        : 'swapExactTokensForETH';
      swapArgs = [amountInRaw, amountOutMinRaw, bestQuote.route, userAddress, deadline];
      swapValue = '0';
    } else {
      swapFunctionName = isFOT
        ? 'swapExactTokensForTokensSupportingFeeOnTransferTokens'
        : 'swapExactTokensForTokens';
      swapArgs = [amountInRaw, amountOutMinRaw, bestQuote.route, userAddress, deadline];
      swapValue = '0';
    }

    steps.push({
      title: 'Execute Swap',
      description: `Swap via Router V2 using ${swapFunctionName} (${bestQuote.route.length} hop${bestQuote.route.length !== 1 ? 's' : ''})`,
      payload: {
        to: ROUTER_V2_ADDRESS,
        abi: ROUTER_V2_ABI,
        functionName: swapFunctionName,
        args: swapArgs,
        value: swapValue,
      },
    });
  }

  return {
    success: true,
    sequential: true,
    message:
      bestQuote.routingPlan.mode === 'split'
        ? `Computed split-route swap plan via zapToSingleToken. Exact amountIn=${amountInRaw.toString()} raw, amountOut=${bestQuote.amountOutRaw.toString()} raw. These are exact bigints — do NOT round when quoting the user.`
        : `Computed optimal route. Exact amountIn=${amountInRaw.toString()} raw, amountOut=${bestQuote.amountOutRaw.toString()} raw. These are exact bigints — do NOT round when quoting the user.`,
    steps,
  };
}

export const swapTool = {
  name: "swap_steps",
  description:
    "Returns the step-by-step transaction payloads to perform a token swap on the Blackhole DEX. " +
    `On the first call (slippageConfirmed omitted or false) the tool fetches a quote, then returns a slippage confirmation prompt showing the expected output and minimum received at the default ${DEFAULT_SWAP_SLIPPAGE_PERCENT}% slippage. ` +
    "Present this to the user and ask if they want to change it. Re-call with slippageConfirmed=true once confirmed. " +
    "Steps must be executed sequentially — if an approval step is present it must confirm on-chain before the swap is sent.",
  inputSchema: {
    type: "object",
    properties: {
      tokenIn: { type: "string", description: "The address of the input token (e.g., AVAX, USDC)." },
      tokenOut: { type: "string", description: "The address of the output token." },
      amountIn: { type: "string", description: "Human-readable input amount (e.g., '10'). Ignored when amountInRaw is provided." },
      amountInRaw: { type: "string", description: "Raw input amount (wei). Preferred for exact full-balance swaps; takes precedence over amountIn." },
      slippagePercent: { type: "number", description: `Slippage tolerance % applied to the quoted output to compute amountOutMin (default ${DEFAULT_SWAP_SLIPPAGE_PERCENT}%).` },
      slippageConfirmed: { type: "boolean", description: "Set to true after the user confirms slippage. Defaults to false, returning a confirmation prompt." },
      amountOutMin: { type: "string", description: "Override: explicit human-readable min output amount. When omitted, computed from quote × (1 - slippage%)." },
      amountOutMinRaw: { type: "string", description: "Override: explicit raw min output amount (wei). Takes precedence over amountOutMin." },
      userAddress: { type: "string", description: "Optional. The wallet address of the user performing the swap. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      tokenInDecimals: { type: "number", description: "Decimals of the input token (defaults to 18)." },
      tokenOutDecimals: { type: "number", description: "Decimals of the output token (defaults to 18)." },
      useSplitRoutes: { type: "boolean", description: "Enable split-route search; swap_steps will use zapToSingleToken when split route wins." },
      distributionPercent: { type: "number", description: "Optional split granularity (used when useSplitRoutes=true; default 5)." },
      maxSplits: { type: "number", description: "Optional max split count (used when useSplitRoutes=true; default 4)." },
      minSplits: { type: "number", description: "Optional min split count (used when useSplitRoutes=true; default 0)." },
      poolAddress: { type: "string", description: "Explicit pair/pool address if already known." },
      feeOnTransfer: { type: "boolean", description: "Set to true to use fee-on-transfer (FOT) router functions. Auto-detected for known FOT tokens (e.g. fBOMB). Override with false to force standard path." },
    },
    required: ["tokenIn", "tokenOut"],
  },
};
