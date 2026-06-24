// Smoke test: claim_emissions_steps for V2 and CL positions.
// Uses get_user_positions to discover staked positions, then exercises claim steps.
import { toolHandlers } from "../src/toolHandlers.js";
import { discoverPools, makeRunner } from "./_helpers.js";
export {};

const TEST_USER = "0x12227CE1Ee9674405b76747402718ee7Ad94Eeb5";

const { run, summary } = makeRunner();

async function main() {
  console.log(`🚀 claim_emissions smoke test for ${TEST_USER}\n`);

  // 1. Get user positions to discover staked pools and tokenIds
  let positions: any = null;
  await run("get_user_positions", async () => {
    positions = await toolHandlers.get_user_positions({ userAddress: TEST_USER });
    return positions;
  });

  const v2Staked = (positions?.v2Positions ?? []).filter(
    (p: any) => Number(p.pendingEmissions ?? 0) > 0 || Number(p.stakedBalance ?? 0) > 0,
  );
  const clStaked = (positions?.clPositions ?? []).filter(
    (p: any) => Number(p.pendingEmissions ?? 0) > 0,
  );

  console.log(`\nV2 positions with emissions: ${v2Staked.length}`);
  console.log(`CL positions with emissions: ${clStaked.length}`);

  // 2. V2 claim steps
  if (v2Staked.length > 0) {
    const p = v2Staked[0];
    await run(`claim_emissions_steps v2 (${p.symbol ?? p.poolAddress})`, () =>
      toolHandlers.claim_emissions_steps({
        mode: "v2",
        poolAddress: p.poolAddress ?? p.pairAddress,
        userAddress: TEST_USER,
      }),
    );
  } else {
    // Fallback: use discovered v2 pool
    const { v2Pool } = await discoverPools();
    if (v2Pool) {
      await run(`claim_emissions_steps v2 fallback (${v2Pool.symbol})`, () =>
        toolHandlers.claim_emissions_steps({
          mode: "v2",
          poolAddress: v2Pool.pairAddress,
          userAddress: TEST_USER,
        }),
      );
    } else {
      console.log("\n⚠︎ No v2 positions or pools found — skipping v2 claim test.");
    }
  }

  // 3. CL claim steps
  for (const p of clStaked) {
    const tokenId = p.tokenId ?? p.id;
    await run(`claim_emissions_steps cl tokenId=${tokenId} (${p.symbol ?? p.poolAddress})`, () =>
      toolHandlers.claim_emissions_steps({
        mode: "cl",
        poolAddress: p.poolAddress,
        userAddress: TEST_USER,
        tokenId: Number(tokenId),
        isBonusReward: false,
      }),
    );
  }

  if (clStaked.length === 0) {
    console.log("\n⚠︎ No CL positions with pending emissions found for this user.");
    // Fallback: use discovered CL pool with tokenId=1 to at least exercise the code path
    const { clPool } = await discoverPools();
    if (clPool) {
      await run(`claim_emissions_steps cl fallback (${clPool.symbol}) — gauge/key resolution only`, () =>
        toolHandlers.claim_emissions_steps({
          mode: "cl",
          poolAddress: clPool.pairAddress,
          userAddress: TEST_USER,
          tokenId: 1,
          isBonusReward: false,
        }),
      );
    }
  }

  summary("claim_emissions smoke test");
}

main().catch(console.error);
