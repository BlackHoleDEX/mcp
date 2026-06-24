// Smoke test: get_lock_vote_state handler.
import { toolHandlers } from "../src/toolHandlers.js";
import { REAL_VENFT_TOKEN_ID, makeRunner } from "./_helpers.js";
export {};

const { run, summary } = makeRunner();

async function main() {
  console.log("🚀 get_lock_vote_state smoke test…\n");

  // Basic query — uses the shared real veNFT token ID from helpers.
  await run(`get_lock_vote_state (tokenId=${REAL_VENFT_TOKEN_ID})`, () =>
    toolHandlers.get_lock_vote_state({
      tokenId: String(REAL_VENFT_TOKEN_ID),
    }),
  );

  // A second token to check a different lock (may have different vote state / lock type).
  await run("get_lock_vote_state (tokenId=2)", () =>
    toolHandlers.get_lock_vote_state({ tokenId: "2" }),
  );

  // Token with a higher ID — likely has active votes cast this epoch.
  await run("get_lock_vote_state (tokenId=10)", () =>
    toolHandlers.get_lock_vote_state({ tokenId: "10" }),
  );

  // Non-existent / burned token — should surface a contract error gracefully.
  await run("get_lock_vote_state (tokenId=999999 — expected error)", () =>
    toolHandlers.get_lock_vote_state({ tokenId: "999999" }),
  );

  summary("get_lock_vote_state");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
