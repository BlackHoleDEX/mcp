import { addBribesTool } from "./skills/addBribes.js";
import { getDepositAmountsTool } from "./skills/depositAmounts.js";
import { addLiquidityTool } from "./skills/addLiquidity.js";
import { addLiquidityCLTool } from "./skills/addLiquidityCL.js";
import { createGaugeTool } from "./skills/createGauge.js";
import { createCLPoolTool } from "./skills/createPool.js";
import { claimEmissionsTool } from "./skills/claimEmissions.js";
import { claimFeesTool } from "./skills/claimFees.js";
import { claimRebaseTool } from "./skills/claimRebase.js";
import { claimVotingRewardsTool } from "./skills/claimVotingRewards.js";
import { claimVotingRewardsPayloadTool } from "./skills/claimVotingRewardsPayload.js";
import {
  advancedLockTool,
  createLockTool,
  increaseLockTool,
  mergeLockTool,
} from "./skills/locks.js";
import {
  clAprSimulatorTool,
  clPositionDetailTool,
  clPriceToTickTool,
  clTickToPriceTool,
} from "./skills/clCalc.js";
import { poolYieldTool } from "./skills/poolYield.js";
import { voteLeaderboardTool } from "./skills/voteLeaderboard.js";
import { estimateGasAndTxCostTool } from "./skills/estimateGasTxCost.js";
import { executeTransactionsTool } from "./skills/execute.js";
import { getEpochStateTool } from "./skills/epochState.js";
import { getTokenomicsTool } from "./skills/tokenomics.js";
import { getAllowancesTool } from "./skills/allowances.js";
import { getPoolStatusTool } from "./skills/poolStatus.js";
import { getOpportunitiesTool } from "./skills/riskFlags.js";
import {
  getTokenBalancesTool,
  getUserLocksTool,
  getUserPositionsTool,
  getWhitelistedTokensTool,
} from "./skills/portfolio.js";
import { getALMVaultsTool } from "./skills/almVaults.js";
import { getPoolLpProvidersTool } from "./skills/poolLpProviders.js";
import { quoteTool } from "./skills/quotes.js";
import { removeLiquidityTool } from "./skills/removeLiquidity.js";
import { resolveAddressTool } from "./skills/resolveAddress.js";
import { stakeLiquidityTool, unstakeLiquidityTool } from "./skills/stakeLiquidity.js";
import { swapTool } from "./skills/swap.js";
import { voteTool } from "./skills/vote.js";
import { getLockVoteStateTool } from "./skills/lockVoteState.js";
import { withdrawLiquidityTool } from "./skills/withdrawLiquidity.js";
import {
  zapAddLiquidityTool,
  zapIncreaseLiquidityTool,
  zapMintCLTool,
} from "./skills/zapLiquidity.js";
import { zapRemoveLiquidityTool } from "./skills/zapRemoveLiquidity.js";
import { zapSplitPlanTool } from "./skills/zapSplitPlan.js";
import { withMcpDebugOption } from "./toolSchemaMcpDebug.js";

const toolDefinitionsBase = [
  swapTool,
  quoteTool,
  poolYieldTool,
  getDepositAmountsTool,
  addLiquidityTool,
  addLiquidityCLTool,
  removeLiquidityTool,
  withdrawLiquidityTool,
  zapAddLiquidityTool,
  zapRemoveLiquidityTool,
  zapMintCLTool,
  zapIncreaseLiquidityTool,
  zapSplitPlanTool,
  stakeLiquidityTool,
  unstakeLiquidityTool,
  claimFeesTool,
  claimEmissionsTool,
  claimRebaseTool,
  claimVotingRewardsTool,
  claimVotingRewardsPayloadTool,
  createLockTool,
  increaseLockTool,
  mergeLockTool,
  advancedLockTool,
  voteTool,
  getLockVoteStateTool,
  voteLeaderboardTool,
  getEpochStateTool,
  getTokenomicsTool,
  createGaugeTool,
  addBribesTool,
  createCLPoolTool,
  resolveAddressTool,
  estimateGasAndTxCostTool,
  getTokenBalancesTool,
  getUserPositionsTool,
  getUserLocksTool,
  getWhitelistedTokensTool,
  getAllowancesTool,
  getPoolStatusTool,
  getOpportunitiesTool,
  clTickToPriceTool,
  clPriceToTickTool,
  clPositionDetailTool,
  clAprSimulatorTool,
  getALMVaultsTool,
  getPoolLpProvidersTool,
  executeTransactionsTool,
];

export const toolDefinitions = toolDefinitionsBase.map(withMcpDebugOption);
