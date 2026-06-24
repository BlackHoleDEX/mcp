import { encodeFunctionData, formatUnits, parseUnits } from "viem";

import {
  ERC20_ABI,
  NONFUNGIBLE_POSITION_MANAGER_ABI,
  ROUTER_V2_ABI,
} from "../constants/contracts.js";
import { resolveDeployerFromPool } from "../utils/customPoolDeployer.js";
import { getNFPMForDeployer, getRouterV2ForDeployer } from "../utils/legacyContracts.js";
import { hasSufficientAllowance } from "../utils/erc20.js";
import { getEnvUserAddress } from "../utils/wallet.js";
import { isNativeAvaxToken, normalizeTokenAddress } from "../utils/nativeToken.js";

type CLMode = "mint" | "mintAndStake";

const DEFAULT_ADD_SLIPPAGE_PERCENT = 1;

function applySlippage(rawAmount: bigint, slippagePercent: number): bigint {
  const clamped = Math.min(Math.max(slippagePercent, 0), 99.99);
  const bps = BigInt(Math.floor(clamped * 100));
  return (rawAmount * (10000n - bps)) / 10000n;
}

export interface AddLiquidityCLParams {
  mode: CLMode;
  token0: string;
  token1: string;
  deployer?: string;
  poolAddress?: string;
  tickLower: number;
  tickUpper: number;
  amount0Desired: string;
  amount1Desired: string;
  amount0Min?: string;
  amount1Min?: string;
  slippagePercent?: number;
  slippageConfirmed?: boolean;
  recipient?: string;
  deadline?: number;
  token0Decimals?: number;
  token1Decimals?: number;
}

type MintLikeParams = {
  token0: `0x${string}`;
  token1: `0x${string}`;
  deployer: `0x${string}` | string;
  tickLower: number;
  tickUpper: number;
  amount0Desired: string;
  amount1Desired: string;
  amount0Min: string;
  amount1Min: string;
  recipient: `0x${string}`;
  deadline: number;
};

function normalizeMintParams(params: MintLikeParams): MintLikeParams {
  const isOriginalOrder = params.token0.toLowerCase() < params.token1.toLowerCase();
  if (isOriginalOrder) return params;

  return {
    ...params,
    token0: params.token1,
    token1: params.token0,
    amount0Desired: params.amount1Desired,
    amount1Desired: params.amount0Desired,
    amount0Min: params.amount1Min,
    amount1Min: params.amount0Min,
  };
}

export async function handleAddLiquidityCLSteps(params: AddLiquidityCLParams) {
  const {
    mode,
    token0,
    token1,
    poolAddress,
    tickLower,
    tickUpper,
    amount0Desired,
    amount1Desired,
    deadline = Math.floor(Date.now() / 1000) + 60 * 20,
    token0Decimals = 18,
    token1Decimals = 18,
    slippagePercent = DEFAULT_ADD_SLIPPAGE_PERCENT,
    slippageConfirmed = false,
  } = params;

  const recipient = params.recipient ?? getEnvUserAddress();
  if (!recipient) throw new Error("Provide recipient or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");

  const desired0Raw = parseUnits(amount0Desired, token0Decimals);
  const desired1Raw = parseUnits(amount1Desired, token1Decimals);
  const computed0MinRaw = applySlippage(desired0Raw, slippagePercent);
  const computed1MinRaw = applySlippage(desired1Raw, slippagePercent);

  if (!slippageConfirmed) {
    return {
      success: false,
      action_required: "confirm_slippage",
      message: [
        `Default CL add liquidity slippage is **${slippagePercent}%**.`,
        `  • Minimum Token 0 you will deposit: ${formatUnits(computed0MinRaw, token0Decimals)} (${slippagePercent}% slippage on ${amount0Desired})`,
        `  • Minimum Token 1 you will deposit: ${formatUnits(computed1MinRaw, token1Decimals)} (${slippagePercent}% slippage on ${amount1Desired})`,
        "Present this to the user and ask if they want to keep this slippage or change it. Once confirmed, re-call this tool with slippageConfirmed=true (and slippagePercent set to any updated value).",
      ].join("\n"),
      slippage: {
        slippage_percent: slippagePercent,
        amount0Min: formatUnits(computed0MinRaw, token0Decimals),
        amount1Min: formatUnits(computed1MinRaw, token1Decimals),
      },
    };
  }

  if (mode !== "mint" && mode !== "mintAndStake") {
    throw new Error(`Unsupported mode "${mode}". Use "mint" or "mintAndStake".`);
  }

  let deployer = params.deployer;
  if (!deployer) {
    if (!poolAddress) {
      throw new Error("Provide either deployer or poolAddress (to auto-resolve deployer by tickSpacing).");
    }
    deployer = await resolveDeployerFromPool(poolAddress);
  }

  const isToken0Native = isNativeAvaxToken(token0);
  const isToken1Native = isNativeAvaxToken(token1);
  if (isToken0Native && isToken1Native) {
    throw new Error("Only one side can be native AVAX.");
  }
  if (mode === "mintAndStake" && (isToken0Native || isToken1Native)) {
    throw new Error('Native AVAX is currently supported only for mode "mint".');
  }

  const effectiveToken0 = normalizeTokenAddress(token0);
  const effectiveToken1 = normalizeTokenAddress(token1);

  const min0Raw = params.amount0Min
    ? parseUnits(params.amount0Min, token0Decimals).toString()
    : computed0MinRaw.toString();
  const min1Raw = params.amount1Min
    ? parseUnits(params.amount1Min, token1Decimals).toString()
    : computed1MinRaw.toString();

  const mintParams = normalizeMintParams({
    token0: effectiveToken0 as `0x${string}`,
    token1: effectiveToken1 as `0x${string}`,
    deployer: deployer as `0x${string}`,
    tickLower,
    tickUpper,
    amount0Desired: desired0Raw.toString(),
    amount1Desired: desired1Raw.toString(),
    amount0Min: min0Raw,
    amount1Min: min1Raw,
    recipient: recipient as `0x${string}`,
    deadline,
  });

  const routerAddress = getRouterV2ForDeployer(deployer);
  const nfpmAddress = getNFPMForDeployer(deployer);

  const spender = mode === "mintAndStake" ? routerAddress : nfpmAddress;

  const steps: Array<{
    title: string;
    description: string;
    waitForReceipt?: boolean;
    payload: {
      to: string;
      abi: any;
      functionName: string;
      args: any[];
      value: string;
    };
  }> = [];

  const [hasAllowance0, hasAllowance1] = await Promise.all([
    isToken0Native
      ? Promise.resolve(true)
      : hasSufficientAllowance(token0, recipient, spender, desired0Raw),
    isToken1Native
      ? Promise.resolve(true)
      : hasSufficientAllowance(token1, recipient, spender, desired1Raw),
  ]);

  if (!isToken0Native && !hasAllowance0) {
    steps.push({
      title: "Approve Token 0",
      description: `Approve spender to use ${amount0Desired} of token0.`,
      waitForReceipt: true,
      payload: {
        to: token0,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [spender, desired0Raw.toString()],
        value: "0",
      },
    });
  }

  if (!isToken1Native && !hasAllowance1) {
    steps.push({
      title: "Approve Token 1",
      description: `Approve spender to use ${amount1Desired} of token1.`,
      waitForReceipt: true,
      payload: {
        to: token1,
        abi: ERC20_ABI,
        functionName: "approve",
        args: [spender, desired1Raw.toString()],
        value: "0",
      },
    });
  }

  if (mode === "mintAndStake") {
    steps.push({
      title: "Execute mintAndStake",
      description: "Mint CL position and stake in one router transaction.",
      payload: {
        to: routerAddress,
        abi: ROUTER_V2_ABI,
        functionName: "mintCLAndStake",
        args: [mintParams],
        value: "0",
      },
    });
  } else {
    const mintCalldata = encodeFunctionData({
      abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
      functionName: "mint",
      args: [mintParams],
    });
    const multicallData = [mintCalldata];
    let txValue = "0";

    if (isToken0Native || isToken1Native) {
      const refundCalldata = encodeFunctionData({
        abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
        functionName: "refundNativeToken",
        args: [],
      });
      multicallData.push(refundCalldata);
      txValue = isToken0Native ? desired0Raw.toString() : desired1Raw.toString();
    }

    steps.push({
      title: "Execute mint",
      description:
        isToken0Native || isToken1Native
          ? "Mint CL position with native AVAX and refund unused AVAX."
          : "Mint CL position via position manager multicall.",
      payload: {
        to: nfpmAddress,
        abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
        functionName: "multicall",
        args: [multicallData],
        value: txValue,
      },
    });
  }

  return {
    success: true,
    sequential: true,
    message: `Computed CL add-liquidity steps using "${mode}" mode.`,
    steps,
  };
}

export const addLiquidityCLTool = {
  name: "add_liquidity_cl_steps",
  description:
    "Returns CL liquidity transaction steps with two modes: mint or mintAndStake. " +
    `On the first call (slippageConfirmed omitted or false) returns a slippage confirmation prompt at the default ${DEFAULT_ADD_SLIPPAGE_PERCENT}% slippage. ` +
    "Present this to the user and ask if they want to change it. Re-call with slippageConfirmed=true once confirmed. " +
    "Steps must be executed sequentially — approval steps (if any) must confirm before the mint transaction.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["mint", "mintAndStake"], description: "Choose exactly one mode: mint or mintAndStake." },
      token0: { type: "string", description: "Address of token0. Use '0xavax' for native AVAX in mode='mint'." },
      token1: { type: "string", description: "Address of token1. Use '0xavax' for native AVAX in mode='mint'." },
      deployer: { type: "string", description: "Optional. Auto-resolved from poolAddress via pool.tickSpacing() when omitted. Do NOT guess." },
      poolAddress: { type: "string", description: "CL pool address. Required when deployer is omitted, so the server can auto-resolve deployer by tickSpacing." },
      tickLower: { type: "number", description: "Lower tick for the CL position." },
      tickUpper: { type: "number", description: "Upper tick for the CL position." },
      amount0Desired: { type: "string", description: "Desired human-readable amount for token0." },
      amount1Desired: { type: "string", description: "Desired human-readable amount for token1." },
      slippagePercent: { type: "number", description: `Slippage % for amount0Min/amount1Min (default ${DEFAULT_ADD_SLIPPAGE_PERCENT}%).` },
      slippageConfirmed: { type: "boolean", description: "Set to true after user confirms slippage. Defaults to false, returning a confirmation prompt." },
      amount0Min: { type: "string", description: "Override: minimum human-readable amount for token0. When omitted, computed from amount0Desired × (1 - slippage%)." },
      amount1Min: { type: "string", description: "Override: minimum human-readable amount for token1. When omitted, computed from amount1Desired × (1 - slippage%)." },
      recipient: { type: "string", description: "Optional. Recipient wallet for minted position. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      deadline: { type: "number", description: "Optional unix deadline. Defaults to now + 20 minutes." },
      token0Decimals: { type: "number", description: "Token0 decimals (defaults to 18)." },
      token1Decimals: { type: "number", description: "Token1 decimals (defaults to 18)." },
    },
    required: ["mode", "token0", "token1", "tickLower", "tickUpper", "amount0Desired", "amount1Desired"],
  },
};
