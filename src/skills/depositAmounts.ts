import BigNumber from "bignumber.js";
import { formatUnits, parseUnits } from "viem";

import {
  BLACKHOLE_PAIR_ABI,
  BLACKHOLE_PAIR_API_V2_ADDRESS,
} from "../constants/contracts.js";
import { SERVER_CONFIG } from "../config.js";
import { sqrtRatioAtTickX96 } from "../utils/clMath.js";
import { publicClient } from "../utils/viemClient.js";

const Q96_BN = new BigNumber(2).pow(96);

// ── Basic V2 ─────────────────────────────────────────────────────────────────

async function fetchBasicPair(poolAddress: string) {
  const pair = (await publicClient.readContract({
    address: BLACKHOLE_PAIR_API_V2_ADDRESS as `0x${string}`,
    abi: BLACKHOLE_PAIR_ABI,
    functionName: "getPair",
    // second arg is user address for LP balance — use pool address as dummy
    args: [poolAddress as `0x${string}`, poolAddress as `0x${string}`],
  })) as any;

  return {
    token0: (pair.token0 ?? pair[6] ?? "").toLowerCase() as string,
    token1: (pair.token1 ?? pair[11] ?? "").toLowerCase() as string,
    token0Decimals: Number(pair.token0_decimals ?? pair[8] ?? 18),
    token1Decimals: Number(pair.token1_decimals ?? pair[13] ?? 18),
    token0Symbol: String(pair.token0_symbol ?? pair[7] ?? "token0"),
    token1Symbol: String(pair.token1_symbol ?? pair[12] ?? "token1"),
    reserve0: BigInt((pair.reserve0 ?? pair[9] ?? 0).toString()),
    reserve1: BigInt((pair.reserve1 ?? pair[14] ?? 0).toString()),
  };
}

async function getBasicDepositAmounts(
  poolAddress: string,
  inputToken: string,
  inputAmount: string,
) {
  const p = await fetchBasicPair(poolAddress);

  if (p.reserve0 === 0n || p.reserve1 === 0n) {
    throw new Error("Pool has no reserves — cannot compute deposit ratio.");
  }

  const inputLower = inputToken.toLowerCase();
  const isToken0 = inputLower === p.token0;
  const isToken1 = inputLower === p.token1;
  if (!isToken0 && !isToken1) {
    throw new Error(`inputToken ${inputToken} is not in pool ${poolAddress}.`);
  }

  if (isToken0) {
    const inRaw = parseUnits(inputAmount, p.token0Decimals);
    const outRaw = (inRaw * p.reserve1) / p.reserve0;
    return {
      token0: { address: p.token0, symbol: p.token0Symbol, decimals: p.token0Decimals },
      token1: { address: p.token1, symbol: p.token1Symbol, decimals: p.token1Decimals },
      amount0: inputAmount,
      amount1: formatUnits(outRaw, p.token1Decimals),
    };
  } else {
    const inRaw = parseUnits(inputAmount, p.token1Decimals);
    const outRaw = (inRaw * p.reserve0) / p.reserve1;
    return {
      token0: { address: p.token0, symbol: p.token0Symbol, decimals: p.token0Decimals },
      token1: { address: p.token1, symbol: p.token1Symbol, decimals: p.token1Decimals },
      amount0: formatUnits(outRaw, p.token0Decimals),
      amount1: inputAmount,
    };
  }
}

// ── CL ───────────────────────────────────────────────────────────────────────

async function fetchCLPool(poolAddress: string) {
  const res = await fetch(SERVER_CONFIG.CL_GRAPH_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      query: `{
        pool(id: "${poolAddress.toLowerCase()}") {
          id tick sqrtPrice
          token0 { id symbol decimals }
          token1 { id symbol decimals }
        }
      }`,
    }),
  });
  const json = (await res.json()) as any;
  const p = json?.data?.pool;
  if (!p) throw new Error(`CL pool ${poolAddress} not found in subgraph.`);
  return {
    token0: p.token0.id.toLowerCase() as string,
    token1: p.token1.id.toLowerCase() as string,
    token0Symbol: p.token0.symbol as string,
    token1Symbol: p.token1.symbol as string,
    token0Decimals: Number(p.token0.decimals),
    token1Decimals: Number(p.token1.decimals),
    tick: Number(p.tick),
    sqrtPriceX96: p.sqrtPrice as string,
  };
}

async function getCLDepositAmounts(
  poolAddress: string,
  inputToken: string,
  inputAmount: string,
  tickLower: number,
  tickUpper: number,
) {
  if (tickLower >= tickUpper) throw new Error("tickLower must be less than tickUpper.");

  const p = await fetchCLPool(poolAddress);

  const inputLower = inputToken.toLowerCase();
  const isToken0 = inputLower === p.token0;
  const isToken1 = inputLower === p.token1;
  if (!isToken0 && !isToken1) {
    throw new Error(`inputToken ${inputToken} is not in pool ${poolAddress}.`);
  }

  // Below range → 100% token0
  if (p.tick < tickLower) {
    if (isToken1) {
      return {
        token0: { address: p.token0, symbol: p.token0Symbol, decimals: p.token0Decimals },
        token1: { address: p.token1, symbol: p.token1Symbol, decimals: p.token1Decimals },
        amount0: "0", amount1: "0",
        positionState: "below_range",
        note: `Tick ${p.tick} < tickLower ${tickLower}: position is 100% ${p.token0Symbol}. Cannot deposit ${p.token1Symbol} here.`,
      };
    }
    return {
      token0: { address: p.token0, symbol: p.token0Symbol, decimals: p.token0Decimals },
      token1: { address: p.token1, symbol: p.token1Symbol, decimals: p.token1Decimals },
      amount0: inputAmount, amount1: "0",
      positionState: "below_range",
      note: `Tick ${p.tick} < tickLower ${tickLower}: position is 100% ${p.token0Symbol}. No ${p.token1Symbol} needed.`,
    };
  }

  // Above range → 100% token1
  if (p.tick >= tickUpper) {
    if (isToken0) {
      return {
        token0: { address: p.token0, symbol: p.token0Symbol, decimals: p.token0Decimals },
        token1: { address: p.token1, symbol: p.token1Symbol, decimals: p.token1Decimals },
        amount0: "0", amount1: "0",
        positionState: "above_range",
        note: `Tick ${p.tick} >= tickUpper ${tickUpper}: position is 100% ${p.token1Symbol}. Cannot deposit ${p.token0Symbol} here.`,
      };
    }
    return {
      token0: { address: p.token0, symbol: p.token0Symbol, decimals: p.token0Decimals },
      token1: { address: p.token1, symbol: p.token1Symbol, decimals: p.token1Decimals },
      amount0: "0", amount1: inputAmount,
      positionState: "above_range",
      note: `Tick ${p.tick} >= tickUpper ${tickUpper}: position is 100% ${p.token1Symbol}. No ${p.token0Symbol} needed.`,
    };
  }

  // In range — inverse liquidity math
  const sqrtP = new BigNumber(p.sqrtPriceX96);
  const sqrtL = sqrtRatioAtTickX96(tickLower);
  const sqrtU = sqrtRatioAtTickX96(tickUpper);

  let amount0: string;
  let amount1: string;

  if (isToken0) {
    const inRaw = new BigNumber(parseUnits(inputAmount, p.token0Decimals).toString());
    // L = amount0 * sqrtP * sqrtU / ((sqrtU - sqrtP) * Q96)
    const L = inRaw.multipliedBy(sqrtP).multipliedBy(sqrtU)
      .dividedBy(sqrtU.minus(sqrtP).multipliedBy(Q96_BN));
    // amount1 = L * (sqrtP - sqrtL) / Q96
    const outRaw = L.multipliedBy(sqrtP.minus(sqrtL)).dividedBy(Q96_BN)
      .integerValue(BigNumber.ROUND_DOWN);
    amount0 = inputAmount;
    amount1 = formatUnits(BigInt(outRaw.toFixed(0)), p.token1Decimals);
  } else {
    const inRaw = new BigNumber(parseUnits(inputAmount, p.token1Decimals).toString());
    // L = amount1 * Q96 / (sqrtP - sqrtL)
    const L = inRaw.multipliedBy(Q96_BN).dividedBy(sqrtP.minus(sqrtL));
    // amount0 = L * (sqrtU - sqrtP) * Q96 / (sqrtP * sqrtU)
    const outRaw = L.multipliedBy(sqrtU.minus(sqrtP)).multipliedBy(Q96_BN)
      .dividedBy(sqrtP.multipliedBy(sqrtU))
      .integerValue(BigNumber.ROUND_DOWN);
    amount0 = formatUnits(BigInt(outRaw.toFixed(0)), p.token0Decimals);
    amount1 = inputAmount;
  }

  return {
    token0: { address: p.token0, symbol: p.token0Symbol, decimals: p.token0Decimals },
    token1: { address: p.token1, symbol: p.token1Symbol, decimals: p.token1Decimals },
    amount0,
    amount1,
    positionState: "in_range",
    note: `Tick ${p.tick} in range [${tickLower}, ${tickUpper}].`,
  };
}

// ── Handler & tool definition ─────────────────────────────────────────────────

export async function handleGetDepositAmounts(params: {
  poolType: "basic" | "cl";
  poolAddress: string;
  inputToken: string;
  inputAmount: string;
  tickLower?: number;
  tickUpper?: number;
}) {
  const { poolType, poolAddress, inputToken, inputAmount } = params;

  if (poolType === "basic") {
    return { success: true, ...(await getBasicDepositAmounts(poolAddress, inputToken, inputAmount)) };
  }

  if (poolType === "cl") {
    if (params.tickLower === undefined || params.tickUpper === undefined) {
      throw new Error("tickLower and tickUpper are required for poolType='cl'.");
    }
    return {
      success: true,
      ...(await getCLDepositAmounts(poolAddress, inputToken, inputAmount, params.tickLower, params.tickUpper)),
    };
  }

  throw new Error(`Unknown poolType "${poolType}". Use "basic" or "cl".`);
}

export const getDepositAmountsTool = {
  name: "get_deposit_amounts",
  description:
    "Given a pool and one token amount, returns how much of the other token is needed to add liquidity. " +
    "For basic (v2) pools: uses current reserve ratio (amountOther = amountIn × reserveOther / reserveIn). " +
    "For CL pools: uses tick-range math (Uniswap v3 style) — given one token amount and the tick range, derives the liquidity L then computes the paired amount. Pass tickLower/tickUpper of the intended range. " +
    "Call this before add_liquidity_steps or add_liquidity_cl_steps so you have both token amounts ready.",
  inputSchema: {
    type: "object",
    properties: {
      poolType: {
        type: "string",
        enum: ["basic", "cl"],
        description: "basic = v2 AMM pool, cl = concentrated liquidity pool.",
      },
      poolAddress: { type: "string", description: "Pool contract address." },
      inputToken: { type: "string", description: "Address of the token whose amount you know." },
      inputAmount: { type: "string", description: "Human-readable amount of inputToken to deposit." },
      tickLower: { type: "number", description: "Lower tick of the CL range (required for poolType='cl')." },
      tickUpper: { type: "number", description: "Upper tick of the CL range (required for poolType='cl')." },
    },
    required: ["poolType", "poolAddress", "inputToken", "inputAmount"],
  },
};
