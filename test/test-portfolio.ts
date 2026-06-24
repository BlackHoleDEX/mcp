// Smoke test: portfolio handlers.
import { toolHandlers } from "../src/toolHandlers.js";
import { USER, makeRunner } from "./_helpers.js";
export {};

const { run, summary } = makeRunner();

async function main() {
  console.log("🚀 portfolio smoke test…\n");

  await run("get_whitelisted_tokens", () =>
    toolHandlers.get_whitelisted_tokens({}),
  );

  await run("get_token_balances (dummy user)", () =>
    toolHandlers.get_token_balances({ userAddress: USER }),
  );

  await run("get_user_positions (dummy user)", () =>
    toolHandlers.get_user_positions({ userAddress: USER }),
  );

  await run("get_user_locks (dummy user)", () =>
    toolHandlers.get_user_locks({ userAddress: USER }),
  );

  summary("portfolio");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
