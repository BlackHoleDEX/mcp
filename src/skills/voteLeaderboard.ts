import { SERVER_CONFIG } from "../config.js";
import {
  ALGEBRA_POOL_API_ABI,
  ALGEBRA_POOL_API_ADDRESS,
  BLACKHOLE_PAIR_ABI,
  BLACKHOLE_PAIR_API_V2_ADDRESS,
} from "../constants/contracts.js";
import { formatCLPoolSymbol, resolveCLTickSpacing } from "../utils/clPoolLabel.js";
import { publicClient } from "../utils/viemClient.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const V2_PAGE_SIZES = [100n, 50n];
const MAX_V2_PAGES = 40n;
const ALGEBRA_INFO_BATCH = 40n;
/** 52 epochs/year × 100 = 5200, matches pool_yield vAPR formula. */
const VAPR_MULTIPLIER = 5200;

type SortBy = "votes" | "vapr" | "emissionsUsd" | "externalBribesUsd" | "internalBribesUsd" | "totalBribesUsd";

interface TokenInfo {
  address: string;
  symbol: string;
  decimals: number;
  usdPrice: number;
}

interface RewardToken {
  address: string;
  symbol: string;
  amountPerEpoch: string;
  usdPerEpoch: string;
  /** "fee" = internal bribe (LP trading-fee share to voters); "bribe" = external incentive. */
  type: "fee" | "bribe";
}

interface GaugeEntry {
  poolAddress: string;
  gaugeAddress: string;
  symbol: string;
  poolType: string;
  /** Present for concentrated pools when tick spacing is known. */
  tickSpacing?: number;
  tvlUsd: number;
  votes: number;
  votesUsd: number;
  vapr: number;
  emissionsUsd: number;
  externalBribesUsd: number;
  internalBribesUsd: number;
  totalBribesUsd: number;
  rewardTokens: RewardToken[];
}

export interface VoteLeaderboardParams {
  topN?: number;
  sortBy?: SortBy;
  sortOrder?: "asc" | "desc";
  /** Minimum raw vote weight (`votes`) on the gauge to include a row. **Preferred** for dilution logic: same units as row `votes` and as `extra` in `extra/(votes+extra)`. */
  minVotes?: number;
  /** Optional USD floor on `votesUsd` (= votes × BLACK price). Use only if you want a dollar threshold; for "my ve power vs existing votes" dilution, use **`minVotes`** so units match. */
  minVotesUsd?: number;
  poolType?: "all" | "basic" | "concentrated";
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

function getField<T = any>(value: any, key: string, index: number): T | undefined {
  return (value?.[key] ?? value?.[index]) as T | undefined;
}

async function fetchTokenPricing(): Promise<Map<string, TokenInfo>> {
  const map = new Map<string, TokenInfo>();
  try {
    const res = await fetch("https://resources.blackhole.xyz/token-details.json");
    const data = (await res.json()) as Record<string, any>;
    for (const [key, token] of Object.entries(data ?? {})) {
      const address = normalizeAddress((token as any)?.address ?? key);
      map.set(address, {
        address,
        symbol: String((token as any)?.ticker ?? ""),
        decimals: Number((token as any)?.decimal ?? 18),
        usdPrice: Number((token as any)?.usd_pricing ?? 0),
      });
    }
  } catch {}
  return map;
}

async function fetchAllV2Pairs(): Promise<any[]> {
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
          args: [ZERO_ADDRESS as `0x${string}`, pageSize, offset],
        })) as any;
        const hasNext = Boolean(getField<boolean>(data, "hasNext", 1));
        const pagePairs = (getField<any[]>(data, "pairs", 2) ?? []) as any[];
        for (const p of pagePairs) {
          const addr = normalizeAddress(String(getField<string>(p, "pair_address", 0) ?? ""));
          if (addr && addr !== ZERO_ADDRESS && !byAddr.has(addr)) byAddr.set(addr, p);
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
  throw new Error("Unable to fetch pairs from pair API.");
}

interface SubgraphPoolStub {
  id: string;
  totalValueLockedUSD: string;
  tickSpacing?: string;
}

async function fetchCLPoolStubs(): Promise<Map<string, SubgraphPoolStub>> {
  const map = new Map<string, SubgraphPoolStub>();
  const page = 500;
  for (let skip = 0; skip < 5000; skip += page) {
    try {
      const res = await fetch(SERVER_CONFIG.CL_GRAPH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `{ pools(first: ${page}, skip: ${skip}) { id totalValueLockedUSD tickSpacing } }`,
        }),
      });
      const json = (await res.json()) as { data?: { pools?: SubgraphPoolStub[] } };
      const rows = json?.data?.pools ?? [];
      if (rows.length === 0) break;
      for (const row of rows) map.set(normalizeAddress(row.id), row);
      if (rows.length < page) break;
    } catch {
      break;
    }
  }
  return map;
}

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

export function parseBribeTokens(
  bribesObj: any,
  tokenMap: Map<string, TokenInfo>,
  type: "fee" | "bribe",
  namedFields: boolean,
): { usd: number; tokens: RewardToken[] } {
  if (!bribesObj) return { usd: 0, tokens: [] };
  const addresses: string[] = namedFields
    ? ((bribesObj.tokens ?? []) as string[])
    : ((getField<string[]>(bribesObj, "tokens", 1) ?? []) as string[]);
  const amounts: bigint[] = namedFields
    ? ((bribesObj.amounts ?? []) as bigint[])
    : ((getField<bigint[]>(bribesObj, "amounts", 4) ?? []) as bigint[]);
  const decimalsArr: bigint[] = namedFields
    ? ((bribesObj.decimals ?? []) as bigint[])
    : ((getField<bigint[]>(bribesObj, "decimals", 3) ?? []) as bigint[]);

  let usd = 0;
  const tokens: RewardToken[] = [];
  for (let i = 0; i < addresses.length; i++) {
    const addr = normalizeAddress(addresses[i]);
    if (!addr || addr === ZERO_ADDRESS) continue;
    const dec = Number(decimalsArr[i] ?? 18n);
    const amount = toDecimal(amounts[i] ?? 0n, dec);
    if (amount === 0) continue;
    const info = tokenMap.get(addr);
    const tokenUsd = amount * (info?.usdPrice ?? 0);
    usd += tokenUsd;
    tokens.push({
      address: addr,
      symbol: info?.symbol ?? "",
      amountPerEpoch: amount.toFixed(6),
      usdPerEpoch: tokenUsd.toFixed(2),
      type,
    });
  }
  return { usd, tokens };
}

function buildV2Entry(
  pair: any,
  tokenMap: Map<string, TokenInfo>,
  underlyingPrice: number,
): GaugeEntry | null {
  const gaugeAddress = normalizeAddress(String(getField<string>(pair, "gauge", 15) ?? ZERO_ADDRESS));
  if (!gaugeAddress || gaugeAddress === ZERO_ADDRESS) return null;

  const pairAddress = normalizeAddress(String(getField<string>(pair, "pair_address", 0) ?? ZERO_ADDRESS));
  const symbol = String(getField<string>(pair, "symbol", 1) ?? "");
  const stable = Boolean(getField<boolean>(pair, "stable", 4) ?? false);
  const pairDecimals = Number(getField<bigint | number>(pair, "decimals", 3) ?? 18);

  const token0 = normalizeAddress(String(getField<string>(pair, "token0", 6) ?? ZERO_ADDRESS));
  const token1 = normalizeAddress(String(getField<string>(pair, "token1", 11) ?? ZERO_ADDRESS));
  const token0Dec = Number(getField<bigint | number>(pair, "token0_decimals", 8) ?? 18);
  const token1Dec = Number(getField<bigint | number>(pair, "token1_decimals", 13) ?? 18);
  const reserve0 = toDecimal(getField<bigint>(pair, "reserve0", 9), token0Dec);
  const reserve1 = toDecimal(getField<bigint>(pair, "reserve1", 14), token1Dec);
  const price0 = tokenMap.get(token0)?.usdPrice ?? 0;
  const price1 = tokenMap.get(token1)?.usdPrice ?? 0;
  const tvlUsd = reserve0 * price0 + reserve1 * price1;

  const votes = toDecimal(getField<bigint>(pair, "votes", 27), 18);
  const totalEmissions = toDecimal(getField<bigint>(pair, "total_emissions", 19), pairDecimals);
  const votesUsd = votes * underlyingPrice;
  const emissionsUsd = totalEmissions * underlyingPrice;

  const { usd: feeUsd, tokens: feeTokens } = parseBribeTokens(getField<any>(pair, "internal_bribes", 30), tokenMap, "fee", false);
  const { usd: bribeUsd, tokens: bribeTokens } = parseBribeTokens(getField<any>(pair, "external_bribes", 31), tokenMap, "bribe", false);
  const vapr = votesUsd > 0 ? ((feeUsd + bribeUsd) * VAPR_MULTIPLIER) / votesUsd : 0;

  return {
    poolAddress: pairAddress,
    gaugeAddress,
    symbol,
    poolType: stable ? "stable" : "volatile",
    tvlUsd,
    votes,
    votesUsd,
    vapr,
    emissionsUsd,
    externalBribesUsd: bribeUsd,
    internalBribesUsd: feeUsd,
    totalBribesUsd: feeUsd + bribeUsd,
    rewardTokens: [...feeTokens, ...bribeTokens],
  };
}

function buildCLEntry(
  pool: any,
  tokenMap: Map<string, TokenInfo>,
  underlyingPrice: number,
  subgraphTvl: number,
  subgraphStub?: SubgraphPoolStub,
): GaugeEntry | null {
  const gaugeAddress = normalizeAddress(String(pool.gauge ?? ZERO_ADDRESS));
  if (!gaugeAddress || gaugeAddress === ZERO_ADDRESS) return null;

  const pairAddress = normalizeAddress(String(pool.pair_address ?? ZERO_ADDRESS));
  const token0Sym = String(pool.token0_symbol ?? "");
  const token1Sym = String(pool.token1_symbol ?? "");
  const tickSpacing = resolveCLTickSpacing(subgraphStub?.tickSpacing, pool.tickSpacing);
  const baseSymbol = String(pool.symbol || "") || `${token0Sym}/${token1Sym}`;
  const symbol =
    tickSpacing !== undefined
      ? formatCLPoolSymbol(tickSpacing, token0Sym, token1Sym)
      : baseSymbol;

  const emissionTokDec = Number(pool.emissions_token_decimals ?? 18);
  const votes = toDecimal(pool.votes, 18);
  const totalEmissions = toDecimal(pool.total_emissions, emissionTokDec);
  const votesUsd = votes * underlyingPrice;
  const emissionsUsd = totalEmissions * underlyingPrice;

  const { usd: feeUsd, tokens: feeTokens } = parseBribeTokens(pool.internal_bribes, tokenMap, "fee", true);
  const { usd: bribeUsd, tokens: bribeTokens } = parseBribeTokens(pool.external_bribes, tokenMap, "bribe", true);
  const vapr = votesUsd > 0 ? ((feeUsd + bribeUsd) * VAPR_MULTIPLIER) / votesUsd : 0;

  return {
    poolAddress: pairAddress,
    gaugeAddress,
    symbol,
    poolType: "concentrated",
    ...(tickSpacing !== undefined ? { tickSpacing } : {}),
    tvlUsd: subgraphTvl,
    votes,
    votesUsd,
    vapr,
    emissionsUsd,
    externalBribesUsd: bribeUsd,
    internalBribesUsd: feeUsd,
    totalBribesUsd: feeUsd + bribeUsd,
    rewardTokens: [...feeTokens, ...bribeTokens],
  };
}

export async function handleVoteLeaderboard(params: VoteLeaderboardParams) {
  const {
    topN = 25,
    sortBy = "votes",
    sortOrder = "desc",
    minVotes = 0,
    minVotesUsd = 0,
    poolType = "all",
  } = params;

  const [tokenMap, v2Pairs, clStubs] = await Promise.all([
    fetchTokenPricing(),
    fetchAllV2Pairs(),
    fetchCLPoolStubs(),
  ]);

  const v2AddrSet = new Set(
    v2Pairs.map((p) => normalizeAddress(String(getField<string>(p, "pair_address", 0) ?? ""))),
  );
  const algebraAddrs = [...clStubs.keys()].filter((a) => a && !v2AddrSet.has(a));

  const [algebraPools, underlyingToken] = await Promise.all([
    fetchAlgebraPoolInfos(algebraAddrs),
    publicClient.readContract({
      address: BLACKHOLE_PAIR_API_V2_ADDRESS as `0x${string}`,
      abi: BLACKHOLE_PAIR_ABI,
      functionName: "underlyingToken",
      args: [],
    }) as Promise<`0x${string}`>,
  ]);

  const underlyingPrice = tokenMap.get(normalizeAddress(underlyingToken))?.usdPrice ?? 0;
  const underlyingSymbol = tokenMap.get(normalizeAddress(underlyingToken))?.symbol ?? "BLACK";

  let entries: GaugeEntry[] = [];

  if (poolType !== "concentrated") {
    for (const pair of v2Pairs) {
      const entry = buildV2Entry(pair, tokenMap, underlyingPrice);
      if (entry) entries.push(entry);
    }
  }

  if (poolType !== "basic") {
    for (const pool of algebraPools) {
      const pairAddr = normalizeAddress(String(pool.pair_address ?? ""));
      const stub = clStubs.get(pairAddr);
      const subgraphTvl = Number(stub?.totalValueLockedUSD ?? 0);
      const entry = buildCLEntry(pool, tokenMap, underlyingPrice, subgraphTvl, stub);
      if (entry) entries.push(entry);
    }
  }

  // Only include gauges with any vote activity or emissions
  entries = entries.filter((e) => e.votes > 0 || e.emissionsUsd > 0);

  if (minVotes > 0) entries = entries.filter((e) => e.votes >= minVotes);
  if (minVotesUsd > 0) entries = entries.filter((e) => e.votesUsd >= minVotesUsd);

  entries.sort((a, b) => {
    const va = a[sortBy as keyof GaugeEntry] as number;
    const vb = b[sortBy as keyof GaugeEntry] as number;
    return sortOrder === "asc" ? va - vb : vb - va;
  });

  const top = entries.slice(0, Math.max(1, topN));

  return {
    success: true,
    message: `Vote leaderboard: top ${top.length} of ${entries.length} gauges, sorted by ${sortBy} ${sortOrder}.`,
    underlyingToken: { address: underlyingToken, symbol: underlyingSymbol, usdPrice: underlyingPrice },
    data: top.map((e) => ({
      poolAddress: e.poolAddress,
      gaugeAddress: e.gaugeAddress,
      symbol: e.symbol,
      poolType: e.poolType,
      ...(e.tickSpacing !== undefined ? { tickSpacing: e.tickSpacing } : {}),
      tvlUsd: Number(e.tvlUsd.toFixed(2)),
      votes: Number(e.votes.toFixed(4)),
      votesUsd: Number(e.votesUsd.toFixed(2)),
      vapr: Number(e.vapr.toFixed(2)),
      emissionsUsdPerEpoch: Number(e.emissionsUsd.toFixed(2)),
      externalBribesUsd: Number(e.externalBribesUsd.toFixed(2)),
      internalBribesUsd: Number(e.internalBribesUsd.toFixed(2)),
      totalBribesUsd: Number(e.totalBribesUsd.toFixed(2)),
      rewardTokens: e.rewardTokens,
    })),
    meta: {
      totalGaugesScanned: entries.length,
      sortBy,
      sortOrder,
      topN,
      minVotes,
      minVotesUsd,
      poolType,
    },
  };
}

export const voteLeaderboardTool = {
  name: "vote_leaderboard",
  description:
    "Gauge leaderboard for veBLACK voters.\n\n" +
    "INCENTIVES = EXTERNAL BRIBES: these terms are interchangeable on Blackhole. When a user says " +
    "'add incentive', 'top incentive pools', or 'which pools have incentives', they mean external bribes " +
    "via add_bribes_steps. Each row includes externalBribesUsd (USD value of external incentives this epoch).\n\n" +
    "Voter rewards and vAPR depend only on this epoch's reward inventory (rewardTokens) and vote weight on the " +
    "gauge (votes/votesUsd) -- NOT on pool TVL. tvlUsd is informational only.\n\n" +
    "vAPR = implied annualized (fee + bribe/incentive) rewards per $1 of vote power -- not LP APR.\n\n" +
    "Each row: votes = raw vote weight on this gauge; votesUsd = votes x BLACK price; vapr; emissionsUsdPerEpoch; " +
    "externalBribesUsd = USD value of external incentives this epoch; tvlUsd; rewardTokens (type=bribe means " +
    "external incentive, type=fee means internal fee share).\n\n" +
    "When to use:\n" +
    "- User asks which gauge to vote for, best voter yield, max vapr -> sortBy=vapr\n" +
    "- User asks top incentive pools, most incentivized gauges, most external bribes -> sortBy=externalBribesUsd\n" +
    "- User asks most fees to voters, internal rewards -> sortBy=internalBribesUsd\n" +
    "- User asks total rewards, combined bribes+fees -> sortBy=totalBribesUsd\n" +
    "- sortBy=votes (default): highest vote-weight gauges\n" +
    "- sortBy=emissionsUsd: rank by BLACK emissions per epoch\n" +
    "- For LP-only questions (no ve lock), use pool_yield instead\n\n" +
    "Dilution math: post-dilution vAPR ~ vAPR * (existing / (existing + extra)). " +
    "Your share per epoch ~ (extra / (existing + extra)) * R where R = sum of usdPerEpoch on rewardTokens.",
  inputSchema: {
    type: "object",
    properties: {
      topN: { type: "number", description: "Number of gauges to return (default 25)." },
      sortBy: {
        type: "string",
        enum: ["votes", "vapr", "emissionsUsd", "externalBribesUsd", "internalBribesUsd", "totalBribesUsd"],
        description:
          "Voter-centric sort. votes (default) -- rank by vote weight. vapr -- implied voter yield from rewardTokens / votes. emissionsUsd -- BLACK emissions per epoch. externalBribesUsd -- external incentive/bribe USD this epoch (use for top incentive pools). internalBribesUsd -- internal fee-share to voters this epoch. totalBribesUsd -- external + internal combined; use for most rewarding gauges overall.",
      },
      sortOrder: { type: "string", enum: ["asc", "desc"], description: "Sort direction (default desc)." },
      minVotes: {
        type: "number",
        description:
          "Optional **list filter**: minimum raw **`votes`** on the gauge (protocol vote units). **Preferred for dilution:** same units as `extra / (votes + extra)` — line up with your ve voting power in **`votes`** units. Drops tiny-vote gauges with noisy vAPR or unrealistic dominance if you add a lot of weight.",
      },
      minVotesUsd: {
        type: "number",
        description:
          "Optional **list filter**: minimum **`votesUsd`** (votes × BLACK USD price). Use for a **dollar** threshold only; for dilution vs your on-chain vote size, prefer **`minVotes`** so units match row `votes`.",
      },
      poolType: {
        type: "string",
        enum: ["all", "basic", "concentrated"],
        description: "Filter by pool type (default 'all').",
      },
    },
  },
};
