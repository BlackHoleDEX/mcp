// Smoke test: pool_yield handler variants.
import { toolHandlers } from "../src/toolHandlers.js";
import { discoverPools, makeRunner } from "./_helpers.js";
export {};

const { run, summary } = makeRunner();

async function main() {
  console.log("🚀 pool_yield smoke test…\n");

  await run("pool_yield top 5 concentrated", () =>
    toolHandlers.pool_yield({
      poolType: "concentrated",
      topN: 5,
      sortBy: "apr",
    }),
  );

  await run("pool_yield top 5 basic", () =>
    toolHandlers.pool_yield({
      poolType: "basic",
      topN: 5,
      sortBy: "apr",
    }),
  );

  await run("pool_yield rewardTokens shape (top 10 hasGauge)", async () => {
    const res = await toolHandlers.pool_yield({
      topN: 10,
      hasGauge: true,
      sortBy: "votes",
    });
    const r = res as any;
    if (!Array.isArray(r.data)) throw new Error("data not array");
    for (const pool of r.data) {
      if (!Array.isArray(pool.rewardTokens)) {
        throw new Error(`rewardTokens missing on pool ${pool.symbol}`);
      }
      for (const rt of pool.rewardTokens) {
        if (!["fee", "bribe"].includes(rt.type)) {
          throw new Error(`Invalid rewardToken type '${rt.type}' on pool ${pool.symbol}`);
        }
        if (typeof rt.amountPerEpoch !== "number") {
          throw new Error(`rewardToken.amountPerEpoch is not a number on pool ${pool.symbol}`);
        }
        if (typeof rt.usdPerEpoch !== "number") {
          throw new Error(`rewardToken.usdPerEpoch is not a number on pool ${pool.symbol}`);
        }
      }
    }
    const withRewards = r.data.filter((p: any) => p.rewardTokens.length > 0).length;
    console.log(`  ${withRewards}/${r.data.length} pools have explicit reward tokens`);
    return res;
  });

  await run("pool_yield tvl/fee token split fields", async () => {
    const res = await toolHandlers.pool_yield({ topN: 10, sortBy: "tvlUsd" });
    const r = res as any;
    if (!Array.isArray(r.data)) throw new Error("data not array");
    for (const pool of r.data) {
      for (const field of ["tvlToken0Amount", "tvlToken1Amount", "feesToken0Amount", "feesToken1Amount"]) {
        if (typeof pool[field] !== "number") {
          throw new Error(`${field} missing or not a number on pool ${pool.symbol}`);
        }
        if (pool[field] < 0) {
          throw new Error(`${field} is negative on pool ${pool.symbol}`);
        }
      }
      // TVL token split should roughly sum to TVL (allow for price drift / zero-priced tokens)
      if (pool.tvlUsd > 0 && pool.tvlToken0Amount === 0 && pool.tvlToken1Amount === 0) {
        throw new Error(`tvlUsd=${pool.tvlUsd} but both token amounts are 0 on pool ${pool.symbol}`);
      }
    }
    const sample = r.data[0];
    if (sample) {
      console.log(
        `  ${sample.symbol}: tvl=$${sample.tvlUsd} (${sample.tvlToken0Amount} ${sample.token0.symbol} + ${sample.tvlToken1Amount} ${sample.token1.symbol})`,
      );
      console.log(
        `  ${sample.symbol}: fees=$${sample.feesUsd} (${sample.feesToken0Amount} ${sample.token0.symbol} + ${sample.feesToken1Amount} ${sample.token1.symbol})`,
      );
    }
    return res;
  });

  await run("pool_yield sortBy=votes (vote-optimization order)", async () => {
    const res = await toolHandlers.pool_yield({
      topN: 5,
      sortBy: "votes",
      hasGauge: true,
      sortOrder: "desc",
    });
    const r = res as any;
    if (!Array.isArray(r.data)) throw new Error("data not array");
    // Verify descending sort
    for (let i = 1; i < r.data.length; i++) {
      if (r.data[i].votes > r.data[i - 1].votes) {
        throw new Error(`Not sorted by votes desc at index ${i}`);
      }
    }
    return res;
  });

  const { v2Pool } = await discoverPools();
  if (v2Pool) {
    await run(`pool_yield single pool (${v2Pool.symbol})`, async () => {
      const res = await toolHandlers.pool_yield({ poolAddress: v2Pool.pairAddress });
      const r = res as any;
      if (!r.success) throw new Error("success=false");
      const d = r.data;
      for (const field of ["tvlToken0Amount", "tvlToken1Amount", "feesToken0Amount", "feesToken1Amount"]) {
        if (typeof d[field] !== "number") throw new Error(`${field} missing or not a number`);
      }
      console.log(
        `  tvl=$${d.tvlUsd} (${d.tvlToken0Amount} ${d.token0.symbol} + ${d.tvlToken1Amount} ${d.token1.symbol})`,
      );
      return res;
    });
  } else {
    console.log("\n⚠︎ No v2 pair discovered for single-pool lookup.");
  }

  summary("pool_yield");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
