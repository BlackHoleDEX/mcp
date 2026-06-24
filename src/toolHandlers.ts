import { handleAddBribesSteps } from "./skills/addBribes.js";
import { handleGetDepositAmounts } from "./skills/depositAmounts.js";
import { handleAddLiquiditySteps } from "./skills/addLiquidity.js";
import { handleAddLiquidityCLSteps } from "./skills/addLiquidityCL.js";
import { handleClaimEmissionsSteps } from "./skills/claimEmissions.js";
import { handleClaimFeesSteps } from "./skills/claimFees.js";
import { handleClaimRebaseSteps } from "./skills/claimRebase.js";
import { handleClaimVotingRewardsSteps } from "./skills/claimVotingRewards.js";
import { handleClaimVotingRewardsPayload } from "./skills/claimVotingRewardsPayload.js";
import { handleCreateGaugeSteps } from "./skills/createGauge.js";
import { handleCreateCLPoolSteps } from "./skills/createPool.js";
import {
  handleAdvancedLockSteps,
  handleCreateLockSteps,
  handleIncreaseLockSteps,
  handleMergeLockSteps,
} from "./skills/locks.js";
import { handlePoolYield } from "./skills/poolYield.js";
import { handleQuote } from "./skills/quotes.js";
import { handleRemoveLiquiditySteps } from "./skills/removeLiquidity.js";
import { handleResolveAddress } from "./skills/resolveAddress.js";
import {
  handleStakeLiquiditySteps,
  handleUnstakeLiquiditySteps,
} from "./skills/stakeLiquidity.js";
import { handleSwapSteps } from "./skills/swap.js";
import { handleWithdrawLiquiditySteps } from "./skills/withdrawLiquidity.js";
import { handleZapRemoveLiquiditySteps } from "./skills/zapRemoveLiquidity.js";
import { handleVoteSteps } from "./skills/vote.js";
import { handleGetLockVoteState } from "./skills/lockVoteState.js";
import { handleVoteLeaderboard } from "./skills/voteLeaderboard.js";
import { handleEstimateGasAndTxCost } from "./skills/estimateGasTxCost.js";
import { handleExecuteTransactions } from "./skills/execute.js";
import { handleGetEpochState } from "./skills/epochState.js";
import { handleGetTokenomics } from "./skills/tokenomics.js";
import { handleGetAllowances } from "./skills/allowances.js";
import { handleGetPoolStatus } from "./skills/poolStatus.js";
import { handleGetOpportunities } from "./skills/riskFlags.js";
import {
  handleZapAddLiquiditySteps,
  handleZapIncreaseLiquiditySteps,
  handleZapMintCLSteps,
} from "./skills/zapLiquidity.js";
import { handleZapSplitPlan } from "./skills/zapSplitPlan.js";
import {
  handleGetTokenBalances,
  handleGetUserPositions,
  handleGetUserLocks,
  handleGetWhitelistedTokens,
} from "./skills/portfolio.js";
import { handleGetALMVaults } from "./skills/almVaults.js";
import { handleGetPoolLpProviders } from "./skills/poolLpProviders.js";
import {
  handleTickToPrice,
  handlePriceToTick,
  handlePositionDetail,
  handleAprSimulator,
} from "./skills/clCalc.js";

type Handler = (args: any) => any | Promise<any>;

export const toolHandlers: Record<string, Handler> = {
  swap_steps: handleSwapSteps,
  quote: handleQuote,
  pool_yield: handlePoolYield,
  add_liquidity_steps: handleAddLiquiditySteps,
  add_liquidity_cl_steps: handleAddLiquidityCLSteps,
  remove_liquidity_steps: handleRemoveLiquiditySteps,
  withdraw_liquidity_steps: handleWithdrawLiquiditySteps,
  zap_add_liquidity_steps: handleZapAddLiquiditySteps,
  zap_remove_liquidity_steps: handleZapRemoveLiquiditySteps,
  zap_mint_cl_steps: handleZapMintCLSteps,
  zap_increase_liquidity_steps: handleZapIncreaseLiquiditySteps,
  zap_split_plan: handleZapSplitPlan,
  stake_liquidity_steps: handleStakeLiquiditySteps,
  unstake_liquidity_steps: handleUnstakeLiquiditySteps,
  claim_fees_steps: handleClaimFeesSteps,
  claim_emissions_steps: handleClaimEmissionsSteps,
  claim_rebase_steps: handleClaimRebaseSteps,
  claim_voting_rewards_steps: handleClaimVotingRewardsSteps,
  claim_voting_rewards_payload: handleClaimVotingRewardsPayload,
  create_lock_steps: handleCreateLockSteps,
  increase_lock_steps: handleIncreaseLockSteps,
  merge_lock_steps: handleMergeLockSteps,
  lock_advanced_steps: handleAdvancedLockSteps,
  vote_steps: handleVoteSteps,
  get_lock_vote_state: handleGetLockVoteState,
  vote_leaderboard: handleVoteLeaderboard,
  get_epoch_state: handleGetEpochState,
  get_tokenomics: handleGetTokenomics,
  create_gauge_steps: handleCreateGaugeSteps,
  add_bribes_steps: handleAddBribesSteps,
  create_cl_pool_steps: handleCreateCLPoolSteps,
  resolve_address: handleResolveAddress,
  estimate_gas_and_tx_cost: handleEstimateGasAndTxCost,
  get_token_balances: handleGetTokenBalances,
  get_user_positions: handleGetUserPositions,
  get_user_locks: handleGetUserLocks,
  get_whitelisted_tokens: handleGetWhitelistedTokens,
  get_allowances: handleGetAllowances,
  get_pool_status: handleGetPoolStatus,
  get_opportunities: handleGetOpportunities,
  get_deposit_amounts: handleGetDepositAmounts,
  cl_tick_to_price: handleTickToPrice,
  cl_price_to_tick: handlePriceToTick,
  cl_position_detail: handlePositionDetail,
  cl_apr_simulator: handleAprSimulator,
  get_alm_vaults: handleGetALMVaults,
  get_pool_lp_providers: handleGetPoolLpProviders,
  execute_transactions: handleExecuteTransactions,
};
