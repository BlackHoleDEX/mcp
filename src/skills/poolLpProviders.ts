import { SERVER_CONFIG } from "../config.js";
import { computeAmountsFromLiquidity } from "../utils/clMath.js";
import { publicClient } from "../utils/viemClient.js";

const V2_PAIR_ABI = [
  {
    inputs: [],
    name: "getReserves",
    outputs: [
      { name: "_reserve0", type: "uint112" },
      { name: "_reserve1", type: "uint112" },
      { name: "_blockTimestampLast", type: "uint32" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token0",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token1",
    outputs: [{ name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

function normalizeAddress(addr: string | undefined): string {
  return (addr ?? "0x0000000000000000000000000000000000000000").toLowerCase();
}

async function fetchTokenPrices(): Promise<Map<string, { symbol: string; decimals: number; usdPrice: number }>> {
  const map = new Map<string, { symbol: string; decimals: number; usdPrice: number }>();
  try {
    const res = await fetch("https://resources.blackhole.xyz/token-details.json");
    const data = (await res.json()) as Record<string, any>;
    for (const [key, token] of Object.entries(data ?? {})) {
      const address = normalizeAddress((token as any)?.address ?? key);
      map.set(address, {
        symbol: String((token as any)?.ticker ?? ""),
        decimals: Number((token as any)?.decimal ?? 18),
        usdPrice: Number((token as any)?.usd_pricing ?? 0),
      });
    }
  } catch {}
  return map;
}

// ── CL ──────────────────────────────────────────────────────────────────────

interface CLPoolInfo {
  id: string;
  tick: string;
  sqrtPrice: string;
  fee: string;
  totalValueLockedUSD: string;
  token0: { id: string; symbol: string; decimals: string };
  token1: { id: string; symbol: string; decimals: string };
}

interface CLPosition {
  id: string;
  owner: string;
  liquidity: string;
  tickLower: { tickIdx: string };
  tickUpper: { tickIdx: string };
}

async function fetchCLPoolInfo(poolAddress: string): Promise<CLPoolInfo | null> {
  try {
    const res = await fetch(SERVER_CONFIG.CL_GRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
          pool(id: "${poolAddress}") {
            id tick sqrtPrice fee totalValueLockedUSD
            token0 { id symbol decimals }
            token1 { id symbol decimals }
          }
        }`,
      }),
    });
    const json = (await res.json()) as { data?: { pool?: CLPoolInfo } };
    return json?.data?.pool ?? null;
  } catch {
    return null;
  }
}

async function fetchCLPositions(poolAddress: string): Promise<CLPosition[]> {
  const all: CLPosition[] = [];
  const pageSize = 500;
  let skip = 0;

  while (true) {
    try {
      const res = await fetch(SERVER_CONFIG.CL_GRAPH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `{
            positions(
              first: ${pageSize},
              skip: ${skip},
              where: { pool: "${poolAddress}", liquidity_gt: "0" },
              orderBy: liquidity,
              orderDirection: desc
            ) {
              id owner liquidity
              tickLower { tickIdx }
              tickUpper { tickIdx }
            }
          }`,
        }),
      });
      const json = (await res.json()) as { data?: { positions?: CLPosition[] } };
      const rows = json?.data?.positions ?? [];
      all.push(...rows);
      if (rows.length < pageSize) break;
      skip += pageSize;
      if (skip >= 2000) break;
    } catch {
      break;
    }
  }

  return all;
}

// ── V2 ──────────────────────────────────────────────────────────────────────

interface UserPool {
  userAddress: string;
  staked: string;
  unstaked: string;
}

async function fetchV2UserPools(pairAddress: string): Promise<UserPool[]> {
  const all: UserPool[] = [];
  const pageSize = 1000;
  let skip = 0;

  while (true) {
    try {
      const res = await fetch(SERVER_CONFIG.BASIC_GRAPH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `{
            userPools(
              first: ${pageSize},
              skip: ${skip},
              where: { pairAddress: "${pairAddress}" }
            ) {
              userAddress staked unstaked
            }
          }`,
        }),
      });
      const json = (await res.json()) as { data?: { userPools?: UserPool[] } };
      const rows = json?.data?.userPools ?? [];
      all.push(...rows);
      if (rows.length < pageSize) break;
      skip += pageSize;
      if (skip >= 10000) break;
    } catch {
      break;
    }
  }

  return all.filter((u) => parseFloat(u.staked || "0") + parseFloat(u.unstaked || "0") > 0);
}

// ── Handler ──────────────────────────────────────────────────────────────────

export interface GetPoolLpProvidersParams {
  poolAddress: string;
  limit?: number;
}

export async function handleGetPoolLpProviders(params: GetPoolLpProvidersParams) {
  const { poolAddress, limit = 20 } = params;
  const normalized = normalizeAddress(poolAddress);
  const effectiveLimit = Math.min(Math.max(1, limit), 100);

  // Detect pool type and prefetch V2 users + prices in parallel
  const [clPoolInfo, v2Users, tokenPrices] = await Promise.all([
    fetchCLPoolInfo(normalized),
    fetchV2UserPools(normalized),
    fetchTokenPrices(),
  ]);

  // ── CL path ────────────────────────────────────────────────────────────────
  if (clPoolInfo !== null) {
    const positions = await fetchCLPositions(normalized);

    if (!positions.length) {
      return {
        success: true,
        poolType: "concentrated",
        poolAddress: normalized,
        token0: { address: normalizeAddress(clPoolInfo.token0.id), symbol: clPoolInfo.token0.symbol, decimals: Number(clPoolInfo.token0.decimals) },
        token1: { address: normalizeAddress(clPoolInfo.token1.id), symbol: clPoolInfo.token1.symbol, decimals: Number(clPoolInfo.token1.decimals) },
        poolTvlUsd: parseFloat(Number(clPoolInfo.totalValueLockedUSD ?? 0).toFixed(2)),
        totalActivePositions: 0,
        totalProviders: 0,
        returnedProviders: 0,
        providers: [],
      };
    }

    const token0Addr = normalizeAddress(clPoolInfo.token0.id);
    const token1Addr = normalizeAddress(clPoolInfo.token1.id);
    const token0Decimals = Number(clPoolInfo.token0.decimals ?? 18);
    const token1Decimals = Number(clPoolInfo.token1.decimals ?? 18);
    const price0 = tokenPrices.get(token0Addr)?.usdPrice ?? 0;
    const price1 = tokenPrices.get(token1Addr)?.usdPrice ?? 0;
    const tickCurrent = Number(clPoolInfo.tick ?? 0);
    const sqrtPriceX96 = clPoolInfo.sqrtPrice ?? "0";
    const poolTvlUsd = Number(clPoolInfo.totalValueLockedUSD ?? 0);

    const ownerMap = new Map<string, {
      wallet: string;
      positionCount: number;
      totalLiquidity: bigint;
      totalAmount0: number;
      totalAmount1: number;
      tvlUsd: number;
      positions: { tokenId: number; liquidity: string; tickLower: number; tickUpper: number; amount0: number; amount1: number; inRange: boolean }[];
    }>();

    for (const pos of positions) {
      const owner = normalizeAddress(pos.owner);
      const tickLower = Number(pos.tickLower?.tickIdx ?? 0);
      const tickUpper = Number(pos.tickUpper?.tickIdx ?? 0);
      const liquidityRaw = BigInt(pos.liquidity ?? "0");
      const inRange = tickCurrent >= tickLower && tickCurrent < tickUpper;

      let amount0 = 0, amount1 = 0;
      try {
        if (tickLower < tickUpper && liquidityRaw > 0n) {
          const { amount0Raw, amount1Raw } = computeAmountsFromLiquidity({ liquidityRaw, tickLower, tickUpper, tickCurrent, sqrtPriceX96 });
          amount0 = Number(amount0Raw) / 10 ** token0Decimals;
          amount1 = Number(amount1Raw) / 10 ** token1Decimals;
        }
      } catch {}

      const posUsd = amount0 * price0 + amount1 * price1;
      const existing = ownerMap.get(owner);
      if (existing) {
        existing.positionCount += 1;
        existing.totalLiquidity += liquidityRaw;
        existing.totalAmount0 += amount0;
        existing.totalAmount1 += amount1;
        existing.tvlUsd += posUsd;
        existing.positions.push({ tokenId: Number(pos.id), liquidity: pos.liquidity, tickLower, tickUpper, amount0: parseFloat(amount0.toFixed(6)), amount1: parseFloat(amount1.toFixed(6)), inRange });
      } else {
        ownerMap.set(owner, { wallet: owner, positionCount: 1, totalLiquidity: liquidityRaw, totalAmount0: amount0, totalAmount1: amount1, tvlUsd: posUsd, positions: [{ tokenId: Number(pos.id), liquidity: pos.liquidity, tickLower, tickUpper, amount0: parseFloat(amount0.toFixed(6)), amount1: parseFloat(amount1.toFixed(6)), inRange }] });
      }
    }

    const sorted = [...ownerMap.values()].sort((a, b) => b.tvlUsd - a.tvlUsd);
    const computedTvl = sorted.reduce((s, p) => s + p.tvlUsd, 0);
    const effectivePoolTvl = poolTvlUsd > 0 ? poolTvlUsd : computedTvl;

    return {
      success: true,
      poolType: "concentrated",
      poolAddress: normalized,
      token0: { address: token0Addr, symbol: clPoolInfo.token0.symbol, decimals: token0Decimals },
      token1: { address: token1Addr, symbol: clPoolInfo.token1.symbol, decimals: token1Decimals },
      poolTvlUsd: parseFloat(effectivePoolTvl.toFixed(2)),
      totalActivePositions: positions.length,
      totalProviders: sorted.length,
      returnedProviders: Math.min(effectiveLimit, sorted.length),
      providers: sorted.slice(0, effectiveLimit).map((p, idx) => ({
        rank: idx + 1,
        wallet: p.wallet,
        positionCount: p.positionCount,
        totalLiquidity: p.totalLiquidity.toString(),
        token0Amount: p.totalAmount0.toFixed(6),
        token1Amount: p.totalAmount1.toFixed(6),
        tvlUsd: parseFloat(p.tvlUsd.toFixed(2)),
        shareOfPoolTvlPct: effectivePoolTvl > 0 ? parseFloat(((p.tvlUsd / effectivePoolTvl) * 100).toFixed(4)) : 0,
        positions: p.positions,
      })),
    };
  }

  // ── V2 path ────────────────────────────────────────────────────────────────
  if (!v2Users.length) {
    return {
      success: false,
      poolAddress: normalized,
      message: "Pool not found. Address may not be a valid V2 or concentrated liquidity pool on this network.",
    };
  }

  const [token0AddrRaw, token1AddrRaw, totalSupplyRaw, reservesRaw] = await Promise.all([
    publicClient.readContract({ address: normalized as `0x${string}`, abi: V2_PAIR_ABI, functionName: "token0" }),
    publicClient.readContract({ address: normalized as `0x${string}`, abi: V2_PAIR_ABI, functionName: "token1" }),
    publicClient.readContract({ address: normalized as `0x${string}`, abi: V2_PAIR_ABI, functionName: "totalSupply" }),
    publicClient.readContract({ address: normalized as `0x${string}`, abi: V2_PAIR_ABI, functionName: "getReserves" }),
  ]);

  const token0Addr = normalizeAddress(String(token0AddrRaw));
  const token1Addr = normalizeAddress(String(token1AddrRaw));
  const token0Meta = tokenPrices.get(token0Addr) ?? { symbol: "", decimals: 18, usdPrice: 0 };
  const token1Meta = tokenPrices.get(token1Addr) ?? { symbol: "", decimals: 18, usdPrice: 0 };
  const reserves = reservesRaw as unknown as readonly [bigint, bigint, number];
  const reserve0Raw = reserves[0];
  const reserve1Raw = reserves[1];
  const totalSupply = totalSupplyRaw as unknown as bigint;

  const reserve0Human = Number(reserve0Raw) / 10 ** token0Meta.decimals;
  const reserve1Human = Number(reserve1Raw) / 10 ** token1Meta.decimals;
  const poolTvlUsd = reserve0Human * token0Meta.usdPrice + reserve1Human * token1Meta.usdPrice;

  const entries = v2Users.map((u) => {
    const stakedRaw = BigInt(Math.floor(parseFloat(u.staked || "0")));
    const unstakedRaw = BigInt(Math.floor(parseFloat(u.unstaked || "0")));
    const lpTokens = stakedRaw + unstakedRaw;

    let amount0 = 0, amount1 = 0, tvlUsd = 0;
    if (totalSupply > 0n) {
      amount0 = Number((lpTokens * reserve0Raw) / totalSupply) / 10 ** token0Meta.decimals;
      amount1 = Number((lpTokens * reserve1Raw) / totalSupply) / 10 ** token1Meta.decimals;
      tvlUsd = amount0 * token0Meta.usdPrice + amount1 * token1Meta.usdPrice;
    }

    return {
      wallet: normalizeAddress(u.userAddress),
      lpTokensStaked: u.staked,
      lpTokensUnstaked: u.unstaked,
      lpTokensTotal: lpTokens.toString(),
      token0Amount: amount0.toFixed(6),
      token1Amount: amount1.toFixed(6),
      tvlUsd: parseFloat(tvlUsd.toFixed(2)),
      shareOfPoolTvlPct: poolTvlUsd > 0 ? parseFloat(((tvlUsd / poolTvlUsd) * 100).toFixed(4)) : 0,
    };
  });

  const sorted = entries.sort((a, b) => b.tvlUsd - a.tvlUsd);
  const top = sorted.slice(0, effectiveLimit);

  return {
    success: true,
    poolType: "v2",
    poolAddress: normalized,
    token0: { address: token0Addr, symbol: token0Meta.symbol, decimals: token0Meta.decimals },
    token1: { address: token1Addr, symbol: token1Meta.symbol, decimals: token1Meta.decimals },
    reserve0: reserve0Human.toFixed(6),
    reserve1: reserve1Human.toFixed(6),
    poolTvlUsd: parseFloat(poolTvlUsd.toFixed(2)),
    totalProviders: sorted.length,
    returnedProviders: top.length,
    providers: top.map((p, idx) => ({ rank: idx + 1, ...p })),
  };
}

export const getPoolLpProvidersTool = {
  name: "get_pool_lp_providers",
  description:
    "Show top LP providers (liquidity providers) for a specific pool — supports both V2 (volatile/stable AMM) and concentrated liquidity (CL) pools. Returns wallets sorted by TVL held, with LP balances, token amounts, USD value, and each wallet's share of pool TVL. Answers: 'Which wallets hold the most liquidity in this pool?' and 'Show top LPs for pool X.'",
  inputSchema: {
    type: "object",
    properties: {
      poolAddress: {
        type: "string",
        description: "The pool contract address to query LP providers for.",
      },
      limit: {
        type: "number",
        description: "Maximum number of top LP providers to return. Default 20, max 100.",
      },
    },
    required: ["poolAddress"],
  },
};
