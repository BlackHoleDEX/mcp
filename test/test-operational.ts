// Smoke test: get_allowances, get_pool_status, get_opportunities handlers.
import { toolHandlers } from "../src/toolHandlers.js";
import { discoverPools, makeRunner } from "./_helpers.js";
export {};

const { run, summary } = makeRunner();

// A real protocol-owned address known to have DEX allowances (voting escrow)
const PROTOCOL_ADDR = "0xEac562811cc6abDbB2c9EE88719eCA4eE79Ad763";
// A well-known zero-activity address for risk flag baseline
const ZERO_ADDR = "0x0000000000000000000000000000000000000001";

async function main() {
  console.log("🚀 operational tools smoke test (get_allowances, get_pool_status, get_opportunities)…\n");

  // ── get_allowances ─────────────────────────────────────────────────────────

  await run("get_allowances (all spenders, default tokens, no zero)", async () => {
    const res = await toolHandlers.get_allowances({
      userAddress: PROTOCOL_ADDR,
      includeZero: false,
    });
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    if (!Array.isArray(r.allowances)) throw new Error("allowances not array");
    if (!r.spenders || typeof r.spenders !== "object") throw new Error("spenders missing");
    console.log(`  ${r.allowances.length} non-zero allowances across ${Object.keys(r.spenders).length} spenders`);
    for (const a of r.allowances.slice(0, 3)) {
      console.log(`  ${(a.symbol ?? "?").padEnd(12)} spender=${a.spenderName.padEnd(15)} allowance=${a.allowance}`);
    }
    return res;
  });

  await run("get_allowances single spender (router)", async () => {
    const res = await toolHandlers.get_allowances({
      userAddress: PROTOCOL_ADDR,
      spenders: ["router"],
      includeZero: false,
    });
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    // All returned allowances must be for the router spender
    for (const a of r.allowances) {
      if (a.spenderName !== "router") throw new Error(`Unexpected spenderName: ${a.spenderName}`);
    }
    return res;
  });

  await run("get_allowances specific tokens", async () => {
    const res = await toolHandlers.get_allowances({
      userAddress: PROTOCOL_ADDR,
      tokens: [
        "0xB31f66AA3C1e785363F0875A1B74E27b85FD66c7", // WAVAX
        "0xB97EF9Ef8734C71904D8002F8b6Bc66Dd9c48a6E", // USDC
      ],
      includeZero: true,
    });
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    if (!Array.isArray(r.allowances)) throw new Error("allowances not array");
    // Should check at most 2 tokens × N spenders
    if (r.allowances.length > 10) throw new Error(`Unexpected allowance count: ${r.allowances.length}`);
    return res;
  });

  await run("get_allowances invalid spender throws", async () => {
    try {
      await toolHandlers.get_allowances({
        userAddress: PROTOCOL_ADDR,
        spenders: ["not_a_real_spender"],
      });
      throw new Error("Should have thrown for invalid spender");
    } catch (err: any) {
      if (!err.message.includes("No valid spenders")) throw err;
      return { skipped: "correctly threw for invalid spender" };
    }
  });

  // ── get_pool_status ────────────────────────────────────────────────────────

  const { v2Pool, clPool } = await discoverPools();

  if (v2Pool) {
    await run(`get_pool_status V2 pool (${v2Pool.symbol})`, async () => {
      const res = await toolHandlers.get_pool_status({ poolAddress: v2Pool.pairAddress });
      const r = res as any;
      if (!r.success) throw new Error("success=false");
      if (typeof r.symbol !== "string") throw new Error("symbol missing");
      if (!["stable", "volatile"].includes(r.poolType)) throw new Error(`Bad poolType: ${r.poolType}`);
      if (typeof r.gauge?.hasGauge !== "boolean") throw new Error("gauge.hasGauge missing");
      if (typeof r.gauge?.isActive !== "boolean") throw new Error("gauge.isActive missing");
      if (!r.token0?.address) throw new Error("token0.address missing");
      if (!r.token1?.address) throw new Error("token1.address missing");
      if (typeof r.emissions?.epochAmount !== "string") throw new Error("emissions.epochAmount missing");
      console.log(
        `  ${r.symbol} | ${r.poolType} | gauge=${r.gauge.hasGauge ? (r.gauge.isActive ? "active" : "inactive") : "none"} | tvl=$${r.tvlUsd} | votes=${r.votes}`,
      );
      return res;
    });
  }

  if (clPool) {
    await run(`get_pool_status CL pool (${clPool.symbol})`, async () => {
      const res = await toolHandlers.get_pool_status({ poolAddress: clPool.pairAddress });
      const r = res as any;
      if (!r.success) throw new Error("success=false");
      if (r.poolType !== "concentrated") throw new Error(`Expected concentrated, got ${r.poolType}`);
      if (typeof r.gauge?.hasGauge !== "boolean") throw new Error("gauge.hasGauge missing");
      if (typeof r.cl?.tick !== "number") throw new Error("cl.tick missing");
      if (typeof r.cl?.feePercent !== "number") throw new Error("cl.feePercent missing");
      console.log(
        `  ${r.symbol} | ${r.poolType} | gauge=${r.gauge.hasGauge ? (r.gauge.isActive ? "active" : "inactive") : "none"} | tick=${r.cl.tick} | fee=${r.cl.feePercent}%`,
      );
      return res;
    });
  }

  await run("get_pool_status unknown address returns success=false", async () => {
    const res = await toolHandlers.get_pool_status({
      poolAddress: "0x0000000000000000000000000000000000000001",
    });
    const r = res as any;
    if (r.success !== false) throw new Error("Expected success=false for unknown pool");
    return res;
  });

  // ── get_opportunities ─────────────────────────────────────────────────────────

  await run("get_opportunities zero-activity address (none)", async () => {
    const res = await toolHandlers.get_opportunities({ userAddress: ZERO_ADDR });
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    if (!Array.isArray(r.opportunities)) throw new Error("opportunities not array");
    if (typeof r.count !== "number") throw new Error("count missing");
    console.log(`  ${r.count} items for zero-activity address`);
    return res;
  });

  await run("get_opportunities shape validation", async () => {
    const res = await toolHandlers.get_opportunities({ userAddress: PROTOCOL_ADDR });
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    if (!Array.isArray(r.opportunities)) throw new Error("opportunities not array");
    const validPriorities = ["high", "medium", "low"];
    const validTypes = ["expiring_lock", "expired_lock", "oor_position", "unvoted_lock", "vote_review", "rebase_unclaimed"];
    for (const o of r.opportunities) {
      if (!validPriorities.includes(o.priority)) throw new Error(`Invalid priority: ${o.priority}`);
      if (!validTypes.includes(o.type)) throw new Error(`Invalid type: ${o.type}`);
      if (typeof o.message !== "string") throw new Error("opportunity.message missing");
    }
    // Verify sorted high→medium→low
    const order: Record<string, number> = { high: 0, medium: 1, low: 2 };
    for (let i = 1; i < r.opportunities.length; i++) {
      if (order[r.opportunities[i].priority] < order[r.opportunities[i - 1].priority]) {
        throw new Error(`Not sorted by priority at index ${i}`);
      }
    }
    console.log(`  ${r.count} items: ${r.message}`);
    for (const o of r.opportunities.slice(0, 3)) {
      console.log(`  [${o.priority}] ${o.type} — ${o.message}`);
    }
    return res;
  });

  summary("get_allowances + get_pool_status + get_opportunities");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
