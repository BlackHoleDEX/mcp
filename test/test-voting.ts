// Smoke test: voting + voting rewards handlers.
import { toolHandlers } from "../src/toolHandlers.js";
import {
  WAVAX,
  USER,
  REAL_VENFT_TOKEN_ID,
  PLACEHOLDER_BRIBE,
  discoverPools,
  makeRunner,
} from "./_helpers.js";
export {};

const { run, summary } = makeRunner();

async function main() {
  console.log("🚀 voting smoke test…\n");

  const { v2Pool } = await discoverPools();

  if (v2Pool) {
    await run(`vote_steps vote (${v2Pool.symbol})`, () =>
      toolHandlers.vote_steps({
        action: "vote",
        userAddress: USER,
        tokenId: REAL_VENFT_TOKEN_ID,
        poolAddresses: [v2Pool.pairAddress],
        poolWeights: [100],
      }),
    );
  } else {
    console.log("\n⚠︎ No v2 pair discovered — skipping vote action.");
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

  await run("claim_voting_rewards_payload (dummy user — expected empty)", () =>
    toolHandlers.claim_voting_rewards_payload({
      userAddress: USER,
      tokenId: REAL_VENFT_TOKEN_ID,
    }),
  );

  summary("voting");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
