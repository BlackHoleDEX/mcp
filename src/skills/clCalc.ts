import { SERVER_CONFIG } from "../config.js";
import {
  ALGEBRA_POOL_API_ABI,
  ALGEBRA_POOL_API_ADDRESS,
} from "../constants/contracts.js";
import { publicClient } from "../utils/viemClient.js";
import { computeAmountsFromLiquidity, computeInRangePositionAmounts } from "../utils/clMath.js";
import { fetchTokenPrices } from "../utils/tokenPrices.js";

const EPOCH_SECONDS = 86400 * 7;
const EPOCHS_PER_YEAR = Math.floor((365 * 24 * 60 * 60) / EPOCH_SECONDS);

// ─── Tick / Price math ───────────────────────────────────────────────────────

function tickToPrice(tick: number, token0Decimals: number, token1Decimals: number): number {
  // price = 1.0001^tick adjusted for decimal difference
  const raw = Math.pow(1.0001, tick);
  return raw * Math.pow(10, token0Decimals - token1Decimals);
}

function priceToTick(price: number, token0Decimals: number, token1Decimals: number): number {
  const adjustedPrice = price / Math.pow(10, token0Decimals - token1Decimals);
  return Math.round(Math.log(adjustedPrice) / Math.log(1.0001));
}

function alignTick(tick: number, tickSpacing: number): number {
  return Math.floor(tick / tickSpacing) * tickSpacing;
}

// ─── Subgraph pool fetch ─────────────────────────────────────────────────────

interface PoolData {
  id: string;
  tick: number;
  sqrtPrice: string;
  liquidity: string;
  tickSpacing: number;
  fee: number;
  totalValueLockedUSD: number;
  token0: { id: string; symbol: string; decimals: number };
  token1: { id: string; symbol: string; decimals: number };
}

async function fetchPoolFromSubgraph(poolAddress: string): Promise<PoolData | null> {
  try {
    const res = await fetch(SERVER_CONFIG.CL_GRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
          pool(id: "${poolAddress.toLowerCase()}") {
            id tick sqrtPrice liquidity tickSpacing fee totalValueLockedUSD
            token0 { id symbol decimals }
            token1 { id symbol decimals }
          }
        }`,
      }),
    });
    const json = (await res.json()) as any;
    const p = json?.data?.pool;
    if (!p) return null;
    return {
      id: p.id,
      tick: Number(p.tick),
      sqrtPrice: p.sqrtPrice,
      liquidity: p.liquidity,
      tickSpacing: Number(p.tickSpacing),
      fee: Number(p.fee),
      totalValueLockedUSD: Number(p.totalValueLockedUSD ?? 0),
      token0: { id: p.token0.id, symbol: p.token0.symbol, decimals: Number(p.token0.decimals) },
      token1: { id: p.token1.id, symbol: p.token1.symbol, decimals: Number(p.token1.decimals) },
    };
  } catch {
    return null;
  }
}


async function fetchPoolEmissions(poolAddress: string): Promise<{ totalEmissions: number; underlyingPrice: number }> {
  try {
    const pools = [poolAddress.toLowerCase() as `0x${string}`];
    const raw = (await publicClient.readContract({
      address: ALGEBRA_POOL_API_ADDRESS as `0x${string}`,
      abi: ALGEBRA_POOL_API_ABI,
      functionName: "getAllPoolInfo",
      args: [pools],
    })) as any;
    const infos = Array.isArray(raw) ? raw : (raw?.[0] ? [raw[0]] : []);
    const pool = infos[0];
    if (!pool) return { totalEmissions: 0, underlyingPrice: 0 };

    const emissionsDec = Number(pool.emissions_token_decimals ?? 18);
    const totalEmissions = Number(BigInt(pool.total_emissions ?? 0n)) / 10 ** emissionsDec;

    const prices = await fetchTokenPrices();
    const emissionsToken = String(pool.emissions_token ?? "").toLowerCase();
    const underlyingPrice = prices.get(emissionsToken) ?? 0;

    return { totalEmissions, underlyingPrice };
  } catch {
    return { totalEmissions: 0, underlyingPrice: 0 };
  }
}

// ─── cl_tick_to_price ────────────────────────────────────────────────────────

export interface TickToPriceParams {
  tick: number;
  token0Decimals?: number;
  token1Decimals?: number;
  poolAddress?: string;
}

export async function handleTickToPrice(params: TickToPriceParams) {
  let t0Dec = params.token0Decimals ?? 18;
  let t1Dec = params.token1Decimals ?? 18;
  let t0Symbol = "token0";
  let t1Symbol = "token1";

  if (params.poolAddress) {
    const pool = await fetchPoolFromSubgraph(params.poolAddress);
    if (pool) {
      t0Dec = pool.token0.decimals;
      t1Dec = pool.token1.decimals;
      t0Symbol = pool.token0.symbol;
      t1Symbol = pool.token1.symbol;
    }
  }

  const price = tickToPrice(params.tick, t0Dec, t1Dec);
  const inversePrice = price > 0 ? 1 / price : 0;

  return {
    success: true,
    tick: params.tick,
    price: price,
    priceLabel: `1 ${t0Symbol} = ${price.toFixed(8)} ${t1Symbol}`,
    inversePrice: inversePrice,
    inversePriceLabel: `1 ${t1Symbol} = ${inversePrice.toFixed(8)} ${t0Symbol}`,
  };
}

// ─── cl_price_to_tick ────────────────────────────────────────────────────────

export interface PriceToTickParams {
  price: number;
  token0Decimals?: number;
  token1Decimals?: number;
  poolAddress?: string;
  alignToSpacing?: boolean;
}

export async function handlePriceToTick(params: PriceToTickParams) {
  let t0Dec = params.token0Decimals ?? 18;
  let t1Dec = params.token1Decimals ?? 18;
  let tickSpacing = 1;

  if (params.poolAddress) {
    const pool = await fetchPoolFromSubgraph(params.poolAddress);
    if (pool) {
      t0Dec = pool.token0.decimals;
      t1Dec = pool.token1.decimals;
      tickSpacing = pool.tickSpacing;
    }
  }

  let tick = priceToTick(params.price, t0Dec, t1Dec);
  const rawTick = tick;

  if (params.alignToSpacing !== false && tickSpacing > 1) {
    tick = alignTick(tick, tickSpacing);
  }

  return {
    success: true,
    price: params.price,
    tick,
    rawTick,
    tickSpacing,
    aligned: tick !== rawTick,
  };
}

// ─── cl_position_detail ──────────────────────────────────────────────────────

export interface PositionDetailParams {
  poolAddress: string;
  tickLower: number;
  tickUpper: number;
  liquidityAmount?: string;
  depositUsd?: number;
}

export async function handlePositionDetail(params: PositionDetailParams) {
  const pool = await fetchPoolFromSubgraph(params.poolAddress);
  if (!pool) throw new Error(`Pool ${params.poolAddress} not found in subgraph.`);

  const t0Dec = pool.token0.decimals;
  const t1Dec = pool.token1.decimals;

  const priceLower = tickToPrice(params.tickLower, t0Dec, t1Dec);
  const priceUpper = tickToPrice(params.tickUpper, t0Dec, t1Dec);
  const priceCurrent = tickToPrice(pool.tick, t0Dec, t1Dec);

  const inRange = pool.tick >= params.tickLower && pool.tick < params.tickUpper;
  const widthTicks = params.tickUpper - params.tickLower;
  const widthPercent = ((priceUpper - priceLower) / priceCurrent) * 100;

  // Compute token amounts if liquidity provided
  let token0Amount = 0;
  let token1Amount = 0;
  if (params.liquidityAmount) {
    try {
      const { amount0Raw, amount1Raw } = computeAmountsFromLiquidity({
        liquidityRaw: BigInt(params.liquidityAmount),
        tickLower: params.tickLower,
        tickUpper: params.tickUpper,
        tickCurrent: pool.tick,
        sqrtPriceX96: BigInt(pool.sqrtPrice),
      });
      token0Amount = Number(amount0Raw) / 10 ** t0Dec;
      token1Amount = Number(amount1Raw) / 10 ** t1Dec;
    } catch {}
  }

  const prices = await fetchTokenPrices();
  const price0Usd = prices.get(pool.token0.id.toLowerCase()) ?? 0;
  const price1Usd = prices.get(pool.token1.id.toLowerCase()) ?? 0;
  const positionUsd = token0Amount * price0Usd + token1Amount * price1Usd;

  return {
    success: true,
    pool: {
      address: pool.id,
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
      fee: (pool.fee / 10000) + "%",
      tickSpacing: pool.tickSpacing,
    },
    range: {
      tickLower: params.tickLower,
      tickUpper: params.tickUpper,
      priceLower: priceLower.toFixed(8),
      priceUpper: priceUpper.toFixed(8),
      priceCurrent: priceCurrent.toFixed(8),
      priceLabel: `${pool.token0.symbol} per ${pool.token1.symbol}`,
      widthTicks,
      widthPercent: widthPercent.toFixed(2) + "%",
      inRange,
    },
    amounts: params.liquidityAmount ? {
      token0: { symbol: pool.token0.symbol, amount: token0Amount.toFixed(6) },
      token1: { symbol: pool.token1.symbol, amount: token1Amount.toFixed(6) },
      totalUsd: positionUsd.toFixed(2),
    } : undefined,
  };
}

// ─── cl_apr_simulator ────────────────────────────────────────────────────────

export interface AprSimulatorParams {
  poolAddress: string;
  widths?: number[];
}

export async function handleAprSimulator(params: AprSimulatorParams) {
  const pool = await fetchPoolFromSubgraph(params.poolAddress);
  if (!pool) throw new Error(`Pool ${params.poolAddress} not found in subgraph.`);

  const { totalEmissions, underlyingPrice } = await fetchPoolEmissions(params.poolAddress);
  const emissionsUsdPerEpoch = totalEmissions * underlyingPrice;

  const prices = await fetchTokenPrices();
  const price0Usd = prices.get(pool.token0.id.toLowerCase()) ?? 0;
  const price1Usd = prices.get(pool.token1.id.toLowerCase()) ?? 0;

  const t0Dec = pool.token0.decimals;
  const t1Dec = pool.token1.decimals;

  // Default widths: 1x tickSpacing, 5x, 10x, 50x, 100x, 500x, full range
  const defaultWidths = [1, 5, 10, 50, 100, 500, 1000].map((m) => m * pool.tickSpacing);
  const widths = params.widths ?? defaultWidths;

  const activeLiq = BigInt(pool.liquidity || "0");
  const simulations: any[] = [];

  for (const width of widths) {
    const tickLower = alignTick(pool.tick - Math.floor(width / 2), pool.tickSpacing);
    const tickUpper = tickLower + width;

    const priceLower = tickToPrice(tickLower, t0Dec, t1Dec);
    const priceUpper = tickToPrice(tickUpper, t0Dec, t1Dec);
    const priceCurrent = tickToPrice(pool.tick, t0Dec, t1Dec);
    const widthPercent = ((priceUpper - priceLower) / priceCurrent) * 100;

    // Compute TVL for a position with active liquidity at this width
    let positionTvl = 0;
    try {
      const { amount0Raw, amount1Raw } = computeAmountsFromLiquidity({
        liquidityRaw: activeLiq,
        tickLower,
        tickUpper,
        tickCurrent: pool.tick,
        sqrtPriceX96: BigInt(pool.sqrtPrice),
      });
      const a0 = Number(amount0Raw) / 10 ** t0Dec;
      const a1 = Number(amount1Raw) / 10 ** t1Dec;
      positionTvl = a0 * price0Usd + a1 * price1Usd;
    } catch {}

    const apr = positionTvl > 0
      ? (emissionsUsdPerEpoch * EPOCHS_PER_YEAR * 100) / positionTvl
      : 0;

    simulations.push({
      widthTicks: width,
      widthPercent: widthPercent.toFixed(1) + "%",
      tickLower,
      tickUpper,
      priceLower: priceLower.toFixed(6),
      priceUpper: priceUpper.toFixed(6),
      estimatedApr: apr.toFixed(1) + "%",
      note: width <= pool.tickSpacing
        ? "Narrowest (highest APR, highest rebalance risk)"
        : width >= 1000 * pool.tickSpacing
          ? "Very wide (lowest APR, rarely out of range)"
          : undefined,
    });
  }

  return {
    success: true,
    pool: {
      address: pool.id,
      pair: `${pool.token0.symbol}/${pool.token1.symbol}`,
      fee: (pool.fee / 10000) + "%",
      tickSpacing: pool.tickSpacing,
      currentTick: pool.tick,
      currentPrice: tickToPrice(pool.tick, t0Dec, t1Dec).toFixed(8),
      tvlUsd: pool.totalValueLockedUSD.toFixed(2),
      emissionsUsdPerWeek: emissionsUsdPerEpoch.toFixed(2),
    },
    message: "Narrower ranges = higher APR but more frequent rebalancing. Wider ranges = lower APR but more stable.",
    simulations,
  };
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export const clTickToPriceTool = {
  name: "cl_tick_to_price",
  description: "Convert a CL tick to a human-readable price. Optionally pass poolAddress to auto-detect token decimals and symbols.",
  inputSchema: {
    type: "object",
    properties: {
      tick: { type: "number", description: "The tick value to convert." },
      token0Decimals: { type: "number", description: "Decimals of token0 (default 18)." },
      token1Decimals: { type: "number", description: "Decimals of token1 (default 18)." },
      poolAddress: { type: "string", description: "CL pool address — auto-detects decimals and symbols." },
    },
    required: ["tick"],
  },
};

export const clPriceToTickTool = {
  name: "cl_price_to_tick",
  description: "Convert a human-readable price to the nearest valid CL tick. Aligns to pool tickSpacing when poolAddress is provided.",
  inputSchema: {
    type: "object",
    properties: {
      price: { type: "number", description: "The price (token1 per token0) to convert." },
      token0Decimals: { type: "number", description: "Decimals of token0 (default 18)." },
      token1Decimals: { type: "number", description: "Decimals of token1 (default 18)." },
      poolAddress: { type: "string", description: "CL pool address — auto-detects decimals and aligns to tickSpacing." },
      alignToSpacing: { type: "boolean", description: "Align tick to pool tickSpacing (default true)." },
    },
    required: ["price"],
  },
};

export const clPositionDetailTool = {
  name: "cl_position_detail",
  description: "Get detailed info about a CL position range — prices at tick boundaries, width %, in-range status, token amounts. Use to understand what a position looks like before entering.",
  inputSchema: {
    type: "object",
    properties: {
      poolAddress: { type: "string", description: "CL pool address." },
      tickLower: { type: "number", description: "Lower tick of the range." },
      tickUpper: { type: "number", description: "Upper tick of the range." },
      liquidityAmount: { type: "string", description: "Optional liquidity amount to compute token split." },
      depositUsd: { type: "number", description: "Optional USD deposit amount to estimate position size." },
    },
    required: ["poolAddress", "tickLower", "tickUpper"],
  },
};

export const clAprSimulatorTool = {
  name: "cl_apr_simulator",
  description: "Simulate APR for a CL pool at different position widths. Shows how APR changes as you go from narrow (high APR, high rebalance risk) to wide (low APR, stable). Essential for choosing optimal tick range.",
  inputSchema: {
    type: "object",
    properties: {
      poolAddress: { type: "string", description: "CL pool address to simulate." },
      widths: { type: "array", items: { type: "number" }, description: "Optional array of widths in ticks to simulate. Defaults to common multiples of tickSpacing." },
    },
    required: ["poolAddress"],
  },
};
