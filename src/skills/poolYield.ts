import { SERVER_CONFIG } from "../config.js";
import {
  ALGEBRA_POOL_API_ABI,
  ALGEBRA_POOL_API_ADDRESS,
  BLACKHOLE_PAIR_ABI,
  BLACKHOLE_PAIR_API_V2_ADDRESS,
} from "../constants/contracts.js";
import { getFarmingCenterForDeployer } from "../utils/legacyContracts.js";
import { computeInRangePositionAmounts } from "../utils/clMath.js";
import {
  formatCLPoolName,
  formatCLPoolSymbol,
  resolveCLTickSpacing,
} from "../utils/clPoolLabel.js";
import { publicClient } from "../utils/viemClient.js";
import { PAIR_FACTORY_GET_FEE_ABI, PROTOCOL_ADDRESSES } from "./resolveAddress.js";
import { computeVolumeFromFees } from "../utils/volumeCalc.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
/** Small pages avoid malformed duplicate rows when decoding large `getAllPair` responses. */
const V2_PAGE_SIZES = [100n, 50n];
const MAX_V2_PAGES = 40n;
const ALGEBRA_INFO_BATCH = 40n;

const GAUGE_PERIOD_FINISH_ABI = [
  {
    inputs: [],
    name: "periodFinish",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const FARMING_CENTER_VIRTUAL_POOL_ABI = [
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "virtualPoolAddresses",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const VIRTUAL_POOL_REWARD_RATES_ABI = [
  {
    inputs: [],
    name: "rewardRates",
    outputs: [
      { internalType: "uint128", name: "rate0", type: "uint128" },
      { internalType: "uint128", name: "rate1", type: "uint128" },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;


type SortBy = "tvlUsd" | "apr" | "vapr" | "feesUsd" | "votes" | "volumeUsd";

type PoolTypeFilter =
  | "all"
  | "basic"
  | "concentrated"
  | "stable"
  | "volatile"
  | "basic_stable"
  | "basic_volatile"
  | "concentrated_stable"
  | "concentrated_volatile";

interface RangeFilter {
  min?: number;
  max?: number;
}

interface TokenPricing {
  address: string;
  symbol: string;
  decimals: number;
  usdPrice: number;
}

interface RewardToken {
  address: string;
  symbol: string;
  amountPerEpoch: number;
  usdPerEpoch: number;
  /** "fee" = internal bribe (LP trading fees to voters); "bribe" = external incentive token. */
  type: "fee" | "bribe";
}

interface PoolMetric {
  pairAddress: string;
  name: string;
  symbol: string;
  stable: boolean;
  /** Algebra / concentrated liquidity pool when true. */
  concentrated: boolean;
  feePercent: number;
  tvlUsd: number;
  feesUsd: number;
  apr: number;
  vapr: number;
  /** Raw vote weight from pair API (18-decimal fixed point). */
  votes: number;
  votesUsd: number;
  emissionsUsdPerEpoch: number;
  totalSupply: number;
  /** V2: gauge staked LP from API; always 0 for concentrated pools (unused). */
  gaugeTotalSupply: number;
  /** V2: TVL in gauge via stake ratio; concentrated: full pool TVL (all treated as staked). */
  lockedTvlUsd: number;
  /** Gauge address (zero address when pool has no gauge). */
  gaugeAddress: string;
  /** 24h volume from latest poolDayData (CL pools only; 0 for V2). */
  volumeUsd: number;
  token0: { address: string; symbol: string; decimals: number };
  token1: { address: string; symbol: string; decimals: number };
  /** Token amounts backing the pool TVL. */
  tvlToken0: number;
  tvlToken1: number;
  /** Staked fee token amounts claimable by voters. */
  feesToken0: number;
  feesToken1: number;
  rewardTokens: RewardToken[];
  /** Set for concentrated pools when tick spacing is known (disambiguates same pair). */
  tickSpacing?: number;
}

export interface PoolYieldParams {
  userAddress?: string;
  poolAddress?: string;
  topN?: number;
  sortBy?: SortBy;
  sortOrder?: "asc" | "desc";

  /** UI tab equivalent: "all" / "basic" / "concentrated" / "stable" / "volatile" / "basic_stable" / ... */
  poolType?: PoolTypeFilter;
  /** Substring match against pair symbol, name, or pairAddress (case-insensitive). */
  search?: string;
  /** Only return pools that have a gauge (gaugeAddress != zero). */
  hasGauge?: boolean;

  /** Range filters (UI Min/Max sliders). All optional; both ends inclusive. */
  apr?: RangeFilter;
  vapr?: RangeFilter;
  tvl?: RangeFilter;
  fees?: RangeFilter;
  votes?: RangeFilter;
}

function getS3BaseUrl(): string {
  return "https://resources.blackhole.xyz/";
}

function getEpochDurationSeconds(): number {
  return 86400 * 7;
}


function getField<T = any>(value: any, key: string, index: number): T | undefined {
  return (value?.[key] ?? value?.[index]) as T | undefined;
}

function normalizeAddress(addr: string | undefined): string {
  return (addr ?? ZERO_ADDRESS).toLowerCase();
}

function toDecimal(value: bigint | number | string | undefined, decimals: number): number {
  if (value === undefined) return 0;
  try {
    const raw = BigInt(value);
    if (decimals <= 0) return Number(raw);
    return Number(raw) / 10 ** decimals;
  } catch {
    return Number(value ?? 0);
  }
}

async function fetchTokenPricingMap() {
  const url = `${getS3BaseUrl()}token-details.json`;
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch token pricing from ${url}.`);
  }
  const data = (await response.json()) as Record<string, any>;
  const map = new Map<string, TokenPricing>();

  for (const [key, token] of Object.entries(data ?? {})) {
    const address = normalizeAddress((token as any)?.address ?? key);
    const usdPrice = Number((token as any)?.usd_pricing ?? 0);
    const decimals = Number((token as any)?.decimal ?? 18);
    const symbol = String((token as any)?.ticker ?? "");

    map.set(address, { address, symbol, decimals, usdPrice });
  }

  const wavax = Array.from(map.values()).find((t) => t.symbol.toUpperCase() === "WAVAX");
  if (wavax) {
    map.set("0xavax", { ...wavax, address: "0xavax", symbol: "AVAX" });
  }

  return map;
}

async function fetchAllV2Pairs(userAddress: string): Promise<any[]> {
  for (const pageSize of V2_PAGE_SIZES) {
    try {
      const byAddr = new Map<string, any>();
      let offset = 0n;
      let pageCount = 0n;

      while (pageCount < MAX_V2_PAGES) {
        const data = (await publicClient.readContract({
          address: BLACKHOLE_PAIR_API_V2_ADDRESS as `0x${string}`,
          abi: BLACKHOLE_PAIR_ABI,
          functionName: "getAllPair",
          args: [userAddress as `0x${string}`, pageSize, offset],
        })) as any;

        const hasNext = Boolean(getField<boolean>(data, "hasNext", 1));
        const pagePairs = (getField<any[]>(data, "pairs", 2) ?? []) as any[];

        for (const p of pagePairs) {
          const addr = normalizeAddress(String(getField<string>(p, "pair_address", 0) ?? ""));
          if (addr && addr !== ZERO_ADDRESS && !byAddr.has(addr)) {
            byAddr.set(addr, p);
          }
        }

        if (!hasNext || pagePairs.length === 0) break;
        offset += pageSize;
        pageCount += 1n;
      }

      return [...byAddr.values()];
    } catch {
      continue;
    }
  }

  throw new Error("Unable to fetch pairs from pair API (all page sizes failed).");
}

interface SubgraphCLPool {
  id: string;
  fee: string;
  deployer?: string;
  totalValueLockedUSD: string;
  totalValueLockedToken0: string;
  totalValueLockedToken1: string;
  sqrtPrice: string;
  liquidity: string;
  tick: string;
  tickSpacing: string;
  lastRewardTimestamp?: string;
  volumeUSD?: string;
  poolDayData?: { volumeUSD: string; feesUSD: string; date: string }[];
  token0: { id: string; symbol: string; name: string; decimals: string };
  token1: { id: string; symbol: string; name: string; decimals: string };
}

async function fetchSubgraphCLPools(): Promise<Map<string, SubgraphCLPool>> {
  const map = new Map<string, SubgraphCLPool>();
  const page = 500;
  for (let skip = 0; skip < 5000; skip += page) {
    try {
      const res = await fetch(SERVER_CONFIG.CL_GRAPH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `{
            pools(first: ${page}, skip: ${skip}) {
              id fee deployer totalValueLockedUSD totalValueLockedToken0 totalValueLockedToken1
              sqrtPrice liquidity tick tickSpacing lastRewardTimestamp volumeUSD
              poolDayData(first: 1, orderBy: date, orderDirection: desc) {
                volumeUSD feesUSD date
              }
              token0 { id symbol name decimals }
              token1 { id symbol name decimals }
            }
          }`,
        }),
      });
      const json = (await res.json()) as { data?: { pools?: SubgraphCLPool[] } };
      const rows = json?.data?.pools ?? [];
      if (rows.length === 0) break;
      for (const row of rows) {
        map.set(normalizeAddress(row.id), row);
      }
      if (rows.length < page) break;
    } catch {
      break;
    }
  }
  return map;
}

function getCurrentEpochStart(epochDuration: number): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.floor(nowSec / epochDuration) * epochDuration;
}

/** Normalize viem decode: batched calls often return `PoolInfo[]` at top level; single-tuple wraps as `{ 0: PoolInfo[] }`. */
function unwrapGetAllPoolInfoResult(infos: any): any[] {
  if (!infos) return [];
  if (Array.isArray(infos)) return infos;
  const slot = infos[0];
  return Array.isArray(slot) ? slot : [];
}

async function fetchAlgebraPoolInfos(poolAddresses: string[]): Promise<any[]> {
  if (poolAddresses.length === 0) return [];
  const out: any[] = [];
  const batchSize = Number(ALGEBRA_INFO_BATCH);
  for (let i = 0; i < poolAddresses.length; i += batchSize) {
    const batch = poolAddresses.slice(i, i + batchSize);
    const raw = (await publicClient.readContract({
      address: ALGEBRA_POOL_API_ADDRESS as `0x${string}`,
      abi: ALGEBRA_POOL_API_ABI,
      functionName: "getAllPoolInfo",
      args: [batch.map((a) => a as `0x${string}`)],
    })) as any;
    out.push(...unwrapGetAllPoolInfoResult(raw));
  }
  return out;
}

async function resolveUnderlyingTokenAddress() {
  return (await publicClient.readContract({
    address: BLACKHOLE_PAIR_API_V2_ADDRESS as `0x${string}`,
    abi: BLACKHOLE_PAIR_ABI,
    functionName: "underlyingToken",
    args: [],
  })) as `0x${string}`;
}

/**
 * Fetches actual CL pool emissions from virtual pool reward rates.
 * Mirrors website's batchGetClEpochEmissionsFromRewardRates:
 *   farmingCenter.virtualPoolAddresses(pool) → virtualPool.rewardRates()[0] × epochDuration
 * Returns emissions per epoch in human-readable units (divided by 10^emissionDecimals).
 */
async function fetchCLEpochEmissions(
  pools: Array<{ address: string; deployer?: string; emissionDecimals: number }>,
  epochDuration: number,
): Promise<Map<string, number>> {
  const emissionsByPool = new Map<string, number>();
  if (pools.length === 0) return emissionsByPool;

  // Group by farming center (legacy vs new)
  const byFarmingCenter = new Map<string, typeof pools>();
  for (const pool of pools) {
    const fc = getFarmingCenterForDeployer(pool.deployer).toLowerCase();
    const group = byFarmingCenter.get(fc) ?? [];
    group.push(pool);
    byFarmingCenter.set(fc, group);
  }

  const poolToVirtualPool = new Map<string, string>();

  for (const [fc, group] of byFarmingCenter) {
    try {
      const results = await publicClient.multicall({
        contracts: group.map((p) => ({
          address: fc as `0x${string}`,
          abi: FARMING_CENTER_VIRTUAL_POOL_ABI,
          functionName: "virtualPoolAddresses" as const,
          args: [p.address as `0x${string}`] as const,
        })),
        allowFailure: true,
      });
      group.forEach((p, i) => {
        const r = results[i];
        const vp = r.status === "success" ? (r.result as string) : null;
        if (vp && vp !== ZERO_ADDRESS) {
          poolToVirtualPool.set(p.address.toLowerCase(), vp.toLowerCase());
        }
      });
    } catch {
      // skip this farming center on error
    }
  }

  const uniqueVPs = [...new Set([...poolToVirtualPool.values()])];
  const vpRates = new Map<string, bigint>();

  if (uniqueVPs.length > 0) {
    try {
      const results = await publicClient.multicall({
        contracts: uniqueVPs.map((vp) => ({
          address: vp as `0x${string}`,
          abi: VIRTUAL_POOL_REWARD_RATES_ABI,
          functionName: "rewardRates" as const,
        })),
        allowFailure: true,
      });
      uniqueVPs.forEach((vp, i) => {
        const r = results[i];
        if (r.status === "success" && r.result) {
          const [rate0] = r.result as [bigint, bigint];
          vpRates.set(vp, rate0);
        }
      });
    } catch {
      // leave map empty
    }
  }

  for (const pool of pools) {
    const vp = poolToVirtualPool.get(pool.address.toLowerCase());
    if (!vp) continue;
    const rate0 = vpRates.get(vp);
    if (rate0 === undefined) continue;
    const rawEpochEmissions = Number(rate0) * epochDuration;
    const decimals = pool.emissionDecimals > 0 ? pool.emissionDecimals : 18;
    emissionsByPool.set(pool.address.toLowerCase(), rawEpochEmissions / 10 ** decimals);
  }

  return emissionsByPool;
}

async function resolveFeePercent(pairAddress: string, stable: boolean) {
  try {
    const feeRaw = (await publicClient.readContract({
      address: PROTOCOL_ADDRESSES.pair_factory,
      abi: PAIR_FACTORY_GET_FEE_ABI,
      functionName: "getFee",
      args: [pairAddress as `0x${string}`, stable],
    })) as bigint;
    return Number(feeRaw) / 100;
  } catch {
    return stable ? 0.04 : 0.18;
  }
}

async function fetchV2FeeMap(
  pairs: Array<{ address: string; stable: boolean }>,
): Promise<Map<string, number>> {
  const map = new Map<string, number>();
  if (pairs.length === 0) return map;
  try {
    const results = await publicClient.multicall({
      contracts: pairs.map(({ address, stable }) => ({
        address: PROTOCOL_ADDRESSES.pair_factory,
        abi: PAIR_FACTORY_GET_FEE_ABI,
        functionName: "getFee" as const,
        args: [address as `0x${string}`, stable] as const,
      })),
      allowFailure: true,
    });
    for (let i = 0; i < pairs.length; i++) {
      const r = results[i];
      const fallback = pairs[i].stable ? 0.04 : 0.18;
      map.set(pairs[i].address, r.status === "success" ? Number(r.result as bigint) / 100 : fallback);
    }
  } catch {
    for (const { address, stable } of pairs) map.set(address, stable ? 0.04 : 0.18);
  }
  return map;
}

export function extractBribeTokens(
  bribesObj: any,
  tokenPrices: Map<string, TokenPricing>,
  type: "fee" | "bribe",
  namedFields: boolean,
): { usd: number; tokens: RewardToken[] } {
  if (!bribesObj) return { usd: 0, tokens: [] };
  const tokens: string[] = namedFields
    ? ((bribesObj.tokens ?? []) as string[])
    : ((getField<string[]>(bribesObj, "tokens", 1) ?? []) as string[]);
  const amounts: bigint[] = namedFields
    ? ((bribesObj.amounts ?? []) as bigint[])
    : ((getField<bigint[]>(bribesObj, "amounts", 4) ?? []) as bigint[]);
  const decimalsArr: bigint[] = namedFields
    ? ((bribesObj.decimals ?? []) as bigint[])
    : ((getField<bigint[]>(bribesObj, "decimals", 3) ?? []) as bigint[]);

  let usd = 0;
  const rewardTokens: RewardToken[] = [];
  for (let i = 0; i < tokens.length; i++) {
    const tokenAddr = normalizeAddress(tokens[i]);
    if (!tokenAddr || tokenAddr === ZERO_ADDRESS) continue;
    const pricing = tokenPrices.get(tokenAddr);
    const tokenDecimals = Number(decimalsArr[i] ?? 18n);
    const amount = toDecimal(amounts[i] ?? 0n, tokenDecimals);
    const tokenUsd = amount * (pricing?.usdPrice ?? 0);
    usd += tokenUsd;
    if (amount > 0) {
      rewardTokens.push({
        address: tokenAddr,
        symbol: pricing?.symbol ?? "",
        amountPerEpoch: amount,
        usdPerEpoch: tokenUsd,
        type,
      });
    }
  }
  return { usd, tokens: rewardTokens };
}

function computePoolMetric(
  pair: any,
  tokenPrices: Map<string, TokenPricing>,
  underlyingTokenAddress: string,
  epochDuration: number,
  feePercent: number,
): PoolMetric {
  const pairAddress = String(getField<string>(pair, "pair_address", 0) ?? ZERO_ADDRESS);
  const symbol = String(getField<string>(pair, "symbol", 1) ?? "");
  const name = String(getField<string>(pair, "name", 2) ?? symbol);
  const stable = Boolean(getField<boolean>(pair, "stable", 4) ?? false);
  const pairDecimals = Number(getField<bigint | number>(pair, "decimals", 3) ?? 18);

  const gaugeAddress = normalizeAddress(
    String(getField<string>(pair, "gauge", 15) ?? ZERO_ADDRESS),
  );
  const token0 = normalizeAddress(String(getField<string>(pair, "token0", 6) ?? ZERO_ADDRESS));
  const token1 = normalizeAddress(String(getField<string>(pair, "token1", 11) ?? ZERO_ADDRESS));
  const token0Decimals = Number(getField<bigint | number>(pair, "token0_decimals", 8) ?? 18);
  const token1Decimals = Number(getField<bigint | number>(pair, "token1_decimals", 13) ?? 18);

  const reserve0 = toDecimal(getField<bigint>(pair, "reserve0", 9), token0Decimals);
  const reserve1 = toDecimal(getField<bigint>(pair, "reserve1", 14), token1Decimals);
  const price0 = tokenPrices.get(token0)?.usdPrice ?? 0;
  const price1 = tokenPrices.get(token1)?.usdPrice ?? 0;
  const tvlUsd = reserve0 * price0 + reserve1 * price1;

  const stakedFee0 = toDecimal(getField<bigint>(pair, "staked_token0_fees", 28), token0Decimals);
  const stakedFee1 = toDecimal(getField<bigint>(pair, "staked_token1_fees", 29), token1Decimals);
  const feesUsd = stakedFee0 * price0 + stakedFee1 * price1;

  const totalSupply = toDecimal(getField<bigint>(pair, "total_supply", 5), pairDecimals);
  const gaugeTotalSupply = toDecimal(getField<bigint>(pair, "gauge_total_supply", 17), pairDecimals);
  const votes = toDecimal(getField<bigint>(pair, "votes", 27), 18);
  const totalEmissions = toDecimal(getField<bigint>(pair, "total_emissions", 19), pairDecimals);
  const underlyingPrice = tokenPrices.get(normalizeAddress(underlyingTokenAddress))?.usdPrice ?? 0;

  const internalBribes = getField<any>(pair, "internal_bribes", 30);
  const externalBribes = getField<any>(pair, "external_bribes", 31);
  const { usd: internalBribesUsd, tokens: feeTokens } = extractBribeTokens(internalBribes, tokenPrices, "fee", false);
  const { usd: externalBribesUsd, tokens: bribeTokens } = extractBribeTokens(externalBribes, tokenPrices, "bribe", false);

  const votesUsd = votes * underlyingPrice;
  const emissionsUsdPerEpoch = totalEmissions * underlyingPrice;
  const lockedTvlUsd =
    totalSupply > 0 ? tvlUsd * (gaugeTotalSupply / totalSupply) : 0;
  const epochsPerYear = Math.floor((365 * 24 * 60 * 60) / epochDuration);
  const apr =
    lockedTvlUsd > 0 ? (emissionsUsdPerEpoch * epochsPerYear * 100) / lockedTvlUsd : 0;
  const vapr =
    votesUsd > 0 ? ((internalBribesUsd + externalBribesUsd) * 5200) / votesUsd : 0;

  const volumeUsd = computeVolumeFromFees(feesUsd, feePercent);

  return {
    pairAddress,
    name,
    symbol,
    stable,
    concentrated: false,
    feePercent,
    tvlUsd,
    feesUsd,
    volumeUsd,
    apr,
    vapr,
    votes,
    votesUsd,
    emissionsUsdPerEpoch,
    totalSupply,
    gaugeTotalSupply,
    lockedTvlUsd,
    gaugeAddress,
    token0: {
      address: token0,
      symbol: tokenPrices.get(token0)?.symbol ?? "",
      decimals: token0Decimals,
    },
    token1: {
      address: token1,
      symbol: tokenPrices.get(token1)?.symbol ?? "",
      decimals: token1Decimals,
    },
    tvlToken0: reserve0,
    tvlToken1: reserve1,
    feesToken0: stakedFee0,
    feesToken1: stakedFee1,
    rewardTokens: [...feeTokens, ...bribeTokens],
  };
}

function computeAlgebraPoolMetric(
  pool: any,
  tokenPrices: Map<string, TokenPricing>,
  subgraphPool: SubgraphCLPool | undefined,
  underlyingTokenAddress: string,
  epochDuration: number,
  /** Override emissions with value from virtualPool.rewardRates (mirrors website). When undefined, falls back to pool.total_emissions. */
  emissionsOverride?: number,
): PoolMetric {
  const pairAddress = String(pool.pair_address ?? subgraphPool?.id ?? ZERO_ADDRESS);
  const rawPairDecimals = Number(pool.decimals ?? 18);
  const lpDecimals = rawPairDecimals > 0 ? rawPairDecimals : 18;
  const emissionTokDec = Number(pool.emissions_token_decimals ?? 18);

  // Prefer subgraph token metadata (symbol/name/decimals). Fall back to pair API.
  const token0 = normalizeAddress(
    String(subgraphPool?.token0?.id ?? pool.token0 ?? ZERO_ADDRESS),
  );
  const token1 = normalizeAddress(
    String(subgraphPool?.token1?.id ?? pool.token1 ?? ZERO_ADDRESS),
  );
  const token0Decimals = Number(
    subgraphPool?.token0?.decimals ?? pool.token0_decimals ?? 18,
  );
  const token1Decimals = Number(
    subgraphPool?.token1?.decimals ?? pool.token1_decimals ?? 18,
  );
  const token0Symbol = String(subgraphPool?.token0?.symbol ?? pool.token0_symbol ?? "");
  const token1Symbol = String(subgraphPool?.token1?.symbol ?? pool.token1_symbol ?? "");
  const token0Name = String(subgraphPool?.token0?.name ?? token0Symbol);
  const token1Name = String(subgraphPool?.token1?.name ?? token1Symbol);
  const tickSpacing = resolveCLTickSpacing(subgraphPool?.tickSpacing, pool.tickSpacing);
  // CL stable = tickSpacing ≤ 1 (matches pairFetcher logic); subgraph never sets pool.stable for CL pools
  const stable = tickSpacing !== undefined ? tickSpacing <= 1 : Boolean(pool.stable ?? false);

  const baseSymbol = String(pool.symbol || "") || `${token0Symbol}/${token1Symbol}`;
  const baseName =
    String(pool.name || "") || `${token0Name}/${token1Name}`;
  const symbol =
    tickSpacing !== undefined
      ? formatCLPoolSymbol(tickSpacing, token0Symbol, token1Symbol)
      : baseSymbol;
  const name =
    tickSpacing !== undefined ? formatCLPoolName(tickSpacing, token0Name, token1Name) : baseName;

  const stakedFee0 = toDecimal(pool.staked_token0_fees, token0Decimals);
  const stakedFee1 = toDecimal(pool.staked_token1_fees, token1Decimals);
  const price0 = tokenPrices.get(token0)?.usdPrice ?? 0;
  const price1 = tokenPrices.get(token1)?.usdPrice ?? 0;
  const feesUsd = stakedFee0 * price0 + stakedFee1 * price1;

  // For CL pools, totalSupply is repurposed as active liquidity (from subgraph).
  const totalSupply = subgraphPool
    ? Number(subgraphPool.liquidity ?? 0)
    : toDecimal(pool.total_supply, lpDecimals);
  const votes = toDecimal(pool.votes, 18);
  // Prefer live on-chain rewardRate × epoch (mirrors website); fall back to pool API total_emissions.
  const totalEmissions = emissionsOverride !== undefined
    ? emissionsOverride
    : toDecimal(pool.total_emissions, emissionTokDec);
  const underlyingPrice =
    tokenPrices.get(normalizeAddress(underlyingTokenAddress))?.usdPrice ?? 0;

  const internalBribes = pool.internal_bribes;
  const externalBribes = pool.external_bribes;
  const { usd: internalBribesUsd, tokens: feeTokens } = extractBribeTokens(internalBribes, tokenPrices, "fee", true);
  const { usd: externalBribesUsd, tokens: bribeTokens } = extractBribeTokens(externalBribes, tokenPrices, "bribe", true);

  // TVL for ranking = full pool TVL from subgraph.
  const tvlUsd = Number(subgraphPool?.totalValueLockedUSD ?? 0);

  // In-range TVL = USD value of a dummy position at current tick across one
  // tickSpacing, sized with pool's active liquidity. Mirrors client math.
  let poolPositionTvl = 0;
  if (
    subgraphPool &&
    subgraphPool.sqrtPrice &&
    subgraphPool.liquidity &&
    subgraphPool.tick !== undefined &&
    subgraphPool.tick !== null &&
    tickSpacing !== undefined
  ) {
    try {
      const activeLiquidityRaw = BigInt(subgraphPool.liquidity);
      if (activeLiquidityRaw > 0n) {
        const { amount0Raw, amount1Raw } = computeInRangePositionAmounts({
          sqrtPriceX96: BigInt(subgraphPool.sqrtPrice),
          tickCurrent: Number(subgraphPool.tick),
          tickSpacing,
          activeLiquidityRaw,
        });
        const amount0Human = Number(amount0Raw) / 10 ** token0Decimals;
        const amount1Human = Number(amount1Raw) / 10 ** token1Decimals;
        poolPositionTvl = amount0Human * price0 + amount1Human * price1;
      }
    } catch {
      // fall through with poolPositionTvl = 0
    }
  }

  const votesUsd = votes * underlyingPrice;
  const emissionsUsdPerEpoch = totalEmissions * underlyingPrice;

  // APR is gated: only emit non-zero when lastRewardTimestamp is in current epoch.
  const currentEpochStart = getCurrentEpochStart(epochDuration);
  const lastRewardTs = Number(subgraphPool?.lastRewardTimestamp ?? 0);
  const isLastRewardInCurrentEpoch = lastRewardTs > currentEpochStart;

  const epochsPerYear = Math.floor((365 * 24 * 60 * 60) / epochDuration);
  const apr =
    isLastRewardInCurrentEpoch && poolPositionTvl > 0
      ? (emissionsUsdPerEpoch * epochsPerYear * 100) / poolPositionTvl
      : 0;
  const vapr =
    votesUsd > 0 ? ((internalBribesUsd + externalBribesUsd) * 5200) / votesUsd : 0;

  const feePercent =
    Number(subgraphPool?.fee ?? pool.fee ?? 0) / 10000;

  const volumeUsd = computeVolumeFromFees(feesUsd, feePercent);

  return {
    pairAddress,
    name,
    symbol,
    stable,
    concentrated: true,
    feePercent,
    tvlUsd,
    feesUsd,
    volumeUsd,
    apr,
    vapr,
    votes,
    votesUsd,
    emissionsUsdPerEpoch,
    totalSupply,
    gaugeTotalSupply: 0,
    lockedTvlUsd: tvlUsd,
    gaugeAddress: normalizeAddress(String(pool.gauge ?? ZERO_ADDRESS)),
    token0: {
      address: token0,
      symbol: token0Symbol || (tokenPrices.get(token0)?.symbol ?? ""),
      decimals: token0Decimals,
    },
    token1: {
      address: token1,
      symbol: token1Symbol || (tokenPrices.get(token1)?.symbol ?? ""),
      decimals: token1Decimals,
    },
    tvlToken0: Number(subgraphPool?.totalValueLockedToken0 ?? 0),
    tvlToken1: Number(subgraphPool?.totalValueLockedToken1 ?? 0),
    feesToken0: stakedFee0,
    feesToken1: stakedFee1,
    rewardTokens: [...feeTokens, ...bribeTokens],
    ...(tickSpacing !== undefined ? { tickSpacing } : {}),
  };
}

async function fetchGaugePeriodFinishMap(
  gauges: string[],
): Promise<Map<string, bigint>> {
  const map = new Map<string, bigint>();
  const unique = [...new Set(gauges.map((g) => g.toLowerCase()))].filter(
    (g) => g && g !== ZERO_ADDRESS,
  );
  if (unique.length === 0) return map;

  try {
    const results = await publicClient.multicall({
      contracts: unique.map((g) => ({
        address: g as `0x${string}`,
        abi: GAUGE_PERIOD_FINISH_ABI,
        functionName: "periodFinish" as const,
      })),
      allowFailure: true,
    });
    unique.forEach((gauge, i) => {
      const r = results[i];
      map.set(
        gauge,
        r && r.status === "success" ? (r.result as bigint) : 0n,
      );
    });
  } catch {
    // leave map empty so callers treat all gauges as expired (APR=0)
  }
  return map;
}

/**
 * Mirrors client's applyBasicPoolEmissionChecks: when gauge.periodFinish < now,
 * zero out emissions + APR for that v2 pool.
 */
function applyV2PeriodFinishGate(
  metrics: PoolMetric[],
  periodFinishByGauge: Map<string, bigint>,
): void {
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  for (const m of metrics) {
    if (m.concentrated) continue;
    if (!m.gaugeAddress || m.gaugeAddress === ZERO_ADDRESS) continue;
    const periodFinish = periodFinishByGauge.get(m.gaugeAddress.toLowerCase()) ?? 0n;
    if (periodFinish < nowSec) {
      m.emissionsUsdPerEpoch = 0;
      m.apr = 0;
    }
  }
}

function formatMetric(metric: PoolMetric) {
  return {
    pairAddress: metric.pairAddress,
    name: metric.name,
    symbol: metric.symbol,
    ...(metric.concentrated && metric.tickSpacing !== undefined
      ? { tickSpacing: metric.tickSpacing }
      : {}),
    poolType: metric.concentrated ? "concentrated" : metric.stable ? "stable" : "volatile",
    feePercent: Number(metric.feePercent.toFixed(4)),
    tvlUsd: Number(metric.tvlUsd.toFixed(2)),
    tvlToken0Amount: Number(metric.tvlToken0.toFixed(6)),
    tvlToken1Amount: Number(metric.tvlToken1.toFixed(6)),
    feesUsd: Number(metric.feesUsd.toFixed(2)),
    feesToken0Amount: Number(metric.feesToken0.toFixed(6)),
    feesToken1Amount: Number(metric.feesToken1.toFixed(6)),
    volumeUsd: Number(metric.volumeUsd.toFixed(2)),
    apr: Number(metric.apr.toFixed(2)),
    vapr: Number(metric.vapr.toFixed(2)),
    votes: Number(metric.votes.toFixed(2)),
    token0: metric.token0,
    token1: metric.token1,
    /** Voting reward tokens voters receive this epoch (internal fee shares + external bribes). */
    rewardTokens: metric.rewardTokens.map((rt) => ({
      address: rt.address,
      symbol: rt.symbol,
      amountPerEpoch: Number(rt.amountPerEpoch.toFixed(6)),
      usdPerEpoch: Number(rt.usdPerEpoch.toFixed(2)),
      type: rt.type,
    })),
  };
}

function passesPoolType(metric: PoolMetric, poolType: PoolTypeFilter): boolean {
  switch (poolType) {
    case "all":
      return true;
    case "basic":
      return !metric.concentrated;
    case "concentrated":
      return metric.concentrated;
    case "stable":
      return metric.stable;
    case "volatile":
      return !metric.stable;
    case "basic_stable":
      return !metric.concentrated && metric.stable;
    case "basic_volatile":
      return !metric.concentrated && !metric.stable;
    case "concentrated_stable":
      return metric.concentrated && metric.stable;
    case "concentrated_volatile":
      return metric.concentrated && !metric.stable;
  }
}

function passesRange(value: number, range?: RangeFilter): boolean {
  if (!range) return true;
  if (range.min !== undefined && value < range.min) return false;
  if (range.max !== undefined && value > range.max) return false;
  return true;
}

export async function handlePoolYield(params: PoolYieldParams) {
  const {
    userAddress = ZERO_ADDRESS,
    poolAddress,
    topN = 10,
    sortBy = "apr",
    sortOrder = "desc",
    poolType = "all",
    search,
    hasGauge,
    apr,
    vapr,
    tvl,
    fees,
    votes: votesRange,
  } = params;

  const epochSeconds = getEpochDurationSeconds();
  const [tokenPricingMap, v2Pairs, subgraphCLPools, underlyingTokenAddress] = await Promise.all([
    fetchTokenPricingMap(),
    fetchAllV2Pairs(userAddress),
    fetchSubgraphCLPools(),
    resolveUnderlyingTokenAddress(),
  ]);

  const v2AddrSet = new Set(
    v2Pairs.map((p) => normalizeAddress(String(getField<string>(p, "pair_address", 0) ?? ""))),
  );
  const algebraAddrs = [...subgraphCLPools.keys()].filter((a) => a && !v2AddrSet.has(a));

  const v2FeeInputs = v2Pairs.map((p) => ({
    address: normalizeAddress(String(getField<string>(p, "pair_address", 0) ?? "")),
    stable: Boolean(getField<boolean>(p, "stable", 4) ?? false),
  }));

  const [algebraPools, v2FeeMap] = await Promise.all([
    fetchAlgebraPoolInfos(algebraAddrs),
    fetchV2FeeMap(v2FeeInputs),
  ]);

  // Fetch live on-chain emissions from virtualPool.rewardRates (mirrors website).
  const clEmissionTargets = algebraAddrs.map((addr) => {
    const sgPool = subgraphCLPools.get(addr);
    return {
      address: addr,
      deployer: sgPool?.deployer,
      emissionDecimals: 18,
    };
  });
  const clEpochEmissions = await fetchCLEpochEmissions(clEmissionTargets, epochSeconds);

  const v2PoolCount = v2Pairs.length;
  const clPoolCount = algebraPools.length;

  let metrics: PoolMetric[] = [
    ...v2Pairs.map((pair) => {
      const addr = normalizeAddress(String(getField<string>(pair, "pair_address", 0) ?? ""));
      const stable = Boolean(getField<boolean>(pair, "stable", 4) ?? false);
      const fp = v2FeeMap.get(addr) ?? (stable ? 0.04 : 0.18);
      return computePoolMetric(pair, tokenPricingMap, underlyingTokenAddress, epochSeconds, fp);
    }),
    ...algebraPools.map((pool) => {
      const poolAddr = normalizeAddress(String(pool.pair_address ?? ""));
      return computeAlgebraPoolMetric(
        pool,
        tokenPricingMap,
        subgraphCLPools.get(poolAddr),
        underlyingTokenAddress,
        epochSeconds,
        clEpochEmissions.get(poolAddr),
      );
    }),
  ];

  const v2Gauges = metrics
    .filter((m) => !m.concentrated && m.gaugeAddress && m.gaugeAddress !== ZERO_ADDRESS)
    .map((m) => m.gaugeAddress);
  const periodFinishByGauge = await fetchGaugePeriodFinishMap(v2Gauges);
  applyV2PeriodFinishGate(metrics, periodFinishByGauge);

  metrics = metrics.filter((m) => passesPoolType(m, poolType));
  if (hasGauge) {
    metrics = metrics.filter(
      (m) => m.gaugeAddress && m.gaugeAddress !== ZERO_ADDRESS,
    );
  }
  if (search && search.trim()) {
    const needle = search.trim().toLowerCase();
    metrics = metrics.filter(
      (m) =>
        m.symbol.toLowerCase().includes(needle) ||
        m.name.toLowerCase().includes(needle) ||
        m.pairAddress.toLowerCase().includes(needle),
    );
  }
  metrics = metrics.filter(
    (m) =>
      passesRange(m.apr, apr) &&
      passesRange(m.vapr, vapr) &&
      passesRange(m.tvlUsd, tvl) &&
      passesRange(m.feesUsd, fees) &&
      passesRange(m.votes, votesRange),
  );

  if (poolAddress) {
    const target = metrics.find(
      (m) => normalizeAddress(m.pairAddress) === normalizeAddress(poolAddress),
    );
    if (!target) {
      throw new Error("Pool not found in fetched V2 + concentrated pools for the current environment.");
    }

    if (!target.concentrated) {
      target.feePercent = await resolveFeePercent(target.pairAddress, target.stable);
    }

    return {
      success: true,
      message: "Computed APR/vAPR details for pool.",
      data: formatMetric(target),
      meta: {
        totalPoolsScanned: metrics.length,
        v2PoolCount,
        clPoolCount,
        sortBy,
      },
    };
  }

  const sorted = [...metrics].sort((a, b) => {
    const va = (a[sortBy] as number) ?? 0;
    const vb = (b[sortBy] as number) ?? 0;
    return sortOrder === "asc" ? va - vb : vb - va;
  });
  const top = sorted.slice(0, Math.max(1, topN));

  await Promise.all(
    top.map(async (item) => {
      if (!item.concentrated) {
        item.feePercent = await resolveFeePercent(item.pairAddress, item.stable);
      }
    }),
  );

  const allMetrics = metrics; // after filters, before topN slice
  const typeGroups: Record<string, PoolMetric[]> = {
    basic_stable: allMetrics.filter((m) => !m.concentrated && m.stable),
    basic_volatile: allMetrics.filter((m) => !m.concentrated && !m.stable),
    concentrated_stable: allMetrics.filter((m) => m.concentrated && m.stable),
    concentrated_volatile: allMetrics.filter((m) => m.concentrated && !m.stable),
  };
  const poolTypeSummary = Object.fromEntries(
    Object.entries(typeGroups).map(([type, pools]) => [
      type,
      {
        count: pools.length,
        tvlUsd: Number(pools.reduce((s, p) => s + p.tvlUsd, 0).toFixed(2)),
        feesUsd: Number(pools.reduce((s, p) => s + p.feesUsd, 0).toFixed(2)),
        volumeUsd: Number(pools.reduce((s, p) => s + p.volumeUsd, 0).toFixed(2)),
      },
    ]),
  );

  return {
    success: true,
    message: "Computed top pool APR/vAPR list.",
    data: top.map(formatMetric),
    meta: {
      totalPoolsScanned: metrics.length,
      v2PoolCount,
      clPoolCount,
      returned: top.length,
      sortBy,
      sortOrder,
      poolType,
      hasGauge: hasGauge ?? false,
      search: search ?? "",
      apr,
      vapr,
      tvl,
      fees,
      votes: votesRange,
      poolTypeSummary,
    },
  };
}

export const poolYieldTool = {
  name: "pool_yield",
  description:
    "Pool liquidity and yield metrics. **Two different roles** (never add their APRs as one 'total'):\n\n1) **LP** — **`apr`** = annualized **gauge emissions** (e.g. BLACK) to **staked liquidity** on that gauge, as a **snapshot**: same epoch emissions spread over the **staked liquidity base** already baked into the formula (V2: staked fraction of pool TVL; CL: active-liquidity proxy). When **adding LP** (especially if staked on the gauge), if your new size is a **large share** of that existing base, headline **apr** **falls** afterward — more wallets split the same emissions (dilution). Use **`apr`**, **`feesUsd`**, **`tvlUsd`**, **`volumeUsd`** for where to deploy liquidity, but account for dilution when **sizing large LP additions**.\n\n2) **Voter (veBLACK)** — **`vapr`** = implied annualized **voter** return (internal voter fees + **external bribes**) per **$1 of vote weight** on that gauge, using **vote power already on this gauge** as the denominator (same basis as the row’s **`votes`** field, priced to USD inside the formula). It is a **snapshot for current voters**: if someone adds vote power that is a **large share** of that existing weight, headline vAPR **drops** after they vote (simple dilution). Not LP yield. **`rewardTokens`** = tokens **voters** earn this epoch on that gauge. For **which gauge to vote for** and dilution math, prefer **`vote_leaderboard`**.\n\nConcentrated pools: `symbol` / `name` include tick spacing when known; `tickSpacing` is returned.\n\n`meta.poolTypeSummary`: TVL, fees, volume by pool type.\n\nUSAGE: **LP discovery** → `sortBy='apr'` | `'feesUsd'` | `'tvlUsd'` | `'volumeUsd'`; optional `hasGauge=true`. **Votes / bribes** → **`vote_leaderboard`**. List mode uses `topN` pagination.",
  inputSchema: {
    type: "object",
    properties: {
      userAddress: { type: "string", description: "Optional user address context for pair API pagination." },
      poolAddress: { type: "string", description: "Optional specific pool address for single-pool metrics." },
      topN: { type: "number", description: "Top N pools to return when poolAddress is not provided (default 10)." },
      sortBy: {
        type: "string",
        enum: ["apr", "vapr", "tvlUsd", "feesUsd", "votes", "volumeUsd"],
        description:
          "Rank pools by one field. **apr** — LP gauge emissions vs **current staked-liquidity base** in the formula; headline **apr** **falls** if you add LP that is a **large fraction** of that base (dilution). **vapr** — voter-side yield vs **existing** vote weight; headline vAPR **falls** if you add vote power that is a **large fraction** of that weight. For vote decisions use **vote_leaderboard**. **tvlUsd** / **feesUsd** / **volumeUsd** — size, staked fees, activity. **votes** — raw vote weight on gauge (not LP yield).",
      },
      sortOrder: { type: "string", enum: ["asc", "desc"], description: "Sort direction (default desc)." },
      poolType: {
        type: "string",
        enum: [
          "all",
          "basic",
          "concentrated",
          "stable",
          "volatile",
          "basic_stable",
          "basic_volatile",
          "concentrated_stable",
          "concentrated_volatile",
        ],
        description: "Pool category filter mirroring the UI tabs (default 'all').",
      },
      search: { type: "string", description: "Case-insensitive substring match against pool symbol, name, or pairAddress." },
      hasGauge: { type: "boolean", description: "When true, only return pools with a gauge attached." },
      apr: {
        type: "object",
        description: "LP emissions APR range filter (uses **current** staked-liquidity base in the metric; large new LP dilutes headline apr).",
        properties: { min: { type: "number" }, max: { type: "number" } },
      },
      vapr: {
        type: "object",
        description: "Filter by **voter-side** vAPR (uses **existing** votes on each gauge as denominator); irrelevant for pure LP filters.",
        properties: { min: { type: "number" }, max: { type: "number" } },
      },
      tvl: {
        type: "object",
        description: "TVL (USD) range filter.",
        properties: { min: { type: "number" }, max: { type: "number" } },
      },
      fees: {
        type: "object",
        description: "Fees (USD) range filter.",
        properties: { min: { type: "number" }, max: { type: "number" } },
      },
      votes: {
        type: "object",
        description: "Votes range filter.",
        properties: { min: { type: "number" }, max: { type: "number" } },
      },
    },
  },
};
