// Smoke test: veNFT lock handlers.
import { toolHandlers } from "../src/toolHandlers.js";
import { USER, REAL_VENFT_TOKEN_ID, makeRunner } from "./_helpers.js";
export {};

const { run, summary } = makeRunner();

async function main() {
  console.log("🚀 locks smoke test…\n");

  await run("create_lock_steps", () =>
    toolHandlers.create_lock_steps({
      userAddress: USER,
      amount: "100",
      lockDurationInSeconds: 60 * 60 * 24 * 365,
      isSMNFT: false,
    }),
  );

  await run("increase_lock_steps", () =>
    toolHandlers.increase_lock_steps({
      userAddress: USER,
      tokenId: REAL_VENFT_TOKEN_ID,
      amount: "50",
    }),
  );

  await run("merge_lock_steps", () =>
    toolHandlers.merge_lock_steps({
      userAddress: USER,
      fromTokenId: REAL_VENFT_TOKEN_ID,
      toTokenId: REAL_VENFT_TOKEN_ID + 1,
    }),
  );

  await run("lock_advanced_steps extend", () =>
    toolHandlers.lock_advanced_steps({
      action: "extend",
      userAddress: USER,
      tokenId: REAL_VENFT_TOKEN_ID,
      lockDurationInSeconds: 60 * 60 * 24 * 365,
    }),
  );

  await run("lock_advanced_steps withdraw", () =>
    toolHandlers.lock_advanced_steps({
      action: "withdraw",
      userAddress: USER,
      tokenId: REAL_VENFT_TOKEN_ID,
    }),
  );

  await run("lock_advanced_steps lockPermanent", () =>
    toolHandlers.lock_advanced_steps({
      action: "lockPermanent",
      userAddress: USER,
      tokenId: REAL_VENFT_TOKEN_ID,
    }),
  );

  await run("lock_advanced_steps unlockPermanent", () =>
    toolHandlers.lock_advanced_steps({
      action: "unlockPermanent",
      userAddress: USER,
      tokenId: REAL_VENFT_TOKEN_ID,
    }),
  );

  summary("locks");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
