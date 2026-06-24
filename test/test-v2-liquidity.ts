// Smoke test: v2 liquidity (add/remove/withdraw/stake/unstake/claim/zap).
import { toolHandlers } from "../src/toolHandlers.js";
import {
  WAVAX,
  USDC,
  WAVAX_DEC,
  USDC_DEC,
  USER,
  discoverPools,
  makeRunner,
} from "./_helpers.js";
export {};

const { run, summary } = makeRunner();

async function main() {
  console.log("🚀 v2 liquidity smoke test…\n");

  const { v2Pool } = await discoverPools();
  console.log(
    `Discovered v2 pair: ${v2Pool ? `${v2Pool.symbol} (${v2Pool.pairAddress})` : "(not found)"}`,
  );

  // add_liquidity uses hard-coded WAVAX/USDC since no pair need pre-exist.
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

  if (!v2Pool) {
    console.log("\n⚠︎ Skipping pair-dependent v2 tests — no v2 pair.");
    summary("v2 liquidity");
    return;
  }

  const { pairAddress, stable, token0, token1 } = v2Pool;

  await run(`remove_liquidity_steps v2 (${v2Pool.symbol})`, () =>
    toolHandlers.remove_liquidity_steps({
      mode: "v2",
      lpTokenAddress: pairAddress,
      tokenA: token0.address,
      tokenB: token1.address,
      stable,
      liquidity: "0.001",
      amountAMin: "0",
      amountBMin: "0",
      lpTokenDecimals: 18,
      tokenADecimals: token0.decimals,
      tokenBDecimals: token1.decimals,
      userAddress: USER,
    }),
  );

  await run("withdraw_liquidity_steps v2", () =>
    toolHandlers.withdraw_liquidity_steps({
      mode: "v2",
      userAddress: USER,
      poolAddress: pairAddress,
      lpTokenAddress: pairAddress,
      tokenA: token0.address,
      tokenB: token1.address,
      stable,
      liquidity: "0.001",
      amountAMin: "0",
      amountBMin: "0",
      tokenADecimals: token0.decimals,
      tokenBDecimals: token1.decimals,
    }),
  );

  await run("stake_liquidity_steps v2", () =>
    toolHandlers.stake_liquidity_steps({
      mode: "v2",
      userAddress: USER,
      poolAddress: pairAddress,
      amount: "0.001",
    }),
  );

  await run("unstake_liquidity_steps v2", () =>
    toolHandlers.unstake_liquidity_steps({
      mode: "v2",
      userAddress: USER,
      poolAddress: pairAddress,
    }),
  );

  await run("claim_fees_steps v2", () =>
    toolHandlers.claim_fees_steps({
      mode: "v2",
      pairAddress,
      userAddress: USER,
    }),
  );

  await run("claim_emissions_steps v2", () =>
    toolHandlers.claim_emissions_steps({
      mode: "v2",
      poolAddress: pairAddress,
      userAddress: USER,
    }),
  );

  await run(`zap_add_liquidity_steps (${token0.symbol}→${v2Pool.symbol})`, () =>
    toolHandlers.zap_add_liquidity_steps({
      tokenA: token0.address,
      tokenB: token1.address,
      stable,
      tokenADecimals: token0.decimals,
      tokenBDecimals: token1.decimals,
      inputTokens: [token0.address],
      inputAmounts: ["1"],
      inputTokenDecimals: [token0.decimals],
      poolAddress: pairAddress,
      slippagePercent: 5,
      to: USER,
    }),
  );

  await run("zap_split_plan (v2)", () =>
    toolHandlers.zap_split_plan({
      poolType: "basic",
      poolAddress: pairAddress,
      tokenA: token0.address,
      tokenB: token1.address,
      inputToken: token0.address,
      inputAmount: "1",
      inputTokenDecimals: token0.decimals,
      routeRecipient: USER,
    }),
  );

  await run("zap_remove_liquidity_steps v2", () =>
    toolHandlers.zap_remove_liquidity_steps({
      mode: "v2",
      userAddress: USER,
      outputToken: token1.address,
      outputTokenDecimals: token1.decimals,
      tokenA: token0.address,
      tokenB: token1.address,
      tokenADecimals: token0.decimals,
      tokenBDecimals: token1.decimals,
      stable,
      lpTokenAddress: pairAddress,
      liquidity: "0.001",
      expectedAmountA: "0.5",
      expectedAmountB: "15",
      slippagePercent: 5,
    }),
  );

  summary("v2 liquidity");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
