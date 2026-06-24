// Comprehensive smoke-test for every MCP tool handler.
//
// Tokens used throughout:
//   WAVAX: 0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7 (18 decimals)
//   USDC:  0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E (6 decimals)
//
// No setup-envs; SERVER_CONFIG.RPC_URL is prod Avalanche C-Chain.
//
// Pool / pair addresses are discovered dynamically via pool_yield so the file
// stays self-contained. TokenIds (veNFT + CL position NFT) are placeholders —
// replace REAL_VENFT_TOKEN_ID / REAL_CL_POSITION_TOKEN_ID for meaningful runs.

import { encodeFunctionData, maxUint256 } from "viem";

import { ERC20_ABI, ROUTER_V2_ADDRESS } from "../src/constants/contracts.js";
import { toolHandlers } from "../src/toolHandlers.js";
export {};

// ─── Constants ───────────────────────────────────────────────────────────────

const WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";
const USDC = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
const WAVAX_DEC = 18;
const USDC_DEC = 6;

// Placeholder user — has no positions, so portfolio calls return empty but
// every handler will exercise its compute + RPC-read paths.
const USER = "0x1234567890123456789012345678901234567890";

// Placeholders — swap to real values for an end-to-end run.
const REAL_VENFT_TOKEN_ID = 1;
const REAL_CL_POSITION_TOKEN_ID = 1;
const CL_DEPLOYER = "0x0000000000000000000000000000000000000000";
const BONUS_REWARD_TOKEN = "0x0000000000000000000000000000000000000000";
const PLACEHOLDER_BRIBE = "0x0000000000000000000000000000000000000001";

// ─── Runner ──────────────────────────────────────────────────────────────────

type Result = { name: string; ok: boolean; error?: string; preview?: string };
const results: Result[] = [];

async function run(name: string, fn: () => any | Promise<any>) {
  try {
    const out = await fn();
    const preview = JSON.stringify(out, (_, v) =>
      typeof v === "bigint" ? v.toString() : v,
    ).slice(0, 240);
    results.push({ name, ok: true, preview });
    console.log(`\n✅ ${name}\n${preview}${preview.length >= 240 ? "…" : ""}`);
  } catch (err: any) {
    results.push({ name, ok: false, error: err?.message ?? String(err) });
    console.log(`\n❌ ${name}\n   ${err?.message ?? err}`);
  }
}

// ─── Discovery: pick a real WAVAX/USDC v2 pair + CL pool at runtime ─────────

async function discoverPools() {
  const v2 = await toolHandlers.pool_yield({
    poolType: "basic",
    search: "USDC",
    topN: 50,
    sortBy: "tvlUsd",
  });
  const cl = await toolHandlers.pool_yield({
    poolType: "concentrated",
    search: "USDC",
    topN: 50,
    sortBy: "tvlUsd",
  });
  const v2Pair = (v2 as any)?.data?.find((p: any) =>
    /WAVAX.*USDC|USDC.*WAVAX/i.test(p.symbol),
  );
  const clPool = (cl as any)?.data?.find((p: any) =>
    /WAVAX.*USDC|USDC.*WAVAX/i.test(p.symbol),
  );
  return {
    v2Pair: v2Pair?.pairAddress as string | undefined,
    v2PairStable: !!v2Pair?.stable,
    clPool: clPool?.pairAddress as string | undefined,
  };
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 Running all-tools smoke test…\n");

  const { v2Pair, v2PairStable, clPool } = await discoverPools();
  console.log(`Discovered WAVAX/USDC v2 pair: ${v2Pair ?? "(not found)"}`);
  console.log(`Discovered WAVAX/USDC CL pool: ${clPool ?? "(not found)"}`);

  // ── quote / swap ──────────────────────────────────────────────────────────
  await run("quote (WAVAX→USDC)", () =>
    toolHandlers.quote({
      tokenIn: WAVAX,
      tokenOut: USDC,
      amountIn: "10",
      tokenInDecimals: WAVAX_DEC,
      tokenOutDecimals: USDC_DEC,
    }),
  );

  await run("quote split (WAVAX→USDC, 100k)", () =>
    toolHandlers.quote({
      tokenIn: WAVAX,
      tokenOut: USDC,
      amountIn: "100000",
      tokenInDecimals: WAVAX_DEC,
      tokenOutDecimals: USDC_DEC,
      useSplitRoutes: true,
      distributionPercent: 10,
      maxSplits: 3,
      minSplits: 1,
    }),
  );

  await run("swap_steps (WAVAX→USDC)", () =>
    toolHandlers.swap_steps({
      tokenIn: WAVAX,
      tokenOut: USDC,
      amountIn: "10",
      amountOutMin: "0",
      userAddress: USER,
      tokenInDecimals: WAVAX_DEC,
      tokenOutDecimals: USDC_DEC,
    }),
  );

  // ── pool_yield ────────────────────────────────────────────────────────────
  await run("pool_yield top 5 concentrated", () =>
    toolHandlers.pool_yield({ poolType: "concentrated", topN: 5, sortBy: "apr" }),
  );

  if (v2Pair) {
    await run("pool_yield single pool", () =>
      toolHandlers.pool_yield({ poolAddress: v2Pair }),
    );
  }

  // ── v2 add / remove / withdraw liquidity ──────────────────────────────────
  await run("add_liquidity_steps (WAVAX/USDC)", () =>
    toolHandlers.add_liquidity_steps({
      tokenA: WAVAX,
      tokenB: USDC,
      stable: false,
      amountADesired: "1",
      amountBDesired: "30",
      amountAMin: "0.95",
      amountBMin: "28.5",
      userAddress: USER,
      tokenADecimals: WAVAX_DEC,
      tokenBDecimals: USDC_DEC,
    }),
  );

  if (v2Pair) {
    await run("remove_liquidity_steps v2 (WAVAX/USDC)", () =>
      toolHandlers.remove_liquidity_steps({
        mode: "v2",
        lpTokenAddress: v2Pair,
        tokenA: WAVAX,
        tokenB: USDC,
        stable: v2PairStable,
        liquidity: "0.001",
        amountAMin: "0",
        amountBMin: "0",
        lpTokenDecimals: 18,
        tokenADecimals: WAVAX_DEC,
        tokenBDecimals: USDC_DEC,
        userAddress: USER,
      }),
    );

    await run("withdraw_liquidity_steps v2", () =>
      toolHandlers.withdraw_liquidity_steps({
        mode: "v2",
        userAddress: USER,
        poolAddress: v2Pair,
        lpTokenAddress: v2Pair,
        tokenA: WAVAX,
        tokenB: USDC,
        stable: v2PairStable,
        liquidity: "0.001",
        amountAMin: "0",
        amountBMin: "0",
        tokenADecimals: WAVAX_DEC,
        tokenBDecimals: USDC_DEC,
      }),
    );

    await run("stake_liquidity_steps v2", () =>
      toolHandlers.stake_liquidity_steps({
        mode: "v2",
        userAddress: USER,
        poolAddress: v2Pair,
        amount: "0.001",
      }),
    );

    await run("unstake_liquidity_steps v2", () =>
      toolHandlers.unstake_liquidity_steps({
        mode: "v2",
        userAddress: USER,
        poolAddress: v2Pair,
      }),
    );

    await run("claim_fees_steps v2", () =>
      toolHandlers.claim_fees_steps({
        mode: "v2",
        pairAddress: v2Pair,
        userAddress: USER,
      }),
    );

    await run("claim_emissions_steps v2", () =>
      toolHandlers.claim_emissions_steps({
        mode: "v2",
        poolAddress: v2Pair,
        userAddress: USER,
      }),
    );

    // zap v2
    await run("zap_add_liquidity_steps (WAVAX→WAVAX/USDC)", () =>
      toolHandlers.zap_add_liquidity_steps({
        tokenA: WAVAX,
        tokenB: USDC,
        stable: v2PairStable,
        tokenADecimals: WAVAX_DEC,
        tokenBDecimals: USDC_DEC,
        inputTokens: [WAVAX],
        inputAmounts: ["1"],
        inputTokenDecimals: [WAVAX_DEC],
        poolAddress: v2Pair,
        slippagePercent: 5,
        to: USER,
      }),
    );

    await run("zap_split_plan (v2 WAVAX→WAVAX/USDC)", () =>
      toolHandlers.zap_split_plan({
        poolType: "basic",
        poolAddress: v2Pair,
        tokenA: WAVAX,
        tokenB: USDC,
        inputToken: WAVAX,
        inputAmount: "1",
        inputTokenDecimals: WAVAX_DEC,
        routeRecipient: USER,
      }),
    );

    await run("zap_remove_liquidity_steps v2", () =>
      toolHandlers.zap_remove_liquidity_steps({
        mode: "v2",
        userAddress: USER,
        outputToken: USDC,
        outputTokenDecimals: USDC_DEC,
        tokenA: WAVAX,
        tokenB: USDC,
        tokenADecimals: WAVAX_DEC,
        tokenBDecimals: USDC_DEC,
        stable: v2PairStable,
        lpTokenAddress: v2Pair,
        liquidity: "0.001",
        expectedAmountA: "0.5",
        expectedAmountB: "15",
        slippagePercent: 5,
      }),
    );
  } else {
    console.log("\n⚠︎ Skipping v2-pair tests — no WAVAX/USDC v2 pair discovered.");
  }

  // ── CL add / remove / zap / stake / etc ───────────────────────────────────
  await run("add_liquidity_cl_steps mint (WAVAX/USDC)", () =>
    toolHandlers.add_liquidity_cl_steps({
      mode: "mint",
      token0: WAVAX,
      token1: USDC,
      deployer: CL_DEPLOYER,
      tickLower: -60,
      tickUpper: 60,
      amount0Desired: "1",
      amount1Desired: "30",
      amount0Min: "0",
      amount1Min: "0",
      recipient: USER,
      token0Decimals: WAVAX_DEC,
      token1Decimals: USDC_DEC,
    }),
  );

  if (clPool) {
    await run("cl_position_detail", () =>
      toolHandlers.cl_position_detail({
        poolAddress: clPool,
        tickLower: -600,
        tickUpper: 600,
      }),
    );

    await run("cl_apr_simulator", () =>
      toolHandlers.cl_apr_simulator({ poolAddress: clPool }),
    );

    await run("cl_tick_to_price (poolAddress)", () =>
      toolHandlers.cl_tick_to_price({ tick: 0, poolAddress: clPool }),
    );

    await run("cl_price_to_tick (poolAddress)", () =>
      toolHandlers.cl_price_to_tick({ price: 30, poolAddress: clPool }),
    );

    await run("zap_mint_cl_steps mint", () =>
      toolHandlers.zap_mint_cl_steps({
        mode: "mint",
        token0: WAVAX,
        token1: USDC,
        deployer: CL_DEPLOYER,
        tickLower: -600,
        tickUpper: 600,
        token0Decimals: WAVAX_DEC,
        token1Decimals: USDC_DEC,
        recipient: USER,
        inputTokens: [WAVAX],
        inputAmounts: ["1"],
        inputTokenDecimals: [WAVAX_DEC],
        poolAddress: clPool,
        slippagePercent: 5,
      }),
    );

    await run("zap_split_plan (CL WAVAX→WAVAX/USDC)", () =>
      toolHandlers.zap_split_plan({
        poolType: "cl",
        poolAddress: clPool,
        tokenA: WAVAX,
        tokenB: USDC,
        inputToken: WAVAX,
        inputAmount: "1",
        inputTokenDecimals: WAVAX_DEC,
        routeRecipient: USER,
        tickLower: -600,
        tickUpper: 600,
      }),
    );

    await run("zap_increase_liquidity_steps (CL)", () =>
      toolHandlers.zap_increase_liquidity_steps({
        tokenId: REAL_CL_POSITION_TOKEN_ID,
        token0: WAVAX,
        token1: USDC,
        tickLower: -600,
        tickUpper: 600,
        token0Decimals: WAVAX_DEC,
        token1Decimals: USDC_DEC,
        inputTokens: [WAVAX],
        inputAmounts: ["1"],
        inputTokenDecimals: [WAVAX_DEC],
        poolAddress: clPool,
        routeRecipient: USER,
        slippagePercent: 5,
      }),
    );

    await run("stake_liquidity_steps cl", () =>
      toolHandlers.stake_liquidity_steps({
        mode: "cl",
        userAddress: USER,
        poolAddress: clPool,
        tokenId: REAL_CL_POSITION_TOKEN_ID,
      }),
    );

    await run("unstake_liquidity_steps cl", () =>
      toolHandlers.unstake_liquidity_steps({
        mode: "cl",
        userAddress: USER,
        poolAddress: clPool,
        tokenId: REAL_CL_POSITION_TOKEN_ID,
      }),
    );

    await run("claim_emissions_steps cl", () =>
      toolHandlers.claim_emissions_steps({
        mode: "cl",
        poolAddress: clPool,
        tokenId: REAL_CL_POSITION_TOKEN_ID,
        userAddress: USER,
      }),
    );
  } else {
    console.log("\n⚠︎ Skipping CL-pool tests — no WAVAX/USDC CL pool discovered.");
  }

  // CL calc without pool (pure math)
  await run("cl_tick_to_price (raw)", () =>
    toolHandlers.cl_tick_to_price({ tick: 0, token0Decimals: WAVAX_DEC, token1Decimals: USDC_DEC }),
  );

  await run("cl_price_to_tick (raw)", () =>
    toolHandlers.cl_price_to_tick({
      price: 30,
      token0Decimals: WAVAX_DEC,
      token1Decimals: USDC_DEC,
    }),
  );

  // remove_liquidity cl (uses placeholder tokenId)
  await run("remove_liquidity_steps cl", () =>
    toolHandlers.remove_liquidity_steps({
      mode: "cl",
      userAddress: USER,
      tokenId: REAL_CL_POSITION_TOKEN_ID,
      liquidityToRemove: "1",
      amount0Min: "0",
      amount1Min: "0",
      token0Decimals: WAVAX_DEC,
      token1Decimals: USDC_DEC,
    }),
  );

  await run("claim_fees_steps cl", () =>
    toolHandlers.claim_fees_steps({
      mode: "cl",
      tokenId: REAL_CL_POSITION_TOKEN_ID,
      userAddress: USER,
    }),
  );

  // zap_remove_liquidity_steps cl (raw liquidity)
  await run("zap_remove_liquidity_steps cl", () =>
    toolHandlers.zap_remove_liquidity_steps({
      mode: "cl",
      userAddress: USER,
      outputToken: USDC,
      outputTokenDecimals: USDC_DEC,
      tokenId: REAL_CL_POSITION_TOKEN_ID,
      liquidityRaw: "1000000",
      token0: WAVAX,
      token1: USDC,
      token0Decimals: WAVAX_DEC,
      token1Decimals: USDC_DEC,
      expectedAmountA: "0.5",
      expectedAmountB: "15",
      slippagePercent: 5,
    }),
  );

  // ── Locks ────────────────────────────────────────────────────────────────
  await run("create_lock_steps", () =>
    toolHandlers.create_lock_steps({
      userAddress: USER,
      amount: "100",
      lockDurationInSeconds: 60 * 60 * 24 * 365,
      isSMNFT: false,
    }),
  );

  await run("increase_lock_steps", () =>
    toolHandlers.increase_lock_steps({
      userAddress: USER,
      tokenId: REAL_VENFT_TOKEN_ID,
      amount: "50",
    }),
  );

  await run("merge_lock_steps", () =>
    toolHandlers.merge_lock_steps({
      userAddress: USER,
      fromTokenId: REAL_VENFT_TOKEN_ID,
      toTokenId: REAL_VENFT_TOKEN_ID + 1,
    }),
  );

  await run("lock_advanced_steps extend", () =>
    toolHandlers.lock_advanced_steps({
      action: "extend",
      userAddress: USER,
      tokenId: REAL_VENFT_TOKEN_ID,
      lockDurationInSeconds: 60 * 60 * 24 * 365,
    }),
  );

  await run("lock_advanced_steps withdraw", () =>
    toolHandlers.lock_advanced_steps({
      action: "withdraw",
      userAddress: USER,
      tokenId: REAL_VENFT_TOKEN_ID,
    }),
  );

  await run("lock_advanced_steps lockPermanent", () =>
    toolHandlers.lock_advanced_steps({
      action: "lockPermanent",
      userAddress: USER,
      tokenId: REAL_VENFT_TOKEN_ID,
    }),
  );

  await run("lock_advanced_steps unlockPermanent", () =>
    toolHandlers.lock_advanced_steps({
      action: "unlockPermanent",
      userAddress: USER,
      tokenId: REAL_VENFT_TOKEN_ID,
    }),
  );

  // ── Epoch state ───────────────────────────────────────────────────────────
  await run("get_epoch_state", () =>
    toolHandlers.get_epoch_state({}),
  );

  // ── Vote leaderboard ──────────────────────────────────────────────────────
  await run("vote_leaderboard top 10 (votes desc)", () =>
    toolHandlers.vote_leaderboard({ topN: 10 }),
  );

  await run("vote_leaderboard sortBy=vapr top 5", () =>
    toolHandlers.vote_leaderboard({ topN: 5, sortBy: "vapr" }),
  );

  await run("vote_leaderboard poolType=basic minVotesUsd=50000", () =>
    toolHandlers.vote_leaderboard({ topN: 5, poolType: "basic", minVotesUsd: 50000 }),
  );

  // ── Voting ────────────────────────────────────────────────────────────────
  if (v2Pair) {
    await run("vote_steps vote (WAVAX/USDC)", () =>
      toolHandlers.vote_steps({
        action: "vote",
        userAddress: USER,
        tokenId: REAL_VENFT_TOKEN_ID,
        poolAddresses: [v2Pair],
        poolWeights: [100],
      }),
    );
  }

  await run("vote_steps reset", () =>
    toolHandlers.vote_steps({
      action: "reset",
      userAddress: USER,
      tokenId: REAL_VENFT_TOKEN_ID,
    }),
  );

  await run("vote_steps poke", () =>
    toolHandlers.vote_steps({
      action: "poke",
      userAddress: USER,
      tokenId: REAL_VENFT_TOKEN_ID,
    }),
  );

  await run("claim_voting_rewards_steps", () =>
    toolHandlers.claim_voting_rewards_steps({
      userAddress: USER,
      tokenId: REAL_VENFT_TOKEN_ID,
      bribeAddresses: [PLACEHOLDER_BRIBE],
      bribeRewardTokens: [[WAVAX]],
    }),
  );

  // expected to throw when the dummy user has no rewards; we log the outcome.
  await run("claim_voting_rewards_payload (dummy user — expected empty)", () =>
    toolHandlers.claim_voting_rewards_payload({
      userAddress: USER,
      tokenId: REAL_VENFT_TOKEN_ID,
    }),
  );

  // ── Gauge / Bribe / Pool creation ─────────────────────────────────────────
  if (v2Pair) {
    await run("create_gauge_steps (basic)", () =>
      toolHandlers.create_gauge_steps({
        poolAddress: v2Pair,
        gaugeType: 0,
        bonusRewardToken: BONUS_REWARD_TOKEN,
        userAddress: USER,
      }),
    );
  }

  await run("add_bribes_steps", () =>
    toolHandlers.add_bribes_steps({
      bribeAddress: PLACEHOLDER_BRIBE,
      rewardToken: WAVAX,
      amount: "1",
      amountDecimals: WAVAX_DEC,
      userAddress: USER,
    }),
  );

  await run("create_cl_pool_steps (WAVAX/USDC)", () =>
    toolHandlers.create_cl_pool_steps({
      creator: USER,
      tokenA: WAVAX,
      tokenB: USDC,
      deployerAddress: CL_DEPLOYER,
      initialPrice: "30",
      tokenADecimals: WAVAX_DEC,
      tokenBDecimals: USDC_DEC,
      userAddress: USER,
    }),
  );

  // ── Portfolio ─────────────────────────────────────────────────────────────
  await run("get_whitelisted_tokens", () =>
    toolHandlers.get_whitelisted_tokens({}),
  );

  await run("get_token_balances (dummy user)", () =>
    toolHandlers.get_token_balances({ userAddress: USER }),
  );

  await run("get_user_positions (dummy user)", () =>
    toolHandlers.get_user_positions({ userAddress: USER }),
  );

  await run("get_user_locks (dummy user)", () =>
    toolHandlers.get_user_locks({ userAddress: USER }),
  );

  // ── Operational / Safety ──────────────────────────────────────────────────
  await run("get_allowances (dummy user)", () =>
    toolHandlers.get_allowances({ userAddress: USER, includeZero: false }),
  );

  await run("estimate_gas_and_tx_cost (USDC approve router)", () => {
    const data = encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [ROUTER_V2_ADDRESS as `0x${string}`, maxUint256],
    });
    return toolHandlers.estimate_gas_and_tx_cost({
      from: USER,
      to: USDC,
      data,
      value: "0",
    });
  });

  if (v2Pair) {
    await run("get_pool_status (discovered V2 pool)", () =>
      toolHandlers.get_pool_status({ poolAddress: v2Pair }),
    );
  }

  await run("get_opportunities (dummy user)", () =>
    toolHandlers.get_opportunities({ userAddress: USER }),
  );

  // ── Summary ──────────────────────────────────────────────────────────────
  const passed = results.filter((r) => r.ok).length;
  const failed = results.length - passed;
  console.log(`\n─────────────────────────────`);
  console.log(`TOTAL : ${results.length}`);
  console.log(`PASS  : ${passed}`);
  console.log(`FAIL  : ${failed}`);
  if (failed > 0) {
    console.log(`\nFailures:`);
    for (const r of results.filter((r) => !r.ok)) {
      console.log(`  • ${r.name}: ${r.error}`);
    }
  }
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
