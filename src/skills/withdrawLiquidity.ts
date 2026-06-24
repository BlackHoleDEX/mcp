import { handleRemoveLiquiditySteps } from "./removeLiquidity.js";
import {
  handleUnstakeLiquiditySteps,
  type StakeLiquidityParams,
} from "./stakeLiquidity.js";
import { getEnvUserAddress } from "../utils/wallet.js";

export interface WithdrawLiquidityParams {
  mode: "v2" | "cl";
  userAddress?: string;
  poolAddress?: string;
  gaugeAddress?: string;
  gaugeManagerAddress?: string;
  skipUnstake?: boolean;
  slippagePercent?: number;
  slippageConfirmed?: boolean;

  // v2
  lpTokenAddress?: string;
  tokenA?: string;
  tokenB?: string;
  stable?: boolean;
  liquidity?: string;
  liquidityRaw?: string;
  lpTokenDecimals?: number;
  tokenADecimals?: number;
  tokenBDecimals?: number;
  expectedAmountA?: string;
  expectedAmountB?: string;
  amountAMin?: string;
  amountBMin?: string;

  // cl
  tokenId?: number;
  deployer?: string;
  liquidityToRemove?: string;
  liquidityDecimals?: number;
  expectedAmount0?: string;
  expectedAmount1?: string;
  amount0Min?: string;
  amount1Min?: string;
  token0Decimals?: number;
  token1Decimals?: number;
  burn?: boolean;

  deadline?: number;
}

export async function handleWithdrawLiquiditySteps(params: WithdrawLiquidityParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");

  const { mode, skipUnstake = false } = params;

  const steps: any[] = [];

  if (!skipUnstake) {
    const unstakeParams: StakeLiquidityParams = {
      mode,
      userAddress,
      deployer: params.deployer,
      poolAddress: params.poolAddress,
      gaugeAddress: params.gaugeAddress,
      gaugeManagerAddress: params.gaugeManagerAddress,
      tokenId: params.tokenId,
    };
    try {
      const unstakeResult = await handleUnstakeLiquiditySteps(unstakeParams);
      steps.push(...unstakeResult.steps);
    } catch (err: any) {
      if (!params.gaugeAddress && !params.poolAddress) {
        throw new Error(
          "Provide poolAddress or gaugeAddress for unstake step, or pass skipUnstake=true if position is already unstaked.",
        );
      }
      throw err;
    }
  }

  const removeResult = await handleRemoveLiquiditySteps({
    mode,
    userAddress,
    slippagePercent: params.slippagePercent,
    slippageConfirmed: params.slippageConfirmed,
    lpTokenAddress: params.lpTokenAddress,
    tokenA: params.tokenA,
    tokenB: params.tokenB,
    stable: params.stable,
    liquidity: params.liquidity,
    liquidityRaw: params.liquidityRaw,
    expectedAmountA: params.expectedAmountA,
    expectedAmountB: params.expectedAmountB,
    amountAMin: params.amountAMin,
    amountBMin: params.amountBMin,
    lpTokenDecimals: params.lpTokenDecimals,
    tokenADecimals: params.tokenADecimals,
    tokenBDecimals: params.tokenBDecimals,
    tokenId: params.tokenId,
    deployer: params.deployer,
    poolAddress: params.poolAddress,
    liquidityToRemove: params.liquidityToRemove,
    liquidityDecimals: params.liquidityDecimals,
    expectedAmount0: params.expectedAmount0,
    expectedAmount1: params.expectedAmount1,
    amount0Min: params.amount0Min,
    amount1Min: params.amount1Min,
    token0Decimals: params.token0Decimals,
    token1Decimals: params.token1Decimals,
    burn: params.burn,
    deadline: params.deadline,
  });

  if (!removeResult.success || !("steps" in removeResult)) {
    return removeResult;
  }

  steps.push(...(removeResult as { steps: any[] }).steps);

  return {
    success: true,
    sequential: true,
    message: `Computed ${mode.toUpperCase()} withdraw (unstake + remove) transaction steps.`,
    steps,
  };
}

export const withdrawLiquidityTool = {
  name: "withdraw_liquidity_steps",
  description:
    "Returns combined unstake + remove-liquidity transaction steps. Handles all cases automatically: " +
    "V2 (withdrawAll from gauge → removeLiquidity via router), " +
    "CL legacy (exitFarming on legacy farming center → decreaseLiquidity + collect on legacy NFPM), " +
    "CL new deployer (exitFarming on new farming center → decreaseLiquidity + collect on new NFPM). " +
    "Pass deployer from get_user_positions to route to the correct contracts. " +
    "Use skipUnstake=true if the position is already unstaked or not in farming. " +
    "On the first call (slippageConfirmed omitted or false) returns a slippage confirmation prompt — present the slippage to the user and re-call with slippageConfirmed=true once confirmed. " +
    "Steps must be executed sequentially — unstake must confirm before LP token approval, and approval must confirm before the remove transaction.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["v2", "cl"] },
      userAddress: { type: "string", description: "Optional. Wallet address. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      poolAddress: { type: "string", description: "Used to resolve gauge for unstake when gaugeAddress is omitted." },
      gaugeAddress: { type: "string", description: "Explicit gauge address (optional)." },
      gaugeManagerAddress: { type: "string", description: "Optional gaugeManager override for gauge resolution." },
      skipUnstake: { type: "boolean", description: "Skip the unstake step (default false)." },
      slippagePercent: { type: "number", description: "Slippage % for minimum received amounts (default 0.5%)." },
      slippageConfirmed: { type: "boolean", description: "Set to true after the user confirms slippage. Defaults to false, returning a confirmation prompt." },
      lpTokenAddress: { type: "string", description: "v2 LP token address." },
      tokenA: { type: "string", description: "v2 token A address." },
      tokenB: { type: "string", description: "v2 token B address." },
      stable: { type: "boolean", description: "v2 stable flag." },
      liquidity: { type: "string", description: "v2 human-readable LP amount to remove. Ignored when liquidityRaw is provided." },
      liquidityRaw: { type: "string", description: "v2 raw LP amount (wei) to remove. Preferred for exact full-balance removes." },
      lpTokenDecimals: { type: "number" },
      tokenADecimals: { type: "number" },
      tokenBDecimals: { type: "number" },
      expectedAmountA: { type: "string", description: "Expected token A output used with slippagePercent to auto-compute amountAMin." },
      expectedAmountB: { type: "string", description: "Expected token B output used with slippagePercent to auto-compute amountBMin." },
      amountAMin: { type: "string" },
      amountBMin: { type: "string" },
      deployer: { type: "string", description: "Pool deployer address (mode='cl'). Pass when known (from get_user_positions) to ensure the correct NFPM and pool API are used for legacy vs current positions." },
      tokenId: { type: "number", description: "CL position tokenId (also used to unstake CL)." },
      liquidityToRemove: { type: "string", description: "CL human-readable liquidity to remove." },
      liquidityDecimals: { type: "number" },
      expectedAmount0: { type: "string", description: "Expected token0 output used with slippagePercent to auto-compute amount0Min." },
      expectedAmount1: { type: "string", description: "Expected token1 output used with slippagePercent to auto-compute amount1Min." },
      amount0Min: { type: "string" },
      amount1Min: { type: "string" },
      token0Decimals: { type: "number" },
      token1Decimals: { type: "number" },
      burn: { type: "boolean", description: "Burn CL position NFT after removal (default false)." },
      deadline: { type: "number" },
    },
    required: ["mode"],
  },
};
