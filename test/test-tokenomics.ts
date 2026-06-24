// Smoke test: get_tokenomics handler.
import { toolHandlers } from "../src/toolHandlers.js";
import { makeRunner } from "./_helpers.js";
export {};

const { run, summary } = makeRunner();

async function main() {
  console.log("🚀 get_tokenomics smoke test…\n");

  // ── basic shape ────────────────────────────────────────────────────────────

  await run("get_tokenomics returns expected fields", async () => {
    const res = await toolHandlers.get_tokenomics({});
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    if (r.token !== "BLACK") throw new Error(`unexpected token: ${r.token}`);
    if (typeof r.address !== "string" || !r.address.startsWith("0x")) throw new Error("address missing/invalid");
    if (typeof r.totalSupply !== "string") throw new Error("totalSupply missing");
    if (typeof r.circulatingSupply !== "string") throw new Error("circulatingSupply missing");
    if (typeof r.totalLockedBlack !== "string") throw new Error("totalLockedBlack missing");
    if (typeof r.lockRatio !== "string") throw new Error("lockRatio missing");
    if (typeof r.currentEpoch !== "number") throw new Error("currentEpoch missing");
    if (typeof r.emissionPhase !== "string") throw new Error("emissionPhase missing");
    if (typeof r.currentEpochEmissions !== "string") throw new Error("currentEpochEmissions missing");
    if (!Array.isArray(r.emissionsScheduleNext10Epochs)) throw new Error("emissionsScheduleNext10Epochs not array");
    console.log(`  totalSupply=${r.totalSupply} | circulatingSupply=${r.circulatingSupply} | totalLockedBlack=${r.totalLockedBlack} | lockRatio=${r.lockRatio}`);
    console.log(`  epoch #${r.currentEpoch} | phase: ${r.emissionPhase}`);
    console.log(`  currentEpochEmissions=${r.currentEpochEmissions} BLACK`);
    console.log(`  blackPriceUsd=${r.blackPriceUsd ?? "unavailable"} | marketCap=${r.marketCapUsd ?? "unavailable"} | fdv=${r.fdvUsd ?? "unavailable"}`);
    return res;
  });

  // ── supply sanity ──────────────────────────────────────────────────────────

  await run("circulatingSupply < totalSupply (locked + burned tokens exist)", async () => {
    const res = await toolHandlers.get_tokenomics({});
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    const total = Number(r.totalSupply.replace(/,/g, ""));
    const circ = Number(r.circulatingSupply.replace(/,/g, ""));
    if (total <= 0) throw new Error(`totalSupply must be > 0, got ${total}`);
    if (circ <= 0) throw new Error(`circulatingSupply must be > 0, got ${circ}`);
    if (circ >= total) throw new Error(`circulatingSupply (${circ}) must be < totalSupply (${total})`);
    const lockedPct = ((total - circ) / total * 100).toFixed(1);
    console.log(`  total=${total.toLocaleString()} | circ=${circ.toLocaleString()} | non-circulating=${lockedPct}%`);
    return res;
  });

  // ── lock ratio sanity ─────────────────────────────────────────────────────

  await run("totalLockedBlack > 0 and lockRatio in 0–100%", async () => {
    const res = await toolHandlers.get_tokenomics({});
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    const locked = Number(r.totalLockedBlack.replace(/,/g, ""));
    const ratio = parseFloat(r.lockRatio);
    if (locked <= 0) throw new Error(`totalLockedBlack must be > 0, got ${locked}`);
    if (ratio <= 0 || ratio >= 100) throw new Error(`lockRatio out of range: ${r.lockRatio}`);
    // locked ≤ totalSupply
    const total = Number(r.totalSupply.replace(/,/g, ""));
    if (locked > total) throw new Error(`totalLockedBlack (${locked}) > totalSupply (${total})`);
    console.log(`  totalLockedBlack=${locked.toLocaleString()} | lockRatio=${r.lockRatio}`);
    return res;
  });

  // ── market cap / fdv ordering ──────────────────────────────────────────────

  await run("marketCapUsd <= fdvUsd when price is available", async () => {
    const res = await toolHandlers.get_tokenomics({});
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    if (r.marketCapUsd === null || r.fdvUsd === null) {
      console.log("  price feed unavailable — skipping marketCap/fdv ordering check");
      return res;
    }
    const mcap = Number(r.marketCapUsd.replace(/,/g, ""));
    const fdv = Number(r.fdvUsd.replace(/,/g, ""));
    if (mcap > fdv) throw new Error(`marketCap (${mcap}) > fdv (${fdv}); circulating should be ≤ total supply`);
    console.log(`  marketCap=$${mcap.toLocaleString()} | fdv=$${fdv.toLocaleString()}`);
    return res;
  });

  // ── emissions schedule shape ───────────────────────────────────────────────

  await run("emissionsSchedule has 10 entries with correct shape", async () => {
    const res = await toolHandlers.get_tokenomics({});
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    const schedule = r.emissionsScheduleNext10Epochs;
    if (schedule.length !== 10) throw new Error(`Expected 10 entries, got ${schedule.length}`);
    for (const entry of schedule) {
      if (typeof entry.epoch !== "number") throw new Error(`epoch not a number: ${JSON.stringify(entry)}`);
      if (typeof entry.emissionsBLACK !== "string") throw new Error(`emissionsBLACK not a string: ${JSON.stringify(entry)}`);
    }
    return res;
  });

  // ── emissions schedule continuity ─────────────────────────────────────────

  await run("emissionsSchedule epochs are consecutive starting from currentEpoch+1", async () => {
    const res = await toolHandlers.get_tokenomics({});
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    const schedule = r.emissionsScheduleNext10Epochs;
    const firstEpoch: number = schedule[0].epoch;
    if (firstEpoch !== r.currentEpoch + 1) {
      throw new Error(`First scheduled epoch ${firstEpoch} should be currentEpoch+1 (${r.currentEpoch + 1})`);
    }
    for (let i = 1; i < schedule.length; i++) {
      if (schedule[i].epoch !== schedule[i - 1].epoch + 1) {
        throw new Error(`Epoch gap at index ${i}: ${schedule[i - 1].epoch} → ${schedule[i].epoch}`);
      }
    }
    console.log(`  schedule: epochs ${schedule[0].epoch}–${schedule[schedule.length - 1].epoch}`);
    for (const e of schedule.slice(0, 5)) {
      console.log(`  epoch ${String(e.epoch).padStart(3)}: ${e.emissionsBLACK} BLACK`);
    }
    return res;
  });

  // ── emission phase consistency ─────────────────────────────────────────────

  await run("emissionPhase matches epochCount", async () => {
    const res = await toolHandlers.get_tokenomics({});
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    const epoch: number = r.currentEpoch;
    const phase: string = r.emissionPhase;
    if (epoch >= 67 && !phase.includes("tail")) {
      throw new Error(`epoch ${epoch} should be tail phase, got: ${phase}`);
    }
    if (epoch < 14 && !phase.includes("growth")) {
      throw new Error(`epoch ${epoch} should be growth phase, got: ${phase}`);
    }
    if (epoch >= 14 && epoch < 67 && !phase.includes("decay")) {
      throw new Error(`epoch ${epoch} should be decay phase, got: ${phase}`);
    }
    console.log(`  epoch=${epoch} → phase="${phase}" ✓`);
    return res;
  });

  summary("get_tokenomics");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
