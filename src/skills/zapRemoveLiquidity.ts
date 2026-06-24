import { parseUnits } from "viem";

import { ERC20_ABI, ROUTER_V2_ABI, ROUTER_V2_ADDRESS } from "../constants/contracts.js";
import { getRouterV2ForDeployer } from "../utils/legacyContracts.js";
import { resolveDeployer } from "../utils/customPoolDeployer.js";
import { computeZapRemovePlan } from "../services/zapRemovePlanner.js";
import { hasSufficientAllowance } from "../utils/erc20.js";
import { getEnvUserAddress } from "../utils/wallet.js";

type RouteStep = {
  pair: string;
  from: string;
  to: string;
  stable: boolean;
  concentrated: boolean;
  receiver: string;
};

type ZapSwap = {
  feeOnTransfer?: boolean;
  // Accept either human (amountIn + amountInDecimals) or raw (amountInRaw). Raw wins when both present.
  amountIn?: string;
  amountInDecimals?: number;
  amountInRaw?: string;
  amountOutMin?: string;
  amountOutMinDecimals?: number;
  amountOutMinRaw?: string;
  routes: RouteStep[];
};

function resolveAmount(
  raw: string | undefined,
  human: string | undefined,
  decimals: number,
  defaultHuman?: string,
): bigint {
  if (raw !== undefined && raw !== null && raw !== "") {
    return BigInt(raw);
  }
  const h = human ?? defaultHuman;
  if (h === undefined) {
    throw new Error("Missing amount (provide either the raw or human-readable field).");
  }
  return parseUnits(h, decimals);
}

function mapSwaps(swaps: ZapSwap[], outputTokenDecimals = 18) {
  return swaps.map((swap, i) => {
    try {
      return {
        feeOnTransfer: !!swap.feeOnTransfer,
        amountIn: resolveAmount(swap.amountInRaw, swap.amountIn, swap.amountInDecimals ?? 18),
        amountOutMin: resolveAmount(
          swap.amountOutMinRaw,
          swap.amountOutMin,
          swap.amountOutMinDecimals ?? outputTokenDecimals,
          "0",
        ),
        routes: swap.routes,
      };
    } catch (err: any) {
      throw new Error(`swaps[${i}]: ${err?.message ?? err}`);
    }
  });
}

export interface ZapRemoveLiquidityParams {
  mode: "v2" | "cl";
  userAddress?: string;
  to?: string;
  outputToken: string;
  outputTokenDecimals?: number;
  minAmountOut?: string;
  minAmountOutRaw?: string;
  unwrapWETH?: boolean;
  deadline?: number;
  swaps?: ZapSwap[];
  /** Slippage applied to each swap's amountOutMin and total minAmountOut. Default: 5%. */
  slippagePercent?: number;
  /** Slippage applied to amountAMin/amountBMin from LP removal. Default: 0.5%. */
  removeSlippagePercent?: number;
  slippageConfirmed?: boolean;

  // Expected pool-side amounts coming out of liquidity removal.
  // Required for auto-plan when swaps are omitted; match client splitA/splitB.
  expectedAmountA?: string;
  expectedAmountB?: string;
  expectedAmountARaw?: string;
  expectedAmountBRaw?: string;

  // v2
  tokenA?: string;
  tokenB?: string;
  tokenADecimals?: number;
  tokenBDecimals?: number;
  stable?: boolean;
  lpTokenAddress?: string;
  lpTokenDecimals?: number;
  liquidity?: string;
  amount0Min?: string;
  amount1Min?: string;
  amount0MinDecimals?: number;
  amount1MinDecimals?: number;

  // cl
  tokenId?: number;
  deployer?: string;
  poolAddress?: string;
  liquidityRaw?: string;
  token0?: string;
  token1?: string;
  token0Decimals?: number;
  token1Decimals?: number;
}

const DEFAULT_SWAP_SLIPPAGE_PERCENT = 1;
const DEFAULT_REMOVE_SLIPPAGE_PERCENT = 1;

export async function handleZapRemoveLiquiditySteps(params: ZapRemoveLiquidityParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");

  const {
    mode,
    outputToken,
    outputTokenDecimals = 18,
    unwrapWETH = false,
    deadline = Math.floor(Date.now() / 1000) + 60 * 20,
    swaps: userSwaps,
    slippagePercent = DEFAULT_SWAP_SLIPPAGE_PERCENT,
    removeSlippagePercent = DEFAULT_REMOVE_SLIPPAGE_PERCENT,
    slippageConfirmed = false,
  } = params;

  const to = params.to ?? userAddress;

  // Ask user to confirm both slippages before building steps.
  if (!slippageConfirmed) {
    return {
      success: false,
      action_required: "confirm_slippage",
      message: [
        "Before building zap remove liquidity steps, please confirm the slippage settings:",
        `  • **Remove slippage: ${removeSlippagePercent}%** — applied to the minimum tokenA/tokenB amounts received from LP removal (amount0Min / amount1Min).`,
        `  • **Swap slippage: ${slippagePercent}%** — applied to each swap's minimum output and the overall minimum output token received (minAmountOut).`,
        "Present both slippage values to the user and ask if they want to change either. Once confirmed, re-call this tool with slippageConfirmed=true (and updated removeSlippagePercent / slippagePercent as needed).",
      ].join("\n"),
      slippage: {
        remove_slippage_percent: removeSlippagePercent,
        swap_slippage_percent: slippagePercent,
      },
    };
  }

  let mappedSwaps: ReturnType<typeof mapSwaps> = [];
  let minAmountOutRaw: bigint;
  let autoAmountAMinRaw: bigint | undefined;
  let autoAmountBMinRaw: bigint | undefined;

  if (userSwaps && userSwaps.length > 0) {
    mappedSwaps = mapSwaps(userSwaps, outputTokenDecimals);
    minAmountOutRaw =
      params.minAmountOutRaw !== undefined && params.minAmountOutRaw !== ""
        ? BigInt(params.minAmountOutRaw)
        : parseUnits(params.minAmountOut ?? "0", outputTokenDecimals);
  } else {
    const sideADecimals =
      mode === "v2" ? (params.tokenADecimals ?? 18) : (params.token0Decimals ?? 18);
    const sideBDecimals =
      mode === "v2" ? (params.tokenBDecimals ?? 18) : (params.token1Decimals ?? 18);
    const sideAToken = mode === "v2" ? params.tokenA : params.token0;
    const sideBToken = mode === "v2" ? params.tokenB : params.token1;
    if (!sideAToken || !sideBToken) {
      throw new Error(
        `Auto-plan requires ${mode === "v2" ? "tokenA and tokenB" : "token0 and token1"} when swaps are omitted.`,
      );
    }

    const plan = await computeZapRemovePlan({
      userAddress,
      tokenA: sideAToken,
      tokenB: sideBToken,
      tokenADecimals: sideADecimals,
      tokenBDecimals: sideBDecimals,
      expectedAmountA: params.expectedAmountA,
      expectedAmountB: params.expectedAmountB,
      expectedAmountARaw: params.expectedAmountARaw,
      expectedAmountBRaw: params.expectedAmountBRaw,
      outputToken,
      outputTokenDecimals,
      slippagePercent,
      removeSlippagePercent,
    });

    mappedSwaps = plan.swaps.map((s) => ({
      feeOnTransfer: s.feeOnTransfer,
      amountIn: s.amountInRaw,
      amountOutMin: s.amountOutMinRaw,
      routes: s.routes,
    }));
    minAmountOutRaw =
      params.minAmountOutRaw !== undefined && params.minAmountOutRaw !== ""
        ? BigInt(params.minAmountOutRaw)
        : params.minAmountOut !== undefined
          ? parseUnits(params.minAmountOut, outputTokenDecimals)
          : plan.minAmountOutRaw;
    autoAmountAMinRaw = plan.amountAMinRaw;
    autoAmountBMinRaw = plan.amountBMinRaw;
  }

  if (mode === "v2") {
    const { tokenA, tokenB, stable, lpTokenAddress, liquidity, liquidityRaw: providedLiquidityRaw } = params;
    if (!tokenA || !tokenB || stable === undefined || !lpTokenAddress || (!liquidity && !providedLiquidityRaw)) {
      throw new Error(
        "For mode='v2' provide tokenA, tokenB, stable, lpTokenAddress, and liquidity or liquidityRaw.",
      );
    }
    const liquidityRaw = providedLiquidityRaw && providedLiquidityRaw !== ""
      ? BigInt(providedLiquidityRaw)
      : parseUnits(liquidity!, params.lpTokenDecimals ?? 18);
    const amount0MinRaw =
      params.amount0Min !== undefined
        ? parseUnits(params.amount0Min, params.amount0MinDecimals ?? params.tokenADecimals ?? 18)
        : (autoAmountAMinRaw ?? 0n);
    const amount1MinRaw =
      params.amount1Min !== undefined
        ? parseUnits(params.amount1Min, params.amount1MinDecimals ?? params.tokenBDecimals ?? 18)
        : (autoAmountBMinRaw ?? 0n);

    const zapParams = {
      tokenA,
      tokenB,
      stable,
      liquidity: liquidityRaw,
      amount0Min: amount0MinRaw,
      amount1Min: amount1MinRaw,
      outputToken,
      swaps: mappedSwaps,
      minAmountOut: minAmountOutRaw,
      unwrapWETH,
      deadline: BigInt(deadline),
      to,
    };

    const lpApproved = await hasSufficientAllowance(
      lpTokenAddress,
      userAddress,
      ROUTER_V2_ADDRESS,
      liquidityRaw,
    );

    const steps: Array<{
      title: string;
      description: string;
      waitForReceipt?: boolean;
      payload: { to: string; abi: any; functionName: string; args: any[]; value: string };
    }> = [];

    if (!lpApproved) {
      steps.push({
        title: "Approve LP token",
        description: "Approve router to spend LP tokens.",
        waitForReceipt: true,
        payload: {
          to: lpTokenAddress,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [ROUTER_V2_ADDRESS, liquidityRaw.toString()],
          value: "0",
        },
      });
    }

    steps.push({
      title: "Execute zapAndRemoveLiquidity",
      description: "Remove V2 liquidity and zap both sides into outputToken.",
      payload: {
        to: ROUTER_V2_ADDRESS,
        abi: ROUTER_V2_ABI,
        functionName: "zapAndRemoveLiquidity",
        args: [zapParams],
        value: "0",
      },
    });

    return {
      success: true,
      sequential: true,
      message: "Computed zapAndRemoveLiquidity transaction steps.",
      steps,
    };
  }

  if (params.tokenId === undefined || !params.liquidityRaw) {
    throw new Error("For mode='cl' provide tokenId and liquidityRaw (raw uint128).");
  }

  const amount0MinRawCL =
    params.amount0Min !== undefined
      ? parseUnits(params.amount0Min, params.amount0MinDecimals ?? params.token0Decimals ?? 18)
      : (autoAmountAMinRaw ?? 0n);
  const amount1MinRawCL =
    params.amount1Min !== undefined
      ? parseUnits(params.amount1Min, params.amount1MinDecimals ?? params.token1Decimals ?? 18)
      : (autoAmountBMinRaw ?? 0n);

  const zapParams = {
    tokenId: BigInt(params.tokenId),
    liquidity: BigInt(params.liquidityRaw),
    amount0Min: amount0MinRawCL,
    amount1Min: amount1MinRawCL,
    outputToken,
    swaps: mappedSwaps,
    minAmountOut: minAmountOutRaw,
    unwrapWETH,
    deadline: BigInt(deadline),
    to,
  };

  const clDeployer = await resolveDeployer(params.deployer, params.poolAddress);
  const clRouterAddress = getRouterV2ForDeployer(clDeployer);

  return {
    success: true,
    message: "Computed zapAndRemoveCL transaction steps.",
    sequential: true,
    steps: [
      {
        title: "Execute zapAndRemoveCL",
        description:
          "Decrease CL position liquidity and zap both sides into outputToken.",
        payload: {
          to: clRouterAddress,
          abi: ROUTER_V2_ABI,
          functionName: "zapAndRemoveCL",
          args: [zapParams],
          value: "0",
        },
      },
    ],
  };
}

export const zapRemoveLiquidityTool = {
  name: "zap_remove_liquidity_steps",
  description:
    "Returns router zapAndRemoveLiquidity (v2) or zapAndRemoveCL (CL) transaction steps that remove liquidity and swap both sides into a single outputToken. " +
    "On the first call (slippageConfirmed omitted or false) the tool returns a two-slippage confirmation request: " +
    "removeSlippagePercent (LP removal amountAMin/amountBMin) and slippagePercent (swap minAmountOut). " +
    "Present both values to the user and ask if they want to change either before re-calling with slippageConfirmed=true. " +
    "Steps must be executed sequentially — if an LP token approval step is present it must confirm before the zap transaction.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["v2", "cl"] },
      userAddress: { type: "string", description: "Optional. Wallet address. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      slippageConfirmed: { type: "boolean", description: "Set to true after the user confirms both slippage values. Defaults to false, which returns a confirmation prompt." },
      slippagePercent: { type: "number", description: `Swap slippage %: applied to each swap's amountOutMin and overall minAmountOut (default ${DEFAULT_SWAP_SLIPPAGE_PERCENT}%).` },
      removeSlippagePercent: { type: "number", description: `Remove slippage %: applied to amountAMin/amountBMin from LP token removal (default ${DEFAULT_REMOVE_SLIPPAGE_PERCENT}%).` },
      to: { type: "string", description: "Recipient of outputToken (defaults to userAddress)." },
      outputToken: { type: "string", description: "Target token to zap both sides into." },
      outputTokenDecimals: { type: "number", description: "Decimals for outputToken minAmountOut parsing (default 18)." },
      minAmountOut: { type: "string", description: "Human-readable min outputToken amount (default 0)." },
      minAmountOutRaw: { type: "string", description: "Raw min (BigInt string). Takes precedence over minAmountOut." },
      unwrapWETH: { type: "boolean", description: "Unwrap WAVAX to native AVAX for outputToken (default false)." },
      deadline: { type: "number", description: "Optional unix deadline." },
      swaps: {
        type: "array",
        items: { type: "object" },
        description:
          "Pre-built Zap.Swap[] routes. Each entry accepts either raw (amountInRaw, amountOutMinRaw) OR human (amountIn+amountInDecimals, amountOutMin+amountOutMinDecimals). Raw wins when both present. If omitted, MCP auto-builds swaps using expectedAmountA/expectedAmountB.",
      },
      expectedAmountA: { type: "string", description: "Human-readable expected tokenA/token0 output from LP removal (required for auto-plan)." },
      expectedAmountB: { type: "string", description: "Human-readable expected tokenB/token1 output from LP removal (required for auto-plan)." },
      expectedAmountARaw: { type: "string", description: "Raw expected tokenA/token0 output (takes precedence over expectedAmountA)." },
      expectedAmountBRaw: { type: "string", description: "Raw expected tokenB/token1 output (takes precedence over expectedAmountB)." },
      tokenA: { type: "string", description: "v2 token A." },
      tokenB: { type: "string", description: "v2 token B." },
      tokenADecimals: { type: "number" },
      tokenBDecimals: { type: "number" },
      stable: { type: "boolean", description: "v2 stable flag." },
      lpTokenAddress: { type: "string", description: "v2 LP token (for approval)." },
      lpTokenDecimals: { type: "number" },
      liquidity: { type: "string", description: "v2 human-readable LP amount. Ignored when liquidityRaw is provided." },
      amount0Min: { type: "string" },
      amount1Min: { type: "string" },
      amount0MinDecimals: { type: "number" },
      amount1MinDecimals: { type: "number" },
      tokenId: { type: "number", description: "CL position tokenId." },
      deployer: { type: "string", description: "Pool deployer address (mode='cl'). Pass when already known (from get_user_positions) to skip an extra lookup. Takes precedence over poolAddress." },
      poolAddress: { type: "string", description: "Pool address (mode='cl'). Used to resolve deployer when deployer is not known. Available from get_user_positions." },
      liquidityRaw: { type: "string", description: "Raw liquidity amount. For mode='v2': LP amount in wei (preferred for exact full-balance removes). For mode='cl': raw uint128 liquidity to decrease." },
      token0: { type: "string", description: "CL token0 (used for auto-plan)." },
      token1: { type: "string", description: "CL token1 (used for auto-plan)." },
      token0Decimals: { type: "number" },
      token1Decimals: { type: "number" },
    },
    required: ["mode", "outputToken"],
  },
};
