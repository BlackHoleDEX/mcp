import {
  ALGEBRA_POOL_API_ABI,
  ALGEBRA_POOL_API_ADDRESS,
  BLACKHOLE_PAIR_ABI,
  BLACKHOLE_PAIR_API_V2_ADDRESS,
} from "../constants/contracts.js";
import { SERVER_CONFIG } from "../config.js";
import { formatCLPoolName, formatCLPoolSymbol, resolveCLTickSpacing } from "../utils/clPoolLabel.js";
import { getFarmingCenterForDeployer } from "../utils/legacyContracts.js";
import { publicClient } from "../utils/viemClient.js";
import { fetchALMVaultsForPool } from "./almVaults.js";
import { PAIR_FACTORY_GET_FEE_ABI, PROTOCOL_ADDRESSES } from "./resolveAddress.js";
import { computeVolumeFromFees, isDayDataFresh } from "../utils/volumeCalc.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const GAUGE_ABI = [
  {
    inputs: [],
    name: "periodFinish",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "rewardRate",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const EPOCH_DURATION = 604800; // 1 week in seconds

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

function getCurrentEpochStart(): number {
  const nowSec = Math.floor(Date.now() / 1000);
  return Math.floor(nowSec / EPOCH_DURATION) * EPOCH_DURATION;
}

function normalizeAddress(addr: string | undefined): string {
  return (addr ?? ZERO_ADDRESS).toLowerCase();
}

function toDecimal(value: bigint | number | string | undefined, decimals: number): number {
  if (value === undefined || value === null) return 0;
  try {
    return Number(BigInt(value as any)) / 10 ** decimals;
  } catch {
    return Number(value ?? 0);
  }
}

function parseBribes(obj: any): { bribeAddress: string; tokens: { address: string; symbol: string; amount: string; decimals: number }[] } | null {
  if (!obj) return null;
  const tokens: any[] = obj.tokens ?? [];
  const symbols: string[] = obj.symbols ?? [];
  const decimalsArr: bigint[] = obj.decimals ?? [];
  const amounts: bigint[] = obj.amounts ?? [];
  return {
    bribeAddress: normalizeAddress(String(obj.bribeAddress ?? ZERO_ADDRESS)),
    tokens: tokens
      .map((addr: string, i: number) => {
        const dec = Number(decimalsArr[i] ?? 18n);
        const raw = amounts[i] ?? 0n;
        const amount = toDecimal(raw, dec);
        if (amount === 0) return null;
        return {
          address: normalizeAddress(addr),
          symbol: String(symbols[i] ?? ""),
          amount: amount.toFixed(6),
          decimals: dec,
        };
      })
      .filter(Boolean) as any[],
  };
}

interface SubgraphPool {
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
  lastRewardTimestamp: string;
  volumeUSD: string;
  feesUSD: string;
  txCount: string;
  poolDayData?: { date: string; volumeUSD: string; feesUSD: string; tvlUSD: string }[];
  token0: { id: string; symbol: string; name: string; decimals: string };
  token1: { id: string; symbol: string; name: string; decimals: string };
}

async function fetchSubgraphPool(poolAddress: string): Promise<SubgraphPool | null> {
  try {
    const res = await fetch(SERVER_CONFIG.CL_GRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
          pool(id: "${poolAddress.toLowerCase()}") {
            id fee deployer totalValueLockedUSD totalValueLockedToken0 totalValueLockedToken1
            sqrtPrice liquidity tick tickSpacing lastRewardTimestamp
            volumeUSD feesUSD txCount
            poolDayData(first: 7, orderBy: date, orderDirection: desc) {
              date volumeUSD feesUSD tvlUSD
            }
            token0 { id symbol name decimals }
            token1 { id symbol name decimals }
          }
        }`,
      }),
    });
    const json = (await res.json()) as { data?: { pool?: SubgraphPool } };
    return json?.data?.pool ?? null;
  } catch {
    return null;
  }
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

export interface GetPoolStatusParams {
  poolAddress: string;
}

export async function handleGetPoolStatus(params: GetPoolStatusParams) {
  const { poolAddress } = params;
  const normalized = normalizeAddress(poolAddress);

  const [v2Result, clResult, tokenPrices, subgraphPool] = await Promise.all([
    publicClient.readContract({
      address: BLACKHOLE_PAIR_API_V2_ADDRESS as `0x${string}`,
      abi: BLACKHOLE_PAIR_ABI,
      functionName: "getPair",
      args: [normalized as `0x${string}`, ZERO_ADDRESS as `0x${string}`],
    }).catch(() => null),
    publicClient.readContract({
      address: ALGEBRA_POOL_API_ADDRESS as `0x${string}`,
      abi: ALGEBRA_POOL_API_ABI,
      functionName: "getPoolInfo",
      args: [normalized as `0x${string}`],
    }).catch(() => null),
    fetchTokenPrices(),
    fetchSubgraphPool(normalized),
  ]);

  // Fetch ALM managed liquidity for this pool (non-blocking — empty array on failure)
  const managedLiquidity = await fetchALMVaultsForPool(normalized, tokenPrices as any).catch(() => []);

  const v2 = v2Result as any;
  const cl = clResult as any;
  const v2Valid = v2 && normalizeAddress(String(v2.pair_address ?? ZERO_ADDRESS)) !== ZERO_ADDRESS;
  const clValid = cl && normalizeAddress(String(cl.pair_address ?? ZERO_ADDRESS)) !== ZERO_ADDRESS;

  if (!v2Valid && !clValid) {
    return {
      success: false,
      message: `Pool ${poolAddress} not found in pair API or Algebra pool API.`,
      poolAddress: normalized,
    };
  }

  // getPoolInfo reverts for non-CL addresses; getPair may return partial data for CL addresses.
  // Prefer CL when valid since it's the more precise discriminator.
  const p = clValid ? cl : v2;
  const isConcentrated = clValid;

  // ── Token info ───────────────────────────────────────────────────────────
  const token0Addr = normalizeAddress(String(p.token0 ?? ZERO_ADDRESS));
  const token1Addr = normalizeAddress(String(p.token1 ?? ZERO_ADDRESS));
  const token0Dec = Number(p.token0_decimals ?? 18);
  const token1Dec = Number(p.token1_decimals ?? 18);
  const token0Symbol = String(p.token0_symbol || subgraphPool?.token0?.symbol || tokenPrices.get(token0Addr)?.symbol || "");
  const token1Symbol = String(p.token1_symbol || subgraphPool?.token1?.symbol || tokenPrices.get(token1Addr)?.symbol || "");
  const price0 = tokenPrices.get(token0Addr)?.usdPrice ?? 0;
  const price1 = tokenPrices.get(token1Addr)?.usdPrice ?? 0;

  // ── Pool identity ────────────────────────────────────────────────────────
  const sgSymbol = subgraphPool ? `${subgraphPool.token0.symbol}/${subgraphPool.token1.symbol}` : "";
  let symbol = String(p.symbol || sgSymbol || "");
  let name = String(p.name || subgraphPool?.token0.name && `${subgraphPool.token0.name}/${subgraphPool.token1.name}` || "");
  const stable = Boolean(p.stable);
  const poolType = isConcentrated ? "concentrated" : stable ? "stable" : "volatile";
  const totalSupply = toDecimal(p.total_supply, Number(p.decimals ?? 18));

  // ── Liquidity / reserves ─────────────────────────────────────────────────
  let reserve0 = 0, reserve1 = 0, tvlUsd = 0;
  let clDetails: Record<string, any> | null = null;

  if (v2Valid) {
    reserve0 = toDecimal(p.reserve0, token0Dec);
    reserve1 = toDecimal(p.reserve1, token1Dec);
    tvlUsd = reserve0 * price0 + reserve1 * price1;
  } else {
    // CL: on-chain pool state (from Algebra API) enriched with subgraph data
    const sqrtPrice = BigInt(p.sqrtPriceX96 ?? 0n);
    // Prefer subgraph tick/tickSpacing/liquidity as they're more up-to-date
    const tick = subgraphPool?.tick !== undefined ? Number(subgraphPool.tick) : Number(p.tick ?? 0);
    const tickSpacing = subgraphPool?.tickSpacing !== undefined ? Number(subgraphPool.tickSpacing) : Number(p.tickSpacing ?? 0);
    const liquidity = subgraphPool?.liquidity ?? String(p.liquidity ?? 0n);
    const feePercent = Number(p.fee ?? 0) / 10000;

    // Price from sqrtPriceX96: price = (sqrtPrice/2^96)^2 * 10^(dec0-dec1)
    let currentPrice = 0;
    try {
      const sq = Number(sqrtPrice) / 2 ** 96;
      currentPrice = sq * sq * Math.pow(10, token0Dec - token1Dec);
    } catch {}

    // TVL and volumes from subgraph
    const sgTvlUsd = Number(subgraphPool?.totalValueLockedUSD ?? 0);
    const sgTvlToken0 = Number(subgraphPool?.totalValueLockedToken0 ?? 0);
    const sgTvlToken1 = Number(subgraphPool?.totalValueLockedToken1 ?? 0);
    tvlUsd = sgTvlUsd;

    // 24h volume: only valid when latest day-data is within the last 24h (matches web client).
    const dayData = subgraphPool?.poolDayData ?? [];
    const latestDay = dayData[0];
    const fresh = latestDay ? isDayDataFresh(latestDay.date) : false;
    const volume24hUsd = fresh ? Number(Number(latestDay!.volumeUSD ?? 0).toFixed(2)) : 0;
    const fees24hUsd = fresh ? Number(Number(latestDay!.feesUSD ?? 0).toFixed(2)) : 0;
    const volume7dUsd = dayData.length > 0
      ? Number(dayData.reduce((s, d) => s + Number(d.volumeUSD ?? 0), 0).toFixed(2))
      : null;

    clDetails = {
      tick,
      tickSpacing,
      liquidity,
      feePercent,
      currentPrice: currentPrice.toFixed(8),
      sqrtPriceX96: sqrtPrice.toString(),
      tvlToken0: sgTvlToken0.toFixed(6),
      tvlToken1: sgTvlToken1.toFixed(6),
      totalVolumeUsd: Number(subgraphPool?.volumeUSD ?? 0).toFixed(2),
      totalFeesUsd: Number(subgraphPool?.feesUSD ?? 0).toFixed(2),
      volume24hUsd,
      fees24hUsd,
      volume7dUsd,
      txCount: Number(subgraphPool?.txCount ?? 0),
      lastRewardTimestamp: subgraphPool?.lastRewardTimestamp
        ? new Date(Number(subgraphPool.lastRewardTimestamp) * 1000).toISOString()
        : null,
    };
  }

  if (isConcentrated) {
    const ts = resolveCLTickSpacing(subgraphPool?.tickSpacing, p.tickSpacing);
    if (ts !== undefined) {
      symbol = formatCLPoolSymbol(ts, token0Symbol, token1Symbol);
      const t0n = String(subgraphPool?.token0?.name ?? token0Symbol);
      const t1n = String(subgraphPool?.token1?.name ?? token1Symbol);
      name = formatCLPoolName(ts, t0n, t1n);
    }
  }

  // ── Fees in gauge ────────────────────────────────────────────────────────
  const stakedFees0 = toDecimal(p.staked_token0_fees, token0Dec);
  const stakedFees1 = toDecimal(p.staked_token1_fees, token1Dec);
  const stakedFeesUsd = stakedFees0 * price0 + stakedFees1 * price1;

  // ── Emissions ────────────────────────────────────────────────────────────
  const emissionTokenAddr = normalizeAddress(String(p.emissions_token ?? ZERO_ADDRESS));
  const emissionTokenDec = Number(p.emissions_token_decimals ?? 18);
  const emissionTokenSymbol = tokenPrices.get(emissionTokenAddr)?.symbol ?? "";
  const emissionTokenPrice = tokenPrices.get(emissionTokenAddr)?.usdPrice ?? 0;

  // For CL pools use live virtualPool.rewardRates() × epochDuration (mirrors website).
  // For V2 pools use the API snapshot value.
  let epochEmissions = toDecimal(p.emissions, emissionTokenDec);
  if (isConcentrated) {
    try {
      const fc = getFarmingCenterForDeployer(subgraphPool?.deployer);
      const vpAddr = await publicClient.readContract({
        address: fc as `0x${string}`,
        abi: FARMING_CENTER_VIRTUAL_POOL_ABI,
        functionName: "virtualPoolAddresses",
        args: [normalized as `0x${string}`],
      });
      if (vpAddr && (vpAddr as string) !== ZERO_ADDRESS) {
        const [rate0] = await publicClient.readContract({
          address: vpAddr as `0x${string}`,
          abi: VIRTUAL_POOL_REWARD_RATES_ABI,
          functionName: "rewardRates",
        }) as [bigint, bigint];
        epochEmissions = (Number(rate0) * EPOCH_DURATION) / 10 ** (emissionTokenDec > 0 ? emissionTokenDec : 18);
      }
    } catch {
      // fall back to API snapshot
    }
  }

  const totalEmissions = toDecimal(p.total_emissions, emissionTokenDec);
  const epochEmissionsUsd = epochEmissions * emissionTokenPrice;

  // ── Votes & gauge (decimals) ───────────────────────────────────────────────
  // Vote weights from the API are always 18-decimal fixed point (basic + CL).
  // Gauge stake amounts follow LP `decimals` from the API.
  const pairDec = Number(p.decimals ?? 18);
  const votes = toDecimal(p.votes, 18);

  // ── Gauge from pair API (V2 only — CL does not use gauge_total_supply) ───
  const gaugeAddress = normalizeAddress(String(p.gauge ?? ZERO_ADDRESS));
  const gaugeTotalSupplyFromApi = !isConcentrated
    ? toDecimal(p.gauge_total_supply, pairDec)
    : 0;
  const hasGauge = gaugeAddress !== ZERO_ADDRESS;

  // ── Bribes ───────────────────────────────────────────────────────────────
  const internalBribes = parseBribes(p.internal_bribes);
  const externalBribes = parseBribes(p.external_bribes);

  // ── V2-only fields ───────────────────────────────────────────────────────
  let v2Extra: Record<string, any> | null = null;
  if (v2Valid) {
    // Fetch actual fee from pair factory — getFee(pair, stable) returns raw units (e.g. 4 = 0.04%).
    const feeRaw = await publicClient.readContract({
      address: PROTOCOL_ADDRESSES.pair_factory,
      abi: PAIR_FACTORY_GET_FEE_ABI,
      functionName: "getFee",
      args: [normalized as `0x${string}`, stable],
    }).catch(() => null);
    const v2FeePercent = feeRaw != null ? Number(feeRaw as bigint) / 100 : (stable ? 0.04 : 0.18);
    const v2VolumeUsd = v2FeePercent > 0 ? Number(computeVolumeFromFees(stakedFeesUsd, v2FeePercent).toFixed(2)) : null;
    v2Extra = {
      reserve0: reserve0.toFixed(6),
      reserve1: reserve1.toFixed(6),
      claimable0: toDecimal(p.claimable0, token0Dec).toFixed(6),
      claimable1: toDecimal(p.claimable1, token1Dec).toFixed(6),
      isGenesisRunning: Boolean(p.isGenesisRunning),
      volumeUsd: v2VolumeUsd,
    };
  }

  // ── On-chain gauge data ──────────────────────────────────────────────────
  const now = Math.floor(Date.now() / 1000);
  let isGaugeActive = false;
  let gaugeExpiresAt: string | null = null;
  let rewardRatePerSecond: string | null = null;
  let gaugeStakedSupply: string | null = null;

  if (hasGauge) {
    if (isConcentrated) {
      // CL gauge: use lastRewardTimestamp from subgraph — active if within current epoch
      const lastRewardTs = Number(subgraphPool?.lastRewardTimestamp ?? 0);
      isGaugeActive = lastRewardTs > getCurrentEpochStart();
    } else {
      // V2 gauge: on-chain periodFinish
      const [periodFinishRes, rewardRateRes, totalSupplyRes] = await publicClient.multicall({
        contracts: [
          { address: gaugeAddress as `0x${string}`, abi: GAUGE_ABI, functionName: "periodFinish" },
          { address: gaugeAddress as `0x${string}`, abi: GAUGE_ABI, functionName: "rewardRate" },
          { address: gaugeAddress as `0x${string}`, abi: GAUGE_ABI, functionName: "totalSupply" },
        ],
        allowFailure: true,
      });
      if (periodFinishRes.status === "success") {
        const periodFinish = Number(periodFinishRes.result as bigint);
        isGaugeActive = periodFinish > now;
        gaugeExpiresAt = new Date(periodFinish * 1000).toISOString();
      }
      if (rewardRateRes.status === "success") {
        rewardRatePerSecond = toDecimal(rewardRateRes.result as bigint, emissionTokenDec).toFixed(8);
      }
      if (totalSupplyRes.status === "success") {
        gaugeStakedSupply = toDecimal(totalSupplyRes.result as bigint, pairDec).toFixed(6);
      }
    }
  }

  // ── Staked vs unstaked liquidity breakdown ────────────────────────────────
  // V2: stakedTvl = tvl * (gaugeTotalSupply / totalSupply). CL: treat full TVL as
  // staked (no gauge_total_supply ratio).
  const stakedRatio = isConcentrated
    ? 1
    : hasGauge && totalSupply > 0
      ? Math.min(1, Math.max(0, gaugeTotalSupplyFromApi / totalSupply))
      : 0;
  const stakedTvlUsdVal = Number((tvlUsd * stakedRatio).toFixed(2));
  const unstakedTvlUsdVal = Number((tvlUsd - stakedTvlUsdVal).toFixed(2));

  return {
    success: true,
    poolAddress: normalized,
    symbol,
    name,
    poolType,
    totalSupply: totalSupply.toFixed(6),
    token0: { address: token0Addr, symbol: token0Symbol, decimals: token0Dec, usdPrice: price0 },
    token1: { address: token1Addr, symbol: token1Symbol, decimals: token1Dec, usdPrice: price1 },
    ...(v2Extra ?? {}),
    ...(clDetails ? { cl: clDetails } : {}),
    tvlUsd: Number(tvlUsd.toFixed(2)),
    votes: Number(votes.toFixed(4)),
    stakedFees: {
      token0Amount: stakedFees0.toFixed(6),
      token1Amount: stakedFees1.toFixed(6),
      usd: Number(stakedFeesUsd.toFixed(2)),
    },
    emissions: {
      token: emissionTokenSymbol,
      tokenAddress: emissionTokenAddr,
      epochAmount: epochEmissions.toFixed(6),
      epochUsd: Number(epochEmissionsUsd.toFixed(2)),
      totalAmount: totalEmissions.toFixed(6),
    },
    internalBribes,
    externalBribes,
    gauge: {
      address: hasGauge ? gaugeAddress : null,
      hasGauge,
      isActive: isGaugeActive,
      expiresAt: gaugeExpiresAt,
      stakedSupply: isConcentrated
        ? gaugeStakedSupply
        : gaugeStakedSupply ?? gaugeTotalSupplyFromApi.toFixed(6),
      rewardRatePerSecond,
    },
    liquidityBreakdown: {
      totalTvlUsd: Number(tvlUsd.toFixed(2)),
      stakedTvlUsd: stakedTvlUsdVal,
      unstakedTvlUsd: unstakedTvlUsdVal,
      stakedPercent: Number((stakedRatio * 100).toFixed(2)),
      unstakedPercent: Number(((1 - stakedRatio) * 100).toFixed(2)),
    },
    managedLiquidity,
    managedLiquidityTvlUsd: managedLiquidity.reduce((s: number, v: any) => s + (v.tvlUsd ?? 0), 0),
    message: hasGauge
      ? `${symbol} (${poolType}) — gauge is ${isGaugeActive ? "ACTIVE" : "INACTIVE"} (expires ${gaugeExpiresAt}).`
      : `${symbol} (${poolType}) — no gauge.`,
  };
}

export const getPoolStatusTool = {
  name: "get_pool_status",
  description:
    "Returns full status of a specific pool: gauge activity (periodFinish, rewardRate, stakedSupply), token details, reserves/liquidity, TVL, **votes** (vote weight already on this gauge’s snapshot), epoch emissions, staked fees, bribe inventories (internal fee-shares + external incentives), ALM-managed liquidity (Steer/Gamma vaults on this pool), and `liquidityBreakdown` (totalTvlUsd, stakedTvlUsd, unstakedTvlUsd, stakedPercent, unstakedPercent). For CL pools, `cl.volume24hUsd`, `cl.volume7dUsd`, and cumulative `cl.totalVolumeUsd` are also provided; `liquidityBreakdown` assumes 100% staked TVL (API gauge_total_supply is not used), and `gauge.stakedSupply` is on-chain only when present. **LP / emissions context:** `emissions` to the gauge are shared across **staked** liquidity; `liquidityBreakdown` shows how much is already there. If you **add LP** equal to a **large share** of current **staked** TVL, headline **apr** from `pool_yield` **drops** after dilution — size adds with that in mind. **Voter yield context:** any **vAPR** you infer elsewhere (e.g. from `pool_yield`) divides rewards by **existing** vote weight on the gauge; if you plan to add vote power that is a **large share** of `votes` here, headline vAPR **drops** after dilution — size allocations with that in mind. Use before staking, voting, or adding liquidity to a specific pool.",
  inputSchema: {
    type: "object",
    properties: {
      poolAddress: {
        type: "string",
        description: "Address of the pool (pair address) to check.",
      },
    },
    required: ["poolAddress"],
  },
};
