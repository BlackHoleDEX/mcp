// Smoke test: CL (concentrated) liquidity + math handlers.
import { toolHandlers } from "../src/toolHandlers.js";
import {
  WAVAX,
  USDC,
  WAVAX_DEC,
  USDC_DEC,
  USER,
  CL_DEPLOYER,
  REAL_CL_POSITION_TOKEN_ID,
  discoverPools,
  makeRunner,
} from "./_helpers.js";
export {};

const { run, summary } = makeRunner();

async function main() {
  console.log("🚀 CL liquidity smoke test…\n");

  const { clPool } = await discoverPools();
  console.log(
    `Discovered CL pool: ${clPool ? `${clPool.symbol} (${clPool.pairAddress})` : "(not found)"}`,
  );

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
    const { pairAddress, token0, token1 } = clPool;

    await run("cl_position_detail", () =>
      toolHandlers.cl_position_detail({
        poolAddress: pairAddress,
        tickLower: -600,
        tickUpper: 600,
      }),
    );

    await run("cl_apr_simulator", () =>
      toolHandlers.cl_apr_simulator({ poolAddress: pairAddress }),
    );

    await run("cl_tick_to_price (poolAddress)", () =>
      toolHandlers.cl_tick_to_price({ tick: 0, poolAddress: pairAddress }),
    );

    await run("cl_price_to_tick (poolAddress)", () =>
      toolHandlers.cl_price_to_tick({ price: 30, poolAddress: pairAddress }),
    );

    await run("zap_mint_cl_steps mint", () =>
      toolHandlers.zap_mint_cl_steps({
        mode: "mint",
        token0: token0.address,
        token1: token1.address,
        deployer: CL_DEPLOYER,
        tickLower: -600,
        tickUpper: 600,
        token0Decimals: token0.decimals,
        token1Decimals: token1.decimals,
        recipient: USER,
        inputTokens: [token0.address],
        inputAmounts: ["1"],
        inputTokenDecimals: [token0.decimals],
        poolAddress: pairAddress,
        slippagePercent: 5,
      }),
    );

    await run("zap_split_plan (CL)", () =>
      toolHandlers.zap_split_plan({
        poolType: "cl",
        poolAddress: pairAddress,
        tokenA: token0.address,
        tokenB: token1.address,
        inputToken: token0.address,
        inputAmount: "1",
        inputTokenDecimals: token0.decimals,
        routeRecipient: USER,
        tickLower: -600,
        tickUpper: 600,
      }),
    );

    await run("zap_increase_liquidity_steps (CL)", () =>
      toolHandlers.zap_increase_liquidity_steps({
        tokenId: REAL_CL_POSITION_TOKEN_ID,
        token0: token0.address,
        token1: token1.address,
        tickLower: -600,
        tickUpper: 600,
        token0Decimals: token0.decimals,
        token1Decimals: token1.decimals,
        inputTokens: [token0.address],
        inputAmounts: ["1"],
        inputTokenDecimals: [token0.decimals],
        poolAddress: pairAddress,
        routeRecipient: USER,
        slippagePercent: 5,
      }),
    );

    await run("stake_liquidity_steps cl", () =>
      toolHandlers.stake_liquidity_steps({
        mode: "cl",
        userAddress: USER,
        poolAddress: pairAddress,
        tokenId: REAL_CL_POSITION_TOKEN_ID,
      }),
    );

    await run("unstake_liquidity_steps cl", () =>
      toolHandlers.unstake_liquidity_steps({
        mode: "cl",
        userAddress: USER,
        poolAddress: pairAddress,
        tokenId: REAL_CL_POSITION_TOKEN_ID,
      }),
    );

    await run("claim_emissions_steps cl", () =>
      toolHandlers.claim_emissions_steps({
        mode: "cl",
        poolAddress: pairAddress,
        tokenId: REAL_CL_POSITION_TOKEN_ID,
        userAddress: USER,
      }),
    );
  } else {
    console.log("\n⚠︎ Skipping CL-pool tests — no CL pool discovered.");
  }

  await run("cl_tick_to_price (raw)", () =>
    toolHandlers.cl_tick_to_price({
      tick: 0,
      token0Decimals: WAVAX_DEC,
      token1Decimals: USDC_DEC,
    }),
  );

  await run("cl_price_to_tick (raw)", () =>
    toolHandlers.cl_price_to_tick({
      price: 30,
      token0Decimals: WAVAX_DEC,
      token1Decimals: USDC_DEC,
    }),
  );

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

  summary("CL liquidity");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
