import { encodeFunctionData, formatUnits, parseUnits } from "viem";

import {
  ERC20_ABI,
  NONFUNGIBLE_POSITION_MANAGER_ABI,
  ROUTER_V2_ABI,
  ROUTER_V2_ADDRESS,
} from "../constants/contracts.js";
import { hasSufficientAllowance } from "../utils/erc20.js";
import { getNFPMForDeployer } from "../utils/legacyContracts.js";
import { resolveDeployer } from "../utils/customPoolDeployer.js";
import { getEnvUserAddress } from "../utils/wallet.js";

type RemoveMode = "v2" | "cl";

const DEFAULT_REMOVE_SLIPPAGE_PERCENT = 1;

function applySlippage(rawAmount: bigint, slippagePercent: number): bigint {
  const clamped = Math.min(Math.max(slippagePercent, 0), 99.99);
  const bps = BigInt(Math.floor(clamped * 100));
  return (rawAmount * (10000n - bps)) / 10000n;
}

export interface RemoveLiquidityParams {
  mode: RemoveMode;
  slippagePercent?: number;
  slippageConfirmed?: boolean;

  // V2 fields
  lpTokenAddress?: string;
  tokenA?: string;
  tokenB?: string;
  stable?: boolean;
  liquidity?: string;
  // Optional raw LP amount (wei). Takes precedence over `liquidity`.
  liquidityRaw?: string;
  // Provide expected amounts to auto-compute mins from slippage, or provide amountAMin/B directly.
  expectedAmountA?: string;
  expectedAmountB?: string;
  amountAMin?: string;
  amountBMin?: string;
  lpTokenDecimals?: number;
  tokenADecimals?: number;
  tokenBDecimals?: number;
  userAddress?: string;

  // CL fields
  tokenId?: number;
  deployer?: string;
  poolAddress?: string;
  liquidityToRemove?: string;
  liquidityDecimals?: number;
  // Provide expected amounts to auto-compute mins from slippage, or provide amount0Min/1Min directly.
  expectedAmount0?: string;
  expectedAmount1?: string;
  amount0Min?: string;
  amount1Min?: string;
  token0Decimals?: number;
  token1Decimals?: number;
  burn?: boolean;

  deadline?: number;
}

export async function handleRemoveLiquiditySteps(params: RemoveLiquidityParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");

  const slippagePercent = params.slippagePercent ?? DEFAULT_REMOVE_SLIPPAGE_PERCENT;
  const slippageConfirmed = params.slippageConfirmed ?? false;
  const deadline = params.deadline ?? Math.floor(Date.now() / 1000) + 60 * 20;

  // Ask user to confirm slippage before building steps.
  if (!slippageConfirmed) {
    if (params.mode === "v2") {
      const tokenADecimals = params.tokenADecimals ?? 18;
      const tokenBDecimals = params.tokenBDecimals ?? 18;
      let amountAMinDisplay: string | undefined;
      let amountBMinDisplay: string | undefined;
      if (params.expectedAmountA) {
        const raw = applySlippage(parseUnits(params.expectedAmountA, tokenADecimals), slippagePercent);
        amountAMinDisplay = `${formatUnits(raw, tokenADecimals)} (${slippagePercent}% slippage on ${params.expectedAmountA})`;
      } else if (params.amountAMin) {
        amountAMinDisplay = params.amountAMin;
      }
      if (params.expectedAmountB) {
        const raw = applySlippage(parseUnits(params.expectedAmountB, tokenBDecimals), slippagePercent);
        amountBMinDisplay = `${formatUnits(raw, tokenBDecimals)} (${slippagePercent}% slippage on ${params.expectedAmountB})`;
      } else if (params.amountBMin) {
        amountBMinDisplay = params.amountBMin;
      }
      return {
        success: false,
        action_required: "confirm_slippage",
        message: [
          `Default slippage for remove liquidity is **${slippagePercent}%**.`,
          amountAMinDisplay ? `  • Minimum Token A you will receive: ${amountAMinDisplay}` : "",
          amountBMinDisplay ? `  • Minimum Token B you will receive: ${amountBMinDisplay}` : "",
          "Present this to the user and ask if they want to keep this slippage or change it. Once confirmed, re-call this tool with slippageConfirmed=true (and slippagePercent set to any updated value).",
        ].filter(Boolean).join("\n"),
        slippage: {
          slippage_percent: slippagePercent,
          amountAMin: amountAMinDisplay,
          amountBMin: amountBMinDisplay,
        },
      };
    }
    // CL
    const token0Decimals = params.token0Decimals ?? 18;
    const token1Decimals = params.token1Decimals ?? 18;
    let amount0MinDisplay: string | undefined;
    let amount1MinDisplay: string | undefined;
    if (params.expectedAmount0) {
      const raw = applySlippage(parseUnits(params.expectedAmount0, token0Decimals), slippagePercent);
      amount0MinDisplay = `${formatUnits(raw, token0Decimals)} (${slippagePercent}% slippage on ${params.expectedAmount0})`;
    } else if (params.amount0Min) {
      amount0MinDisplay = params.amount0Min;
    }
    if (params.expectedAmount1) {
      const raw = applySlippage(parseUnits(params.expectedAmount1, token1Decimals), slippagePercent);
      amount1MinDisplay = `${formatUnits(raw, token1Decimals)} (${slippagePercent}% slippage on ${params.expectedAmount1})`;
    } else if (params.amount1Min) {
      amount1MinDisplay = params.amount1Min;
    }
    return {
      success: false,
      action_required: "confirm_slippage",
      message: [
        `Default slippage for CL remove liquidity is **${slippagePercent}%**.`,
        amount0MinDisplay ? `  • Minimum Token 0 you will receive: ${amount0MinDisplay}` : "",
        amount1MinDisplay ? `  • Minimum Token 1 you will receive: ${amount1MinDisplay}` : "",
        "Present this to the user and ask if they want to keep this slippage or change it. Once confirmed, re-call this tool with slippageConfirmed=true (and slippagePercent set to any updated value).",
      ].filter(Boolean).join("\n"),
      slippage: {
        slippage_percent: slippagePercent,
        amount0Min: amount0MinDisplay,
        amount1Min: amount1MinDisplay,
      },
    };
  }

  if (params.mode === "v2") {
    if (
      !params.lpTokenAddress ||
      !params.tokenA ||
      !params.tokenB ||
      params.stable === undefined ||
      (!params.liquidity && !params.liquidityRaw)
    ) {
      throw new Error(
        "For mode='v2' provide lpTokenAddress, tokenA, tokenB, stable, and liquidity or liquidityRaw, plus either expectedAmountA/B or amountAMin/amountBMin.",
      );
    }

    const lpDecimals = params.lpTokenDecimals ?? 18;
    const tokenADecimals = params.tokenADecimals ?? 18;
    const tokenBDecimals = params.tokenBDecimals ?? 18;

    const liquidityRaw = params.liquidityRaw && params.liquidityRaw !== ""
      ? BigInt(params.liquidityRaw).toString()
      : parseUnits(params.liquidity!, lpDecimals).toString();
    const amountAMinRaw = params.expectedAmountA
      ? applySlippage(parseUnits(params.expectedAmountA, tokenADecimals), slippagePercent).toString()
      : parseUnits(params.amountAMin ?? "0", tokenADecimals).toString();
    const amountBMinRaw = params.expectedAmountB
      ? applySlippage(parseUnits(params.expectedAmountB, tokenBDecimals), slippagePercent).toString()
      : parseUnits(params.amountBMin ?? "0", tokenBDecimals).toString();

    const lpApproved = await hasSufficientAllowance(
      params.lpTokenAddress,
      userAddress,
      ROUTER_V2_ADDRESS,
      BigInt(liquidityRaw),
    );

    const steps = [];
    if (!lpApproved) {
      steps.push({
        title: "Approve LP Token",
        description: "Approve router to spend LP tokens for removal.",
        waitForReceipt: true,
        payload: {
          to: params.lpTokenAddress,
          abi: ERC20_ABI,
          functionName: "approve",
          args: [ROUTER_V2_ADDRESS, liquidityRaw],
          value: "0",
        },
      });
    }
    steps.push({
      title: "Execute Remove Liquidity",
      description: "Remove liquidity from v2 pair through router.",
      payload: {
        to: ROUTER_V2_ADDRESS,
        abi: ROUTER_V2_ABI,
        functionName: "removeLiquidity",
        args: [
          params.tokenA,
          params.tokenB,
          params.stable,
          liquidityRaw,
          amountAMinRaw,
          amountBMinRaw,
          userAddress,
          deadline,
        ],
        value: "0",
      },
    });

    return {
      success: true,
      sequential: true,
      message: "Computed v2 remove-liquidity steps.",
      steps,
    };
  }

  if (params.tokenId === undefined || !params.liquidityToRemove) {
    throw new Error(
      "For mode='cl' provide tokenId, liquidityToRemove, and either expectedAmount0/1 or amount0Min/amount1Min.",
    );
  }

  const deployer = await resolveDeployer(params.deployer, params.poolAddress);
  const nfpmAddress = getNFPMForDeployer(deployer);
  const liquidityDecimals = params.liquidityDecimals ?? 18;
  const token0Decimals = params.token0Decimals ?? 18;
  const token1Decimals = params.token1Decimals ?? 18;

  const liquidityRaw = parseUnits(
    params.liquidityToRemove,
    liquidityDecimals,
  ).toString();
  const amount0MinRaw = params.expectedAmount0
    ? applySlippage(parseUnits(params.expectedAmount0, token0Decimals), slippagePercent).toString()
    : parseUnits(params.amount0Min ?? "0", token0Decimals).toString();
  const amount1MinRaw = params.expectedAmount1
    ? applySlippage(parseUnits(params.expectedAmount1, token1Decimals), slippagePercent).toString()
    : parseUnits(params.amount1Min ?? "0", token1Decimals).toString();

  const decreaseCalldata = encodeFunctionData({
    abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
    functionName: "decreaseLiquidity",
    args: [
      {
        tokenId: BigInt(params.tokenId),
        liquidity: BigInt(liquidityRaw),
        amount0Min: BigInt(amount0MinRaw),
        amount1Min: BigInt(amount1MinRaw),
        deadline: BigInt(deadline),
      },
    ],
  });

  const amountMax = "340282366920938463463374607431768211455";
  const collectCalldata = encodeFunctionData({
    abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
    functionName: "collect",
    args: [
      {
        tokenId: BigInt(params.tokenId),
        recipient: userAddress as `0x${string}`,
        amount0Max: BigInt(amountMax),
        amount1Max: BigInt(amountMax),
      },
    ],
  });

  const multicallData = [decreaseCalldata, collectCalldata];
  if (params.burn) {
    const burnCalldata = encodeFunctionData({
      abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
      functionName: "burn",
      args: [BigInt(params.tokenId)],
    });
    multicallData.push(burnCalldata);
  }

  const steps = [
    {
      title: "Execute CL Remove Liquidity",
      description:
        params.burn
          ? "Decrease CL liquidity, collect tokens, and burn position NFT."
          : "Decrease CL liquidity and collect tokens.",
      payload: {
        to: nfpmAddress,
        abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
        functionName: "multicall",
        args: [multicallData],
        value: "0",
      },
    },
  ];

  return {
    success: true,
    sequential: true,
    message: "Computed CL remove-liquidity steps.",
    steps,
  };
}

export const removeLiquidityTool = {
  name: "remove_liquidity_steps",
  description:
    "Returns remove liquidity transaction steps for v2 pairs or CL positions. " +
    "On the first call (slippageConfirmed omitted or false) the tool returns a slippage confirmation " +
    "request — present the slippage details to the user and ask if they want to change it before " +
    "proceeding. Re-call with slippageConfirmed=true once the user confirms. " +
    "Steps must be executed sequentially — if an LP token approval step is present it must confirm before the remove transaction.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["v2", "cl"], description: "Choose remove mode: v2 pair or concentrated liquidity position." },
      slippagePercent: { type: "number", description: `Slippage tolerance % applied to minimum received amounts (default ${DEFAULT_REMOVE_SLIPPAGE_PERCENT}%).` },
      slippageConfirmed: { type: "boolean", description: "Set to true after the user has confirmed the slippage. On false (default) the tool returns a confirmation prompt instead of steps." },
      lpTokenAddress: { type: "string", description: "LP token/pair address (required for mode='v2')." },
      tokenA: { type: "string", description: "Token A address (required for mode='v2')." },
      tokenB: { type: "string", description: "Token B address (required for mode='v2')." },
      stable: { type: "boolean", description: "Stable pair flag (required for mode='v2')." },
      liquidity: { type: "string", description: "Human-readable LP amount to remove (mode='v2'). Ignored when liquidityRaw is provided." },
      liquidityRaw: { type: "string", description: "Raw LP amount (wei) to remove (mode='v2'). Preferred for exact full-balance removes; takes precedence over liquidity." },
      expectedAmountA: { type: "string", description: "Expected token A output from LP removal. Used with slippagePercent to auto-compute amountAMin." },
      expectedAmountB: { type: "string", description: "Expected token B output from LP removal. Used with slippagePercent to auto-compute amountBMin." },
      amountAMin: { type: "string", description: "Min token A amount. Overridden by expectedAmountA+slippagePercent when both present." },
      amountBMin: { type: "string", description: "Min token B amount. Overridden by expectedAmountB+slippagePercent when both present." },
      lpTokenDecimals: { type: "number", description: "LP token decimals (mode='v2', default 18)." },
      tokenADecimals: { type: "number", description: "Token A decimals (mode='v2', default 18)." },
      tokenBDecimals: { type: "number", description: "Token B decimals (mode='v2', default 18)." },
      tokenId: { type: "number", description: "Position NFT tokenId (required for mode='cl')." },
      deployer: { type: "string", description: "Pool deployer address (mode='cl'). Pass when already known (from get_user_positions) to skip an extra lookup. Takes precedence over poolAddress." },
      poolAddress: { type: "string", description: "Pool address (mode='cl'). Used to resolve deployer when deployer is not known. Available from get_user_positions." },
      liquidityToRemove: { type: "string", description: "Human-readable CL liquidity amount to remove (required for mode='cl')." },
      liquidityDecimals: { type: "number", description: "Liquidity decimals for parsing (mode='cl', default 18)." },
      expectedAmount0: { type: "string", description: "Expected token0 output from CL removal. Used with slippagePercent to auto-compute amount0Min." },
      expectedAmount1: { type: "string", description: "Expected token1 output from CL removal. Used with slippagePercent to auto-compute amount1Min." },
      amount0Min: { type: "string", description: "Min token0 amount. Overridden by expectedAmount0+slippagePercent when both present." },
      amount1Min: { type: "string", description: "Min token1 amount. Overridden by expectedAmount1+slippagePercent when both present." },
      token0Decimals: { type: "number", description: "Token0 decimals (mode='cl', default 18)." },
      token1Decimals: { type: "number", description: "Token1 decimals (mode='cl', default 18)." },
      burn: { type: "boolean", description: "Burn position NFT after collect (mode='cl', default false)." },
      userAddress: { type: "string", description: "Optional. Recipient address for withdrawn tokens. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      deadline: { type: "number", description: "Optional unix deadline. Defaults to now + 20 minutes." },
    },
    required: ["mode"],
  },
};
