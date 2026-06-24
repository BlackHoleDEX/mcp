// Smoke test: quote + swap handlers.
import { toolHandlers } from "../src/toolHandlers.js";
import {
  WAVAX,
  USDC,
  WAVAX_DEC,
  USDC_DEC,
  USER,
  makeRunner,
} from "./_helpers.js";
export {};

const { run, summary } = makeRunner();

async function main() {
  console.log("🚀 quote + swap smoke test…\n");

  await run("quote (WAVAX→USDC)", () =>
    toolHandlers.quote({
      tokenIn: WAVAX,
      tokenOut: USDC,
      amountIn: "10",
      tokenInDecimals: WAVAX_DEC,
      tokenOutDecimals: USDC_DEC,
    }),
  );

  await run("quote split (WAVAX→USDC, 100k)", () =>
    toolHandlers.quote({
      tokenIn: WAVAX,
      tokenOut: USDC,
      amountIn: "100000",
      tokenInDecimals: WAVAX_DEC,
      tokenOutDecimals: USDC_DEC,
      useSplitRoutes: true,
      distributionPercent: 10,
      maxSplits: 3,
      minSplits: 1,
    }),
  );

  await run("swap_steps (WAVAX→USDC)", () =>
    toolHandlers.swap_steps({
      tokenIn: WAVAX,
      tokenOut: USDC,
      amountIn: "10",
      amountOutMin: "0",
      userAddress: USER,
      tokenInDecimals: WAVAX_DEC,
      tokenOutDecimals: USDC_DEC,
    }),
  );

  summary("quote + swap");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
