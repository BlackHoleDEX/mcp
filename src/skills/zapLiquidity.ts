import { parseUnits } from "viem";

import {
  ERC20_ABI,
  ROUTER_V2_ABI,
  ROUTER_V2_ADDRESS,
} from "../constants/contracts.js";
import { getRouterV2ForDeployer } from "../utils/legacyContracts.js";
import { computeZapSplitPlan } from "../services/zapSplitPlanner.js";
import { resolveDeployerFromPool, resolveDeployer } from "../utils/customPoolDeployer.js";
import { hasSufficientAllowance } from "../utils/erc20.js";
import { isNativeAvaxToken, normalizeTokenAddress } from "../utils/nativeToken.js";
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
  // Accept either human-readable (amountIn + amountInDecimals) or raw (amountInRaw).
  // When both are present, raw wins. Same pattern for amountOutMin / amountOutMinRaw.
  amountIn?: string;
  amountInDecimals?: number;
  amountInRaw?: string;
  amountOutMin?: string;
  amountOutMinDecimals?: number;
  amountOutMinRaw?: string;
  routes: RouteStep[];
};

const DEFAULT_SLIPPAGE_PERCENT = 1;

function prepareInputs(
  inputTokens: string[],
  inputAmounts: string[],
  inputTokenDecimals?: number[],
  useNative?: boolean,
) {
  if (inputTokens.length === 0 || inputTokens.length !== inputAmounts.length) {
    throw new Error("inputTokens and inputAmounts must be non-empty and same length.");
  }

  const normalizedInputTokens = inputTokens.map(normalizeTokenAddress);
  const nativeIndices = inputTokens
    .map((token, index) => (isNativeAvaxToken(token) ? index : -1))
    .filter((index) => index >= 0);

  if (nativeIndices.length > 1) {
    throw new Error("Only one native AVAX input token is supported.");
  }
  if (nativeIndices.length > 0 && !useNative) {
    throw new Error("Set useNative=true when using native AVAX input.");
  }

  const amountsRaw = inputAmounts.map((amount, i) =>
    parseUnits(amount, inputTokenDecimals?.[i] ?? 18),
  );
  const nativeValue = nativeIndices.length === 1 ? amountsRaw[nativeIndices[0]!] : 0n;

  return { normalizedInputTokens, amountsRaw, nativeIndices, nativeValue };
}

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


export interface ZapAddLiquidityParams {
  tokenA: string;
  tokenB: string;
  stable: boolean;
  amountAMin?: string;
  amountAMinRaw?: string;
  amountBMin?: string;
  amountBMinRaw?: string;
  tokenADecimals?: number;
  tokenBDecimals?: number;
  inputTokens: string[];
  inputAmounts: string[];
  inputTokenDecimals?: number[];
  swaps?: ZapSwap[];
  poolAddress?: string;
  slippagePercent?: number;
  slippageConfirmed?: boolean;
  useNative?: boolean;
  deadline?: number;
  to?: string;
}

export async function handleZapAddLiquiditySteps(params: ZapAddLiquidityParams) {
  const {
    tokenA,
    tokenB,
    stable,
    amountAMin,
    amountBMin,
    tokenADecimals = 18,
    tokenBDecimals = 18,
    inputTokens,
    inputAmounts,
    inputTokenDecimals,
    swaps,
    poolAddress,
    slippagePercent = DEFAULT_SLIPPAGE_PERCENT,
    slippageConfirmed = false,
    useNative = false,
    deadline = Math.floor(Date.now() / 1000) + 60 * 20,
  } = params;

  const to = params.to ?? getEnvUserAddress();
  if (!to) throw new Error("Provide `to` or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");

  if (!slippageConfirmed) {
    return {
      success: false,
      action_required: "confirm_slippage",
      message: [
        `Default zap add liquidity slippage is **${slippagePercent}%**.`,
        "This applies to both the internal swap output minimums and the minimum pool token amounts deposited.",
        "Present this to the user and ask if they want to keep this slippage or change it. Once confirmed, re-call this tool with slippageConfirmed=true (and slippagePercent set to any updated value).",
      ].join("\n"),
      slippage: { slippage_percent: slippagePercent },
    };
  }

  const { normalizedInputTokens, amountsRaw, nativeIndices, nativeValue } = prepareInputs(
    inputTokens,
    inputAmounts,
    inputTokenDecimals,
    useNative,
  );

  const steps: Array<{
    title: string;
    description: string;
    waitForReceipt?: boolean;
    payload: { to: string; abi: any; functionName: string; args: any[]; value: string };
  }> = [];

  const approvalChecks = await Promise.all(
    normalizedInputTokens.map((token, i) =>
      nativeIndices.includes(i)
        ? Promise.resolve(true)
        : hasSufficientAllowance(token, to, ROUTER_V2_ADDRESS, amountsRaw[i]!),
    ),
  );

  normalizedInputTokens.forEach((token, i) => {
    if (nativeIndices.includes(i)) return;
    if (approvalChecks[i]) return;
    steps.push({
      title: `Approve Input Token ${i + 1}`,
      description: `Approve router to spend zap input token ${i + 1}.`,
      waitForReceipt: true,
      payload: {
        to: token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [ROUTER_V2_ADDRESS, amountsRaw[i]!.toString()],
        value: "0",
      },
    });
  });

  let effectiveAmountAMinRaw =
    params.amountAMinRaw !== undefined && params.amountAMinRaw !== ""
      ? BigInt(params.amountAMinRaw)
      : amountAMin
        ? parseUnits(amountAMin, tokenADecimals)
        : 0n;
  let effectiveAmountBMinRaw =
    params.amountBMinRaw !== undefined && params.amountBMinRaw !== ""
      ? BigInt(params.amountBMinRaw)
      : amountBMin
        ? parseUnits(amountBMin, tokenBDecimals)
        : 0n;
  let effectiveSwaps = swaps ? mapSwaps(swaps) : [];

  if (!swaps || swaps.length === 0) {
    if (normalizedInputTokens.length !== 1 || amountsRaw.length !== 1) {
      throw new Error("Automatic split planning currently supports exactly one input token. Provide swaps for multi-input zaps.");
    }
    if (!poolAddress) {
      throw new Error("poolAddress is required when swaps are omitted for automatic split planning.");
    }

    const autoPlan = await computeZapSplitPlan({
      poolType: "basic",
      poolAddress,
      tokenA,
      tokenB,
      inputToken: normalizedInputTokens[0]!,
      inputTokenDecimals: inputTokenDecimals?.[0] ?? 18,
      inputAmountRaw: amountsRaw[0]!,
      routeRecipient: to,
      slippagePercent,
    });

    effectiveAmountAMinRaw = autoPlan.amountAMinRaw;
    effectiveAmountBMinRaw = autoPlan.amountBMinRaw;
    effectiveSwaps = autoPlan.swaps.map((swap) => ({
      feeOnTransfer: swap.feeOnTransfer,
      amountIn: swap.amountInRaw,
      amountOutMin: swap.amountOutMinRaw,
      routes: swap.routes,
    }));
  }

  const zapParams = {
    tokenA,
    tokenB,
    stable,
    amountAMin: effectiveAmountAMinRaw,
    amountBMin: effectiveAmountBMinRaw,
    to,
    deadline,
    swaps: effectiveSwaps,
    usenative: useNative,
    inputTokens: normalizedInputTokens,
    amounts: amountsRaw,
  };

  steps.push({
    title: "Execute zapAndAddLiquidity",
    description: "Zap into both pool tokens and add basic liquidity in one call.",
    payload: {
      to: ROUTER_V2_ADDRESS,
      abi: ROUTER_V2_ABI,
      functionName: "zapAndAddLiquidity",
      args: [zapParams],
      value: nativeValue.toString(),
    },
  });

  return {
    success: true,
    sequential: true,
    message: "Computed zapAndAddLiquidity transaction steps. Note: LP tokens are NOT staked — use stake_liquidity_steps to earn emissions.",
    steps,
  };
}

export interface ZapIncreaseLiquidityParams {
  tokenId: number;
  deployer?: string;
  token0: string;
  token1: string;
  tickLower?: number;
  tickUpper?: number;
  amount0Min?: string;
  amount0MinRaw?: string;
  amount1Min?: string;
  amount1MinRaw?: string;
  token0Decimals?: number;
  token1Decimals?: number;
  inputTokens: string[];
  inputAmounts: string[];
  inputTokenDecimals?: number[];
  swaps?: ZapSwap[];
  poolAddress?: string;
  routeRecipient?: string;
  slippagePercent?: number;
  slippageConfirmed?: boolean;
  useNative?: boolean;
  deadline?: number;
  userAddress?: string;
}

export async function handleZapIncreaseLiquiditySteps(params: ZapIncreaseLiquidityParams) {
  const resolvedDeployer = await resolveDeployer(params.deployer, params.poolAddress);
  const increaseRouterAddress = getRouterV2ForDeployer(resolvedDeployer);
  const {
    tokenId,
    token0,
    token1,
    tickLower,
    tickUpper,
    amount0Min,
    amount1Min,
    token0Decimals = 18,
    token1Decimals = 18,
    inputTokens,
    inputAmounts,
    inputTokenDecimals,
    swaps,
    poolAddress,
    routeRecipient = increaseRouterAddress,
    slippagePercent = DEFAULT_SLIPPAGE_PERCENT,
    slippageConfirmed = false,
    useNative = false,
    deadline = Math.floor(Date.now() / 1000) + 60 * 20,
    userAddress,
  } = params;

  if (!slippageConfirmed) {
    return {
      success: false,
      action_required: "confirm_slippage",
      message: [
        `Default zap increase liquidity slippage is **${slippagePercent}%**.`,
        "This applies to both the internal swap output minimums and the minimum pool token amounts deposited.",
        "Present this to the user and ask if they want to keep this slippage or change it. Once confirmed, re-call this tool with slippageConfirmed=true (and slippagePercent set to any updated value).",
      ].join("\n"),
      slippage: { slippage_percent: slippagePercent },
    };
  }

  const { normalizedInputTokens, amountsRaw, nativeIndices, nativeValue } = prepareInputs(
    inputTokens,
    inputAmounts,
    inputTokenDecimals,
    useNative,
  );

  const steps: Array<{
    title: string;
    description: string;
    waitForReceipt?: boolean;
    payload: { to: string; abi: any; functionName: string; args: any[]; value: string };
  }> = [];

  const approvalChecks = userAddress
    ? await Promise.all(
        normalizedInputTokens.map((token, i) =>
          nativeIndices.includes(i)
            ? Promise.resolve(true)
            : hasSufficientAllowance(token, userAddress, increaseRouterAddress, amountsRaw[i]!),
        ),
      )
    : normalizedInputTokens.map((_, i) => nativeIndices.includes(i));

  normalizedInputTokens.forEach((token, i) => {
    if (nativeIndices.includes(i)) return;
    if (approvalChecks[i]) return;
    steps.push({
      title: `Approve Input Token ${i + 1}`,
      description: `Approve router to spend zap input token ${i + 1}.`,
      waitForReceipt: true,
      payload: {
        to: token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [increaseRouterAddress, amountsRaw[i]!.toString()],
        value: "0",
      },
    });
  });

  let effectiveAmount0MinRaw =
    params.amount0MinRaw !== undefined && params.amount0MinRaw !== ""
      ? BigInt(params.amount0MinRaw)
      : amount0Min
        ? parseUnits(amount0Min, token0Decimals)
        : 0n;
  let effectiveAmount1MinRaw =
    params.amount1MinRaw !== undefined && params.amount1MinRaw !== ""
      ? BigInt(params.amount1MinRaw)
      : amount1Min
        ? parseUnits(amount1Min, token1Decimals)
        : 0n;
  let effectiveSwaps = swaps ? mapSwaps(swaps) : [];

  if (!swaps || swaps.length === 0) {
    if (normalizedInputTokens.length !== 1 || amountsRaw.length !== 1) {
      throw new Error("Automatic split planning currently supports exactly one input token. Provide swaps for multi-input zaps.");
    }
    if (!poolAddress) {
      throw new Error("poolAddress is required when swaps are omitted for automatic split planning.");
    }
    if (!Number.isFinite(tickLower) || !Number.isFinite(tickUpper)) {
      throw new Error("tickLower and tickUpper are required for CL auto split when swaps are omitted.");
    }

    const autoPlan = await computeZapSplitPlan({
      poolType: "cl",
      poolAddress,
      tokenA: token0,
      tokenB: token1,
      inputToken: normalizedInputTokens[0]!,
      inputTokenDecimals: inputTokenDecimals?.[0] ?? 18,
      inputAmountRaw: amountsRaw[0]!,
      routeRecipient,
      tickLower,
      tickUpper,
      slippagePercent,
    });
    effectiveAmount0MinRaw = autoPlan.amountAMinRaw;
    effectiveAmount1MinRaw = autoPlan.amountBMinRaw;
    effectiveSwaps = autoPlan.swaps.map((swap) => ({
      feeOnTransfer: swap.feeOnTransfer,
      amountIn: swap.amountInRaw,
      amountOutMin: swap.amountOutMinRaw,
      routes: swap.routes,
    }));
  }

  const zapParams = {
    tokenId: BigInt(tokenId),
    token0,
    token1,
    amount0Min: effectiveAmount0MinRaw,
    amount1Min: effectiveAmount1MinRaw,
    deadline,
    swaps: effectiveSwaps,
    usenative: useNative,
    inputTokens: normalizedInputTokens,
    amounts: amountsRaw,
  };

  steps.push({
    title: "Execute zapAndIncreaseLiquidity",
    description: "Zap into required tokens and increase CL position liquidity.",
    payload: {
      to: increaseRouterAddress,
      abi: ROUTER_V2_ABI,
      functionName: "zapAndIncreaseLiquidity",
      args: [zapParams],
      value: nativeValue.toString(),
    },
  });

  return {
    success: true,
    sequential: true,
    message: "Computed zapAndIncreaseLiquidity transaction steps.",
    steps,
  };
}

export interface ZapMintCLParams {
  mode?: "mint" | "mintAndStake";
  token0: string;
  token1: string;
  deployer?: string;
  tickLower: number;
  tickUpper: number;
  amount0Min?: string;
  amount0MinRaw?: string;
  amount1Min?: string;
  amount1MinRaw?: string;
  token0Decimals?: number;
  token1Decimals?: number;
  recipient?: string;
  inputTokens: string[];
  inputAmounts: string[];
  inputTokenDecimals?: number[];
  swaps?: ZapSwap[];
  poolAddress?: string;
  slippagePercent?: number;
  slippageConfirmed?: boolean;
  useNative?: boolean;
  deadline?: number;
}

export async function handleZapMintCLSteps(params: ZapMintCLParams) {
  const {
    mode = "mint",
    token0,
    token1,
    tickLower,
    tickUpper,
    amount0Min,
    amount1Min,
    token0Decimals = 18,
    token1Decimals = 18,
    inputTokens,
    inputAmounts,
    inputTokenDecimals,
    swaps,
    poolAddress,
    slippagePercent = DEFAULT_SLIPPAGE_PERCENT,
    slippageConfirmed = false,
    useNative = false,
    deadline = Math.floor(Date.now() / 1000) + 60 * 20,
  } = params;

  const recipient = params.recipient ?? getEnvUserAddress();
  if (!recipient) throw new Error("Provide recipient or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");

  if (!slippageConfirmed) {
    return {
      success: false,
      action_required: "confirm_slippage",
      message: [
        `Default zap mint CL slippage is **${slippagePercent}%**.`,
        "This applies to both the internal swap output minimums and the minimum pool token amounts deposited.",
        "Present this to the user and ask if they want to keep this slippage or change it. Once confirmed, re-call this tool with slippageConfirmed=true (and slippagePercent set to any updated value).",
      ].join("\n"),
      slippage: { slippage_percent: slippagePercent },
    };
  }

  if (mode !== "mint" && mode !== "mintAndStake") {
    throw new Error('mode must be "mint" or "mintAndStake".');
  }

  let deployer = params.deployer;
  if (!deployer) {
    if (!poolAddress) {
      throw new Error("Provide either deployer or poolAddress (to auto-resolve deployer by tickSpacing).");
    }
    deployer = await resolveDeployerFromPool(poolAddress);
  }

  const mintRouterAddress = getRouterV2ForDeployer(deployer);

  const { normalizedInputTokens, amountsRaw, nativeIndices, nativeValue } = prepareInputs(
    inputTokens,
    inputAmounts,
    inputTokenDecimals,
    useNative,
  );

  const steps: Array<{
    title: string;
    description: string;
    waitForReceipt?: boolean;
    payload: { to: string; abi: any; functionName: string; args: any[]; value: string };
  }> = [];

  const approvalChecks = await Promise.all(
    normalizedInputTokens.map((token, i) =>
      nativeIndices.includes(i)
        ? Promise.resolve(true)
        : hasSufficientAllowance(token, recipient, mintRouterAddress, amountsRaw[i]!),
    ),
  );

  normalizedInputTokens.forEach((token, i) => {
    if (nativeIndices.includes(i)) return;
    if (approvalChecks[i]) return;
    steps.push({
      title: `Approve Input Token ${i + 1}`,
      description: `Approve router to spend zap input token ${i + 1}.`,
      waitForReceipt: true,
      payload: {
        to: token,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [mintRouterAddress, amountsRaw[i]!.toString()],
        value: "0",
      },
    });
  });

  let effectiveAmount0MinRaw =
    params.amount0MinRaw !== undefined && params.amount0MinRaw !== ""
      ? BigInt(params.amount0MinRaw)
      : amount0Min
        ? parseUnits(amount0Min, token0Decimals)
        : 0n;
  let effectiveAmount1MinRaw =
    params.amount1MinRaw !== undefined && params.amount1MinRaw !== ""
      ? BigInt(params.amount1MinRaw)
      : amount1Min
        ? parseUnits(amount1Min, token1Decimals)
        : 0n;
  let effectiveSwaps = swaps ? mapSwaps(swaps) : [];

  if (!swaps || swaps.length === 0) {
    if (normalizedInputTokens.length !== 1 || amountsRaw.length !== 1) {
      throw new Error("Automatic split planning currently supports exactly one input token. Provide swaps for multi-input zaps.");
    }
    if (!poolAddress) {
      throw new Error("poolAddress is required when swaps are omitted for automatic split planning.");
    }

    const autoPlan = await computeZapSplitPlan({
      poolType: "cl",
      poolAddress,
      tokenA: token0,
      tokenB: token1,
      inputToken: normalizedInputTokens[0]!,
      inputTokenDecimals: inputTokenDecimals?.[0] ?? 18,
      inputAmountRaw: amountsRaw[0]!,
      routeRecipient: recipient,
      tickLower,
      tickUpper,
      slippagePercent,
    });
    effectiveAmount0MinRaw = autoPlan.amountAMinRaw;
    effectiveAmount1MinRaw = autoPlan.amountBMinRaw;
    effectiveSwaps = autoPlan.swaps.map((swap) => ({
      feeOnTransfer: swap.feeOnTransfer,
      amountIn: swap.amountInRaw,
      amountOutMin: swap.amountOutMinRaw,
      routes: swap.routes,
    }));
  }

  const zapParams = {
    token0,
    token1,
    deployer,
    tickLower,
    tickUpper,
    amount0Min: effectiveAmount0MinRaw,
    amount1Min: effectiveAmount1MinRaw,
    recipient,
    deadline,
    swaps: effectiveSwaps,
    usenative: useNative,
    inputTokens: normalizedInputTokens,
    amounts: amountsRaw,
  };

  steps.push({
    title: mode === "mintAndStake" ? "Execute zapMintAndStakeCL" : "Execute zapAndMintCL",
    description:
      mode === "mintAndStake"
        ? "Zap input token(s), mint CL position, and stake in one call."
        : "Zap input token(s) and mint a new CL position.",
    payload: {
      to: mintRouterAddress,
      abi: ROUTER_V2_ABI,
      functionName: mode === "mintAndStake" ? "zapMintAndStakeCL" : "zapAndMintCL",
      args: [zapParams],
      value: nativeValue.toString(),
    },
  });

  return {
    success: true,
    sequential: true,
    message:
      mode === "mintAndStake"
        ? "Computed zapMintAndStakeCL transaction steps."
        : "Computed zapAndMintCL transaction steps. Note: position is NOT in farming — use stake_liquidity_steps to earn emissions.",
    steps,
  };
}

export const zapAddLiquidityTool = {
  name: "zap_add_liquidity_steps",
  description:
    "Returns zapAndAddLiquidity transaction steps for basic pools. If swaps are omitted, MCP auto-computes split + routes. Output from zap_split_plan can be forwarded as-is: set `swaps` to plan.swaps (each entry's amountInRaw/amountOutMinRaw fields are accepted directly), and optionally pass amountAMinRaw/amountBMinRaw from the plan. " +
    "IMPORTANT: This only mints LP tokens — it does NOT stake them. LP tokens must be staked via stake_liquidity_steps to earn BLACK emissions/APR. Unstaked LP only earns swap fees. " +
    "Steps must be executed sequentially — input token approval steps (if any) must confirm before the zap transaction.",
  inputSchema: {
    type: "object",
    properties: {
      tokenA: { type: "string" },
      tokenB: { type: "string" },
      stable: { type: "boolean" },
      amountAMin: { type: "string", description: "Human-readable min. Use amountAMinRaw instead when forwarding split-plan output." },
      amountAMinRaw: { type: "string", description: "Raw min (BigInt string). Takes precedence over amountAMin when both are given." },
      amountBMin: { type: "string", description: "Human-readable min. Use amountBMinRaw instead when forwarding split-plan output." },
      amountBMinRaw: { type: "string", description: "Raw min (BigInt string). Takes precedence over amountBMin when both are given." },
      tokenADecimals: { type: "number" },
      tokenBDecimals: { type: "number" },
      inputTokens: { type: "array", items: { type: "string" } },
      inputAmounts: { type: "array", items: { type: "string" } },
      inputTokenDecimals: { type: "array", items: { type: "number" } },
      swaps: {
        type: "array",
        items: { type: "object" },
        description:
          "Pre-built swap routes. Each entry accepts either raw (amountInRaw, amountOutMinRaw) OR human (amountIn+amountInDecimals, amountOutMin+amountOutMinDecimals). Raw wins when both are present. This matches the shape returned by zap_split_plan.",
      },
      poolAddress: { type: "string", description: "Pool address required for auto split when swaps are omitted." },
      slippagePercent: { type: "number", description: `Slippage % for swap output and pool deposit minimums (default ${DEFAULT_SLIPPAGE_PERCENT}%).` },
      slippageConfirmed: { type: "boolean", description: "Set to true after user confirms slippage. Defaults to false, returning a confirmation prompt." },
      useNative: { type: "boolean" },
      deadline: { type: "number" },
      to: { type: "string", description: "Optional. Recipient wallet for LP tokens. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
    },
    required: ["tokenA", "tokenB", "stable", "inputTokens", "inputAmounts"],
  },
};

export const zapMintCLTool = {
  name: "zap_mint_cl_steps",
  description:
    "Returns zapAndMintCL or zapMintAndStakeCL transaction steps for new CL positions. If swaps are omitted, MCP auto-computes split + routes. Output from zap_split_plan can be forwarded as-is: set `swaps` to plan.swaps (amountInRaw/amountOutMinRaw accepted directly), and optionally pass amount0MinRaw/amount1MinRaw from the plan. " +
    "IMPORTANT: mode='mint' only creates the position — it does NOT enter farming. Use mode='mintAndStake' to mint and enter farming in one call, or follow with stake_liquidity_steps. Unstaked CL positions earn swap fees only. " +
    "Steps must be executed sequentially — input token approval steps (if any) must confirm before the zap mint transaction.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["mint", "mintAndStake"], description: "mint => zapAndMintCL, mintAndStake => zapMintAndStakeCL." },
      token0: { type: "string" },
      token1: { type: "string" },
      deployer: { type: "string", description: "Optional. Auto-resolved from poolAddress via pool.tickSpacing() when omitted. Do NOT guess." },
      tickLower: { type: "number" },
      tickUpper: { type: "number" },
      amount0Min: { type: "string", description: "Human-readable min. Use amount0MinRaw instead when forwarding split-plan output." },
      amount0MinRaw: { type: "string", description: "Raw min (BigInt string). Takes precedence over amount0Min." },
      amount1Min: { type: "string", description: "Human-readable min. Use amount1MinRaw instead when forwarding split-plan output." },
      amount1MinRaw: { type: "string", description: "Raw min (BigInt string). Takes precedence over amount1Min." },
      token0Decimals: { type: "number" },
      token1Decimals: { type: "number" },
      recipient: { type: "string", description: "Optional. Recipient wallet for minted CL position. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      inputTokens: { type: "array", items: { type: "string" } },
      inputAmounts: { type: "array", items: { type: "string" } },
      inputTokenDecimals: { type: "array", items: { type: "number" } },
      swaps: {
        type: "array",
        items: { type: "object" },
        description:
          "Pre-built swap routes. Each entry accepts either raw (amountInRaw, amountOutMinRaw) OR human (amountIn+amountInDecimals, amountOutMin+amountOutMinDecimals). Raw wins when both present. Matches zap_split_plan output shape.",
      },
      poolAddress: { type: "string", description: "CL pool address. Required for auto split and to auto-resolve deployer when omitted." },
      slippagePercent: { type: "number", description: `Slippage % for swap output and pool deposit minimums (default ${DEFAULT_SLIPPAGE_PERCENT}%).` },
      slippageConfirmed: { type: "boolean", description: "Set to true after user confirms slippage. Defaults to false, returning a confirmation prompt." },
      useNative: { type: "boolean" },
      deadline: { type: "number" },
    },
    required: ["token0", "token1", "tickLower", "tickUpper", "inputTokens", "inputAmounts"],
  },
};

export const zapIncreaseLiquidityTool = {
  name: "zap_increase_liquidity_steps",
  description:
    "Returns zapAndIncreaseLiquidity steps for existing CL positions only. If swaps are omitted, MCP auto-computes split + routes. Output from zap_split_plan can be forwarded as-is: set `swaps` to plan.swaps (amountInRaw/amountOutMinRaw accepted directly), and optionally pass amount0MinRaw/amount1MinRaw from the plan. " +
    "Steps must be executed sequentially — input token approval steps (if any) must confirm before the zap increase transaction.",
  inputSchema: {
    type: "object",
    properties: {
      tokenId: { type: "number" },
      deployer: { type: "string", description: "Pool deployer address. Pass when already known (from get_user_positions) to skip an extra lookup. Takes precedence over poolAddress." },
      token0: { type: "string" },
      token1: { type: "string" },
      tickLower: { type: "number", description: "Required for auto split when swaps are omitted." },
      tickUpper: { type: "number", description: "Required for auto split when swaps are omitted." },
      amount0Min: { type: "string", description: "Human-readable min. Use amount0MinRaw when forwarding split-plan output." },
      amount0MinRaw: { type: "string", description: "Raw min (BigInt string). Takes precedence over amount0Min." },
      amount1Min: { type: "string", description: "Human-readable min. Use amount1MinRaw when forwarding split-plan output." },
      amount1MinRaw: { type: "string", description: "Raw min (BigInt string). Takes precedence over amount1Min." },
      token0Decimals: { type: "number" },
      token1Decimals: { type: "number" },
      inputTokens: { type: "array", items: { type: "string" } },
      inputAmounts: { type: "array", items: { type: "string" } },
      inputTokenDecimals: { type: "array", items: { type: "number" } },
      swaps: {
        type: "array",
        items: { type: "object" },
        description:
          "Pre-built swap routes. Each entry accepts either raw (amountInRaw, amountOutMinRaw) OR human (amountIn+amountInDecimals, amountOutMin+amountOutMinDecimals). Raw wins when both present. Matches zap_split_plan output shape.",
      },
      poolAddress: { type: "string", description: "CL pool address required for auto split when swaps are omitted." },
      routeRecipient: { type: "string", description: "Optional address used as route receiver context for auto route search." },
      slippagePercent: { type: "number", description: `Slippage % for swap output and pool deposit minimums (default ${DEFAULT_SLIPPAGE_PERCENT}%).` },
      slippageConfirmed: { type: "boolean", description: "Set to true after user confirms slippage. Defaults to false, returning a confirmation prompt." },
      useNative: { type: "boolean" },
      deadline: { type: "number" },
      userAddress: { type: "string", description: "Optional signer address; when provided, already-sufficient approvals are skipped." },
    },
    required: ["tokenId", "token0", "token1", "inputTokens", "inputAmounts"],
  },
};
