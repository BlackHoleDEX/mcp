// Smoke test: gauge / bribe / CL-pool-creation handlers.
import { toolHandlers } from "../src/toolHandlers.js";
import {
  WAVAX,
  USDC,
  WAVAX_DEC,
  USDC_DEC,
  USER,
  CL_DEPLOYER,
  BONUS_REWARD_TOKEN,
  PLACEHOLDER_BRIBE,
  discoverPools,
  makeRunner,
} from "./_helpers.js";
export {};

const { run, summary } = makeRunner();

async function main() {
  console.log("🚀 gauge + bribe + pool-creation smoke test…\n");

  const { v2Pool } = await discoverPools();
  const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

  if (v2Pool) {
    await run(`resolve_address gauge (${v2Pool.symbol})`, () =>
      toolHandlers.resolve_address({
        kind: "gauge",
        poolAddress: v2Pool.pairAddress,
      }),
    );

    await run(`resolve_address pool_from_gauge (${v2Pool.symbol})`, async () => {
      const gaugeLookup = await toolHandlers.resolve_address({
        kind: "gauge",
        poolAddress: v2Pool.pairAddress,
      });
      const gaugeAddress = (gaugeLookup as any)?.address;
      if (!gaugeAddress || gaugeAddress === ZERO_ADDRESS) {
        throw new Error(`Pool ${v2Pool.pairAddress} has no gauge to reverse-resolve.`);
      }
      return toolHandlers.resolve_address({
        kind: "pool_from_gauge",
        gaugeAddress,
      });
    });

    await run(`create_gauge_steps (${v2Pool.symbol})`, () =>
      toolHandlers.create_gauge_steps({
        poolAddress: v2Pool.pairAddress,
        gaugeType: 0,
        bonusRewardToken: BONUS_REWARD_TOKEN,
        userAddress: USER,
      }),
    );
  } else {
    console.log("\n⚠︎ No v2 pair discovered — skipping create_gauge_steps.");
  }

  await run("add_bribes_steps", () =>
    toolHandlers.add_bribes_steps({
      bribeAddress: PLACEHOLDER_BRIBE,
      rewardToken: WAVAX,
      amount: "1",
      amountDecimals: WAVAX_DEC,
      userAddress: USER,
    }),
  );

  await run("create_cl_pool_steps (WAVAX/USDC)", () =>
    toolHandlers.create_cl_pool_steps({
      creator: USER,
      tokenA: WAVAX,
      tokenB: USDC,
      deployerAddress: CL_DEPLOYER,
      initialPrice: "30",
      tokenADecimals: WAVAX_DEC,
      tokenBDecimals: USDC_DEC,
      userAddress: USER,
    }),
  );

  summary("gauge / bribe / pool creation");
}

main().catch((err) => {
  console.error("Fatal:", err);
  process.exit(1);
});
