// Smoke test: vote_leaderboard and get_epoch_state handlers.
import { toolHandlers } from "../src/toolHandlers.js";
import { makeRunner } from "./_helpers.js";
export {};

const { run, summary } = makeRunner();

async function main() {
  console.log("🚀 vote_leaderboard + get_epoch_state smoke test…\n");

  // ── get_epoch_state ────────────────────────────────────────────────────────

  await run("get_epoch_state", async () => {
    const res = await toolHandlers.get_epoch_state({});
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    if (typeof r.epochNumber !== "number") throw new Error("epochNumber missing");
    if (typeof r.epochStart !== "string") throw new Error("epochStart missing");
    if (typeof r.epochEnd !== "string") throw new Error("epochEnd missing");
    if (typeof r.secondsRemaining !== "number") throw new Error("secondsRemaining missing");
    if (typeof r.scheduledWeeklyEmissions !== "string") throw new Error("scheduledWeeklyEmissions missing");
    console.log(
      `  epoch #${r.epochNumber} | ${r.epochStart} → ${r.epochEnd} | ${r.timeRemaining} remaining | ${r.scheduledWeeklyEmissions} BLACK`,
    );
    return res;
  });

  // ── vote_leaderboard defaults ──────────────────────────────────────────────

  await run("vote_leaderboard top 10 (default: sortBy=votes)", async () => {
    const res = await toolHandlers.vote_leaderboard({ topN: 10 });
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    if (!Array.isArray(r.data)) throw new Error("data is not array");
    if (r.data.length === 0) throw new Error("no gauges returned");

    const first = r.data[0];
    if (typeof first.poolAddress !== "string") throw new Error("poolAddress missing");
    if (typeof first.gaugeAddress !== "string") throw new Error("gaugeAddress missing");
    if (typeof first.votes !== "number") throw new Error("votes missing");
    if (typeof first.vapr !== "number") throw new Error("vapr missing");
    if (typeof first.emissionsUsdPerEpoch !== "number") throw new Error("emissionsUsdPerEpoch missing");
    if (!Array.isArray(first.rewardTokens)) throw new Error("rewardTokens is not array");

    // Verify sorted descending by votes
    for (let i = 1; i < r.data.length; i++) {
      if (r.data[i].votes > r.data[i - 1].votes) {
        throw new Error(`Not sorted by votes desc: index ${i} has more votes than ${i - 1}`);
      }
    }

    console.log(`  ${r.data.length} gauges returned out of ${r.meta.totalGaugesScanned} scanned`);
    for (const g of r.data.slice(0, 3)) {
      const rwds = g.rewardTokens.map((t: any) => `${t.symbol}($${t.usdPerEpoch})`).join(", ") || "(none)";
      console.log(`  ${g.symbol.padEnd(28)} votes=${String(g.votes.toFixed(0)).padStart(14)} vAPR=${String(g.vapr.toFixed(1)).padStart(6)}%  rewards: ${rwds}`);
    }
    return res;
  });

  // ── sort by vapr ───────────────────────────────────────────────────────────

  await run("vote_leaderboard sortBy=vapr top 5", async () => {
    const res = await toolHandlers.vote_leaderboard({ topN: 5, sortBy: "vapr" });
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    if (!Array.isArray(r.data)) throw new Error("data is not array");

    for (let i = 1; i < r.data.length; i++) {
      if (r.data[i].vapr > r.data[i - 1].vapr) {
        throw new Error(`Not sorted by vapr desc: index ${i} has higher vapr than ${i - 1}`);
      }
    }
    return res;
  });

  // ── sort by emissionsUsd ───────────────────────────────────────────────────

  await run("vote_leaderboard sortBy=emissionsUsd top 5", async () => {
    const res = await toolHandlers.vote_leaderboard({ topN: 5, sortBy: "emissionsUsd" });
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    return res;
  });

  // ── pool type filter ───────────────────────────────────────────────────────

  await run("vote_leaderboard poolType=basic", async () => {
    const res = await toolHandlers.vote_leaderboard({ topN: 5, poolType: "basic" });
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    for (const g of r.data) {
      if (g.poolType === "concentrated") {
        throw new Error(`CL pool returned when poolType=basic: ${g.symbol}`);
      }
    }
    return res;
  });

  await run("vote_leaderboard poolType=concentrated", async () => {
    const res = await toolHandlers.vote_leaderboard({ topN: 5, poolType: "concentrated" });
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    for (const g of r.data) {
      if (g.poolType !== "concentrated") {
        throw new Error(`Non-CL pool returned when poolType=concentrated: ${g.symbol}`);
      }
    }
    return res;
  });

  // ── minVotesUsd filter (vote-weight floor; not TVL) ─────────────────────────

  await run("vote_leaderboard minVotesUsd=100000", async () => {
    const res = await toolHandlers.vote_leaderboard({ topN: 10, minVotesUsd: 100000 });
    const r = res as any;
    if (!r.success) throw new Error("success=false");
    for (const g of r.data) {
      if (g.votesUsd < 100000) {
        throw new Error(`Gauge ${g.symbol} has votesUsd=${g.votesUsd} below minVotesUsd=100000`);
      }
    }
    return res;
  });

  // ── reward tokens shape ────────────────────────────────────────────────────

  await run("vote_leaderboard rewardTokens shape", async () => {
    const res = await toolHandlers.vote_leaderboard({ topN: 20, minVotesUsd: 1 });
    const r = res as any;
    if (!r.success) throw new Error("success=false");

    let gaugesWithRewards = 0;
    for (const g of r.data) {
      for (const rt of g.rewardTokens) {
        if (typeof rt.address !== "string") throw new Error(`rewardToken.address missing in ${g.symbol}`);
        if (typeof rt.symbol !== "string") throw new Error(`rewardToken.symbol missing in ${g.symbol}`);
        if (typeof rt.amountPerEpoch !== "string") throw new Error(`rewardToken.amountPerEpoch missing in ${g.symbol}`);
        if (typeof rt.usdPerEpoch !== "string") throw new Error(`rewardToken.usdPerEpoch missing in ${g.symbol}`);
        if (rt.type !== "fee" && rt.type !== "bribe") throw new Error(`rewardToken.type invalid: ${rt.type}`);
      }
      if (g.rewardTokens.length > 0) gaugesWithRewards++;
    }
    console.log(`  ${gaugesWithRewards}/${r.data.length} gauges have explicit reward tokens`);
    return res;
  });

  summary("vote_leaderboard + get_epoch_state");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
