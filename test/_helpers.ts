// Shared helpers for split smoke tests.
// Exports: common token/user constants, a `run()` wrapper, and `discoverPools()`.

import { toolHandlers } from "../src/toolHandlers.js";

export const WAVAX = "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7";
export const USDC = "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E";
export const WAVAX_DEC = 18;
export const USDC_DEC = 6;

export const USER = "0x1234567890123456789012345678901234567890";

export const REAL_VENFT_TOKEN_ID = 1;
export const REAL_CL_POSITION_TOKEN_ID = 1;
export const CL_DEPLOYER = "0x0000000000000000000000000000000000000000";
export const BONUS_REWARD_TOKEN = "0x0000000000000000000000000000000000000000";
export const PLACEHOLDER_BRIBE = "0x0000000000000000000000000000000000000001";

export type Result = { name: string; ok: boolean; error?: string; preview?: string };

export function makeRunner() {
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
  function summary(label: string) {
    const passed = results.filter((r) => r.ok).length;
    const failed = results.length - passed;
    console.log(`\n───── ${label} ─────`);
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
  return { run, results, summary };
}

export type DiscoveredPool = {
  pairAddress: string;
  symbol: string;
  stable: boolean;
  token0: { address: string; symbol: string; decimals: number };
  token1: { address: string; symbol: string; decimals: number };
};

// Pick the top v2 and CL pool by TVL. Returns tokens so pair-dependent tests
// can use the actual pair's tokens instead of hard-coded WAVAX/USDC.
export async function discoverPools() {
  const v2 = await toolHandlers.pool_yield({
    poolType: "basic",
    topN: 10,
    sortBy: "tvlUsd",
  });
  const cl = await toolHandlers.pool_yield({
    poolType: "concentrated",
    topN: 10,
    sortBy: "tvlUsd",
  });

  const v2Top = (v2 as any)?.data?.[0];
  const clTop = (cl as any)?.data?.[0];

  const v2Pool: DiscoveredPool | undefined = v2Top && {
    pairAddress: v2Top.pairAddress,
    symbol: v2Top.symbol,
    stable: v2Top.poolType === "stable",
    token0: v2Top.token0,
    token1: v2Top.token1,
  };
  const clPool: DiscoveredPool | undefined = clTop && {
    pairAddress: clTop.pairAddress,
    symbol: clTop.symbol,
    stable: false,
    token0: clTop.token0,
    token1: clTop.token1,
  };

  return { v2Pool, clPool };
}
