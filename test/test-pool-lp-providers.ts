// Smoke test: get_pool_lp_providers handler.
//
// Tests both CL and V2 pool types using dynamically discovered addresses.
// V2 tests are skipped automatically when the basic subgraph is unavailable
// (the URL in config.ts may need updating if the Goldsky deployment changes).
//
// Run:  npx tsx test/test-pool-lp-providers.ts

import { toolHandlers } from "../src/toolHandlers.js";
import { SERVER_CONFIG } from "../src/config.js";
import { discoverPools, makeRunner } from "./_helpers.js";
export {};

const { run, summary } = makeRunner();

// ── Shared assertions ─────────────────────────────────────────────────────────

function assertProviderShape(p: any, poolType: "concentrated" | "v2") {
  if (typeof p.rank !== "number") throw new Error("provider.rank not a number");
  if (typeof p.wallet !== "string" || !p.wallet.startsWith("0x")) throw new Error("provider.wallet invalid");
  if (typeof p.tvlUsd !== "number") throw new Error("provider.tvlUsd not a number");
  if (typeof p.shareOfPoolTvlPct !== "number") throw new Error("provider.shareOfPoolTvlPct not a number");
  if (typeof p.token0Amount !== "string") throw new Error("provider.token0Amount not a string");
  if (typeof p.token1Amount !== "string") throw new Error("provider.token1Amount not a string");

  if (poolType === "concentrated") {
    if (typeof p.positionCount !== "number") throw new Error("provider.positionCount not a number");
    if (typeof p.totalLiquidity !== "string") throw new Error("provider.totalLiquidity not a string");
    if (!Array.isArray(p.positions)) throw new Error("provider.positions not an array");
    for (const pos of p.positions) {
      if (typeof pos.tokenId !== "number") throw new Error("position.tokenId not a number");
      if (typeof pos.inRange !== "boolean") throw new Error("position.inRange not a boolean");
      if (typeof pos.tickLower !== "number") throw new Error("position.tickLower not a number");
      if (typeof pos.tickUpper !== "number") throw new Error("position.tickUpper not a number");
    }
  }

  if (poolType === "v2") {
    if (typeof p.lpTokensStaked !== "string") throw new Error("provider.lpTokensStaked not a string");
    if (typeof p.lpTokensUnstaked !== "string") throw new Error("provider.lpTokensUnstaked not a string");
    if (typeof p.lpTokensTotal !== "string") throw new Error("provider.lpTokensTotal not a string");
  }
}

function assertSortedByTvlDesc(providers: any[]) {
  for (let i = 1; i < providers.length; i++) {
    if (providers[i].tvlUsd > providers[i - 1].tvlUsd) {
      throw new Error(
        `providers not sorted by tvlUsd desc at index ${i}: ${providers[i].tvlUsd} > ${providers[i - 1].tvlUsd}`,
      );
    }
  }
}

function assertRanksSequential(providers: any[]) {
  for (let i = 0; i < providers.length; i++) {
    if (providers[i].rank !== i + 1) {
      throw new Error(`Expected rank ${i + 1} at index ${i}, got ${providers[i].rank}`);
    }
  }
}

// Probes the basic V2 subgraph and returns true if it is reachable.
async function probeBasicSubgraph(): Promise<boolean> {
  try {
    const res = await fetch(SERVER_CONFIG.BASIC_GRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ query: "{ _meta { block { number } } }" }),
    });
    const json = (await res.json()) as any;
    return !!json?.data?._meta;
  } catch {
    return false;
  }
}

// ── Main ──────────────────────────────────────────────────────────────────────

async function main() {
  console.log("🚀 get_pool_lp_providers smoke test…\n");

  const [{ v2Pool, clPool }, basicSubgraphAvailable] = await Promise.all([
    discoverPools(),
    probeBasicSubgraph(),
  ]);

  if (!basicSubgraphAvailable) {
    console.log("⚠︎  Basic (V2) subgraph unreachable — V2 tests will be skipped.");
    console.log(`   URL: ${SERVER_CONFIG.BASIC_GRAPH_URL}\n`);
  }

  // ── CL pool ───────────────────────────────────────────────────────────────

  if (clPool) {
    await run(`CL pool basic shape (${clPool.symbol})`, async () => {
      const res = await toolHandlers.get_pool_lp_providers({ poolAddress: clPool.pairAddress });
      const r = res as any;
      if (!r.success) throw new Error(`success=false: ${r.message}`);
      if (r.poolType !== "concentrated") throw new Error(`Expected poolType=concentrated, got ${r.poolType}`);
      if (r.poolAddress !== clPool.pairAddress.toLowerCase()) throw new Error("poolAddress mismatch");
      if (typeof r.poolTvlUsd !== "number") throw new Error("poolTvlUsd not a number");
      if (typeof r.totalProviders !== "number") throw new Error("totalProviders not a number");
      if (typeof r.totalActivePositions !== "number") throw new Error("totalActivePositions not a number");
      if (!Array.isArray(r.providers)) throw new Error("providers not an array");
      if (!r.token0?.address || !r.token1?.address) throw new Error("token0/token1 missing");
      console.log(
        `  ${clPool.symbol}: ${r.totalProviders} providers, ${r.totalActivePositions} positions, tvl=$${r.poolTvlUsd}`,
      );
      return res;
    });

    await run(`CL pool providers sorted + ranked (${clPool.symbol})`, async () => {
      const res = await toolHandlers.get_pool_lp_providers({ poolAddress: clPool.pairAddress, limit: 10 });
      const r = res as any;
      if (!r.success) throw new Error(`success=false: ${r.message}`);
      if (r.providers.length === 0) {
        console.log("  ⚠︎ No providers returned (pool may have no active positions)");
        return res;
      }
      assertSortedByTvlDesc(r.providers);
      assertRanksSequential(r.providers);
      for (const p of r.providers) assertProviderShape(p, "concentrated");
      const top = r.providers[0];
      console.log(
        `  Top LP: ${top.wallet} — tvl=$${top.tvlUsd} (${top.shareOfPoolTvlPct}%) — ${top.positionCount} position(s)`,
      );
      return res;
    });

    await run(`CL pool share% non-negative and ≤100 (${clPool.symbol})`, async () => {
      const res = await toolHandlers.get_pool_lp_providers({ poolAddress: clPool.pairAddress, limit: 20 });
      const r = res as any;
      if (!r.success) throw new Error(`success=false: ${r.message}`);
      for (const p of r.providers) {
        if (p.tvlUsd < 0) throw new Error(`Negative tvlUsd for ${p.wallet}`);
        if (p.shareOfPoolTvlPct < 0) throw new Error(`Negative shareOfPoolTvlPct for ${p.wallet}`);
        if (p.shareOfPoolTvlPct > 100.01) throw new Error(`shareOfPoolTvlPct > 100 for ${p.wallet}: ${p.shareOfPoolTvlPct}`);
      }
      if (r.providers.length > 0) {
        const totalShare = r.providers.reduce((s: number, p: any) => s + p.shareOfPoolTvlPct, 0);
        console.log(`  Top ${r.providers.length} wallets hold ${totalShare.toFixed(2)}% of pool TVL`);
      }
      return res;
    });

    await run(`CL pool limit=3 respected (${clPool.symbol})`, async () => {
      const res = await toolHandlers.get_pool_lp_providers({ poolAddress: clPool.pairAddress, limit: 3 });
      const r = res as any;
      if (!r.success) throw new Error(`success=false: ${r.message}`);
      if (r.providers.length > 3) throw new Error(`Expected ≤3 providers, got ${r.providers.length}`);
      if (r.returnedProviders !== r.providers.length) throw new Error("returnedProviders count mismatch");
      console.log(`  Returned ${r.providers.length} of ${r.totalProviders} providers`);
      return res;
    });

    await run(`CL pool positions have valid tick ranges (${clPool.symbol})`, async () => {
      const res = await toolHandlers.get_pool_lp_providers({ poolAddress: clPool.pairAddress, limit: 5 });
      const r = res as any;
      if (!r.success) throw new Error(`success=false: ${r.message}`);
      for (const p of r.providers) {
        for (const pos of p.positions) {
          if (pos.tickLower >= pos.tickUpper) {
            throw new Error(
              `Invalid tick range [${pos.tickLower}, ${pos.tickUpper}] for tokenId=${pos.tokenId}`,
            );
          }
        }
      }
      return res;
    });

    await run(`CL pool totalProviders ≥ returnedProviders (${clPool.symbol})`, async () => {
      const res = await toolHandlers.get_pool_lp_providers({ poolAddress: clPool.pairAddress, limit: 5 });
      const r = res as any;
      if (!r.success) throw new Error(`success=false: ${r.message}`);
      if (r.totalProviders < r.returnedProviders) {
        throw new Error(`totalProviders (${r.totalProviders}) < returnedProviders (${r.returnedProviders})`);
      }
      if (r.totalActivePositions < r.totalProviders) {
        throw new Error(`totalActivePositions (${r.totalActivePositions}) < totalProviders (${r.totalProviders})`);
      }
      console.log(`  ${r.totalProviders} unique wallets across ${r.totalActivePositions} positions`);
      return res;
    });
  } else {
    console.log("⚠︎  No CL pool discovered — skipping CL tests.\n");
  }

  // ── V2 pool ───────────────────────────────────────────────────────────────

  if (v2Pool && basicSubgraphAvailable) {
    await run(`V2 pool basic shape (${v2Pool.symbol})`, async () => {
      const res = await toolHandlers.get_pool_lp_providers({ poolAddress: v2Pool.pairAddress });
      const r = res as any;
      if (!r.success) throw new Error(`success=false: ${r.message}`);
      if (r.poolType !== "v2") throw new Error(`Expected poolType=v2, got ${r.poolType}`);
      if (r.poolAddress !== v2Pool.pairAddress.toLowerCase()) throw new Error("poolAddress mismatch");
      if (typeof r.poolTvlUsd !== "number") throw new Error("poolTvlUsd not a number");
      if (typeof r.totalProviders !== "number") throw new Error("totalProviders not a number");
      if (typeof r.reserve0 !== "string") throw new Error("reserve0 not a string");
      if (typeof r.reserve1 !== "string") throw new Error("reserve1 not a string");
      if (!Array.isArray(r.providers)) throw new Error("providers not an array");
      if (!r.token0?.address || !r.token1?.address) throw new Error("token0/token1 missing");
      console.log(
        `  ${v2Pool.symbol}: ${r.totalProviders} providers, tvl=$${r.poolTvlUsd}, reserve0=${r.reserve0} ${r.token0.symbol}, reserve1=${r.reserve1} ${r.token1.symbol}`,
      );
      return res;
    });

    await run(`V2 pool providers sorted + ranked (${v2Pool.symbol})`, async () => {
      const res = await toolHandlers.get_pool_lp_providers({ poolAddress: v2Pool.pairAddress, limit: 10 });
      const r = res as any;
      if (!r.success) throw new Error(`success=false: ${r.message}`);
      if (r.providers.length === 0) {
        console.log("  ⚠︎ No providers returned (pool may have no LP holders in subgraph)");
        return res;
      }
      assertSortedByTvlDesc(r.providers);
      assertRanksSequential(r.providers);
      for (const p of r.providers) assertProviderShape(p, "v2");
      const top = r.providers[0];
      console.log(
        `  Top LP: ${top.wallet} — tvl=$${top.tvlUsd} (${top.shareOfPoolTvlPct}%) — staked=${top.lpTokensStaked} unstaked=${top.lpTokensUnstaked}`,
      );
      return res;
    });

    await run(`V2 pool share% non-negative and ≤100 (${v2Pool.symbol})`, async () => {
      const res = await toolHandlers.get_pool_lp_providers({ poolAddress: v2Pool.pairAddress, limit: 20 });
      const r = res as any;
      if (!r.success) throw new Error(`success=false: ${r.message}`);
      for (const p of r.providers) {
        if (p.tvlUsd < 0) throw new Error(`Negative tvlUsd for ${p.wallet}`);
        if (p.shareOfPoolTvlPct < 0) throw new Error(`Negative shareOfPoolTvlPct for ${p.wallet}`);
        if (p.shareOfPoolTvlPct > 100.01) throw new Error(`shareOfPoolTvlPct > 100 for ${p.wallet}: ${p.shareOfPoolTvlPct}`);
      }
      if (r.providers.length > 0) {
        const totalShare = r.providers.reduce((s: number, p: any) => s + p.shareOfPoolTvlPct, 0);
        console.log(`  Top ${r.providers.length} wallets hold ${totalShare.toFixed(2)}% of pool TVL`);
      }
      return res;
    });

    await run(`V2 pool limit=5 respected (${v2Pool.symbol})`, async () => {
      const res = await toolHandlers.get_pool_lp_providers({ poolAddress: v2Pool.pairAddress, limit: 5 });
      const r = res as any;
      if (!r.success) throw new Error(`success=false: ${r.message}`);
      if (r.providers.length > 5) throw new Error(`Expected ≤5 providers, got ${r.providers.length}`);
      if (r.returnedProviders !== r.providers.length) throw new Error("returnedProviders count mismatch");
      console.log(`  Returned ${r.providers.length} of ${r.totalProviders} providers`);
      return res;
    });

    await run(`V2 pool lpTokensTotal = staked + unstaked (${v2Pool.symbol})`, async () => {
      const res = await toolHandlers.get_pool_lp_providers({ poolAddress: v2Pool.pairAddress, limit: 10 });
      const r = res as any;
      if (!r.success) throw new Error(`success=false: ${r.message}`);
      for (const p of r.providers) {
        const staked = BigInt(Math.floor(parseFloat(p.lpTokensStaked)));
        const unstaked = BigInt(Math.floor(parseFloat(p.lpTokensUnstaked)));
        const total = BigInt(p.lpTokensTotal);
        if (staked + unstaked !== total) {
          throw new Error(
            `lpTokensTotal mismatch for ${p.wallet}: staked+unstaked=${staked + unstaked}, total=${total}`,
          );
        }
      }
      return res;
    });
  } else if (v2Pool && !basicSubgraphAvailable) {
    console.log(`\n⚠︎  Skipping V2 tests (${v2Pool.symbol}) — basic subgraph unavailable.`);
    console.log("   Update BASIC_GRAPH_URL in config.ts when a new deployment is available.\n");
  } else {
    console.log("⚠︎  No V2 pool discovered — skipping V2 tests.\n");
  }

  // ── Edge cases ─────────────────────────────────────────────────────────────

  await run("unknown address returns success=false", async () => {
    const res = await toolHandlers.get_pool_lp_providers({
      poolAddress: "0x0000000000000000000000000000000000000001",
    });
    const r = res as any;
    if (r.success !== false) throw new Error("Expected success=false for unknown pool");
    if (typeof r.message !== "string") throw new Error("Expected message field");
    console.log(`  message: ${r.message}`);
    return res;
  });

  await run("limit capped at 100 (limit=999)", async () => {
    if (!clPool && !v2Pool) return { skipped: "no pool discovered" };
    const poolAddress = (clPool ?? v2Pool)!.pairAddress;
    const res = await toolHandlers.get_pool_lp_providers({ poolAddress, limit: 999 });
    const r = res as any;
    if (!r.success) throw new Error(`success=false: ${r.message}`);
    if (r.providers.length > 100) throw new Error(`Expected ≤100 providers, got ${r.providers.length}`);
    console.log(`  Returned ${r.providers.length} providers (cap=100)`);
    return res;
  });

  await run("default limit=20 applied when omitted", async () => {
    if (!clPool && !v2Pool) return { skipped: "no pool discovered" };
    const poolAddress = (clPool ?? v2Pool)!.pairAddress;
    const res = await toolHandlers.get_pool_lp_providers({ poolAddress });
    const r = res as any;
    if (!r.success) throw new Error(`success=false: ${r.message}`);
    if (r.providers.length > 20) throw new Error(`Default limit exceeded: got ${r.providers.length} providers`);
    console.log(`  Default limit: ${r.providers.length} providers returned`);
    return res;
  });

  await run("poolAddress normalised to lowercase in response", async () => {
    if (!clPool && !v2Pool) return { skipped: "no pool discovered" };
    const poolAddress = (clPool ?? v2Pool)!.pairAddress;
    const res = await toolHandlers.get_pool_lp_providers({ poolAddress: poolAddress.toUpperCase() });
    const r = res as any;
    if (!r.success) throw new Error(`success=false: ${r.message}`);
    if (r.poolAddress !== poolAddress.toLowerCase()) {
      throw new Error(`Expected lowercase poolAddress, got: ${r.poolAddress}`);
    }
    return res;
  });

  summary("get_pool_lp_providers");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
