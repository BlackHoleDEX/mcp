import { SERVER_CONFIG } from "../config.js";
import {
  BLACKHOLE_PAIR_ABI,
  BLACKHOLE_PAIR_API_V2_ADDRESS,
  ALGEBRA_POOL_API_ABI,
  NONFUNGIBLE_POSITION_MANAGER_ABI,
  NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
  LEGACY_NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
} from "../constants/contracts.js";
import { isLegacyDeployer, getPoolAPIForDeployer } from "../utils/legacyContracts.js";
import { publicClient } from "../utils/viemClient.js";
import { computeAmountsFromLiquidity } from "../utils/clMath.js";
import { formatCLPoolSymbol, resolveCLTickSpacing } from "../utils/clPoolLabel.js";
import { formatUnits } from "viem";
import { fetchUserALMPositions } from "./almVaults.js";
import { getEnvUserAddress } from "../utils/wallet.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const EPOCHS_PER_YEAR = 52;

const VE_NFT_API_ADDRESS = "0xb3629c89ed9cB172A3FBa66dfdF8C06A85B35dE9";

const VE_NFT_API_ABI = [
  {
    inputs: [{ internalType: "address", name: "_user", type: "address" }],
    name: "getNFTFromAddress",
    outputs: [
      {
        components: [
          { name: "decimals", type: "uint8" },
          { name: "voted", type: "bool" },
          { name: "hasVotedForEpoch", type: "bool" },
          { name: "attachments", type: "uint256" },
          { name: "id", type: "uint256" },
          { name: "amount", type: "uint128" },
          { name: "voting_amount", type: "uint256" },
          { name: "rebase_amount", type: "uint256" },
          { name: "lockEnd", type: "uint256" },
          { name: "vote_ts", type: "uint256" },
          {
            components: [
              { name: "pair", type: "address" },
              { name: "weight", type: "uint256" },
            ],
            name: "votes",
            type: "tuple[]",
          },
          { name: "account", type: "address" },
          { name: "isSMNFT", type: "bool" },
          { name: "isPermanent", type: "bool" },
          { name: "token", type: "address" },
          { name: "tokenSymbol", type: "string" },
          { name: "tokenDecimals", type: "uint256" },
        ],
        internalType: "struct veNFTAPI.veNFT[]",
        name: "venft",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const ERC20_ABI = [
  {
    inputs: [{ name: "account", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "symbol",
    outputs: [{ name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ─── Token pricing helper ────────────────────────────────────────────────────

async function fetchTokenPrices(): Promise<Map<string, { symbol: string; decimals: number; usdPrice: number }>> {
  const map = new Map();
  try {
    const res = await fetch("https://resources.blackhole.xyz/token-details.json");
    const data = (await res.json()) as Record<string, any>;
    for (const [key, token] of Object.entries(data ?? {})) {
      const address = ((token as any)?.address ?? key).toLowerCase();
      map.set(address, {
        symbol: (token as any)?.ticker ?? "",
        decimals: Number((token as any)?.decimal ?? 18),
        usdPrice: Number((token as any)?.usd_pricing ?? 0),
      });
    }
  } catch {}
  return map;
}

// ─── get_token_balances ──────────────────────────────────────────────────────

export interface GetTokenBalancesParams {
  userAddress?: string;
}

export async function handleGetTokenBalances(params: GetTokenBalancesParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");

  // Get AVAX balance
  const avaxBalance = await publicClient.getBalance({
    address: userAddress as `0x${string}`,
  });

  // Get whitelisted tokens with prices
  const tokenPrices = await fetchTokenPrices();

  // Fetch balances for all known tokens via multicall
  const tokenAddresses = [...tokenPrices.keys()].filter(
    (a) => a !== ZERO_ADDRESS && a.startsWith("0x") && a.length === 42
  );

  const balanceCalls = tokenAddresses.map((addr) => ({
    address: addr as `0x${string}`,
    abi: ERC20_ABI,
    functionName: "balanceOf" as const,
    args: [userAddress as `0x${string}`],
  }));

  const results = await publicClient.multicall({
    contracts: balanceCalls,
    allowFailure: true,
  });

  const balances: any[] = [];
  let totalUsd = 0;

  // AVAX — use formatUnits directly for an EXACT decimal string; never toFixed the balance
  const avaxBalanceStr = formatUnits(avaxBalance, 18);
  const avaxPrice = tokenPrices.get("0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7")?.usdPrice ?? 0;
  const avaxUsd = Number(avaxBalanceStr) * avaxPrice;
  totalUsd += avaxUsd;
  balances.push({
    token: "AVAX",
    address: "native",
    decimals: 18,
    balance: avaxBalanceStr,
    balanceRaw: avaxBalance.toString(),
    usdValue: avaxUsd.toFixed(2),
  });

  for (let i = 0; i < tokenAddresses.length; i++) {
    const r = results[i];
    if (!r || r.status !== "success") continue;
    const rawBal = r.result as bigint;
    if (rawBal === 0n) continue;

    const info = tokenPrices.get(tokenAddresses[i]);
    if (!info) continue;

    const balanceStr = formatUnits(rawBal, info.decimals);
    const usd = Number(balanceStr) * info.usdPrice;
    totalUsd += usd;

    balances.push({
      token: info.symbol,
      address: tokenAddresses[i],
      decimals: info.decimals,
      balance: balanceStr,
      balanceRaw: rawBal.toString(),
      usdValue: usd.toFixed(2),
    });
  }

  // Sort by USD value descending
  balances.sort((a, b) => parseFloat(b.usdValue) - parseFloat(a.usdValue));

  return {
    success: true,
    message: `Found ${balances.length} tokens with non-zero balance.`,
    totalUsdValue: totalUsd.toFixed(2),
    balances,
  };
}

// ─── New NFPM on-chain enumeration ──────────────────────────────────────────

const POOL_STATE_ABI = [
  {
    inputs: [],
    name: "globalState",
    outputs: [
      { internalType: "uint160", name: "price", type: "uint160" },
      { internalType: "int24",   name: "tick",  type: "int24" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "fee",
    outputs: [{ internalType: "uint16", name: "currentFee", type: "uint16" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "tickSpacing",
    outputs: [{ internalType: "int24", name: "", type: "int24" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "liquidity",
    outputs: [{ internalType: "uint128", name: "", type: "uint128" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const FACTORY_POOL_LOOKUP_ABI = [
  {
    inputs: [
      { internalType: "address", name: "", type: "address" },
      { internalType: "address", name: "", type: "address" },
      { internalType: "address", name: "", type: "address" },
    ],
    name: "customPoolByPair",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const ALGEBRA_FACTORY_ADDRESS = "0x512eb749541B7cf294be882D636218c84a5e9E5F";
const ZERO_ADDR = "0x0000000000000000000000000000000000000000";

async function fetchNewNFPMPositions(owner: string): Promise<any[]> {
  try {
    const nfpm = NONFUNGIBLE_POSITION_MANAGER_ADDRESS as `0x${string}`;
    const balance = await publicClient.readContract({
      address: nfpm,
      abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
      functionName: "balanceOf",
      args: [owner as `0x${string}`],
    }) as bigint;

    if (!balance || balance === 0n) return [];

    // Enumerate all tokenIds
    const indices = Array.from({ length: Number(balance) }, (_, i) => BigInt(i));
    const tokenIds = await Promise.all(
      indices.map(i =>
        publicClient.readContract({
          address: nfpm,
          abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
          functionName: "tokenOfOwnerByIndex",
          args: [owner as `0x${string}`, i],
        }) as Promise<bigint>,
      ),
    );

    // Fetch position structs
    const posStructs = await Promise.all(
      tokenIds.map(tokenId =>
        publicClient.readContract({
          address: nfpm,
          abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
          functionName: "positions",
          args: [tokenId],
        }) as Promise<any>,
      ),
    );

    // viem returns positions() as an array-like tuple — access by name with index fallback
    const active = posStructs
      .map((p: any, i) => ({
        token0:    p.token0    ?? p[2],
        token1:    p.token1    ?? p[3],
        deployer:  p.deployer  ?? p[4],
        tickLower: p.tickLower ?? p[5],
        tickUpper: p.tickUpper ?? p[6],
        liquidity: p.liquidity ?? p[7],
        tokenId: tokenIds[i],
      }))
      .filter(p => p.liquidity && BigInt(p.liquidity) > 0n);

    if (active.length === 0) return [];

    // Resolve pool addresses from factory
    const poolAddresses = await Promise.all(
      active.map(p =>
        publicClient.readContract({
          address: ALGEBRA_FACTORY_ADDRESS as `0x${string}`,
          abi: FACTORY_POOL_LOOKUP_ABI,
          functionName: "customPoolByPair",
          args: [p.deployer, p.token0, p.token1],
        }) as Promise<string>,
      ),
    );

    // Fetch pool state for each unique pool
    const uniquePools = [...new Set(poolAddresses.filter(a => a && a !== ZERO_ADDR))];
    const poolStateMap = new Map<string, { tick: number; sqrtPrice: bigint; fee: number; tickSpacing: number; liquidity: bigint }>();
    await Promise.all(
      uniquePools.map(async poolAddr => {
        try {
          const [gs, fee, ts, liq] = await Promise.all([
            publicClient.readContract({ address: poolAddr as `0x${string}`, abi: POOL_STATE_ABI, functionName: "globalState" }) as Promise<[bigint, number]>,
            publicClient.readContract({ address: poolAddr as `0x${string}`, abi: POOL_STATE_ABI, functionName: "fee" }) as Promise<number>,
            publicClient.readContract({ address: poolAddr as `0x${string}`, abi: POOL_STATE_ABI, functionName: "tickSpacing" }) as Promise<number>,
            publicClient.readContract({ address: poolAddr as `0x${string}`, abi: POOL_STATE_ABI, functionName: "liquidity" }) as Promise<bigint>,
          ]);
          poolStateMap.set(poolAddr.toLowerCase(), {
            tick: Number(gs[1]),
            sqrtPrice: BigInt(gs[0]),
            fee: Number(fee),
            tickSpacing: Number(ts),
            liquidity: BigInt(liq),
          });
        } catch {}
      }),
    );

    // Fetch token symbols/decimals for unique tokens
    const TOKEN_SYMBOL_ABI = [
      { inputs: [], name: "symbol", outputs: [{ internalType: "string", name: "", type: "string" }], stateMutability: "view", type: "function" },
      { inputs: [], name: "decimals", outputs: [{ internalType: "uint8", name: "", type: "uint8" }], stateMutability: "view", type: "function" },
    ] as const;
    const uniqueTokens = [...new Set(active.flatMap(p => [p.token0 as string, p.token1 as string]))];
    const tokenInfoMap = new Map<string, { symbol: string; decimals: number }>();
    await Promise.all(
      uniqueTokens.map(async tokenAddr => {
        try {
          const [symbol, decimals] = await Promise.all([
            publicClient.readContract({ address: tokenAddr as `0x${string}`, abi: TOKEN_SYMBOL_ABI, functionName: "symbol" }) as Promise<string>,
            publicClient.readContract({ address: tokenAddr as `0x${string}`, abi: TOKEN_SYMBOL_ABI, functionName: "decimals" }) as Promise<number>,
          ]);
          tokenInfoMap.set(tokenAddr.toLowerCase(), { symbol, decimals: Number(decimals) });
        } catch {}
      }),
    );

    // Build rows in the same shape as subgraph rows
    return active.map((p, i) => {
      const poolAddr = (poolAddresses[i] ?? "").toLowerCase();
      const poolState = poolStateMap.get(poolAddr);
      const t0 = tokenInfoMap.get((p.token0 as string).toLowerCase()) ?? { symbol: "?", decimals: 18 };
      const t1 = tokenInfoMap.get((p.token1 as string).toLowerCase()) ?? { symbol: "?", decimals: 18 };
      return {
        id: p.tokenId.toString(),
        liquidity: p.liquidity.toString(),
        tickLower: { tickIdx: p.tickLower.toString() },
        tickUpper: { tickIdx: p.tickUpper.toString() },
        depositedToken0: "0",
        depositedToken1: "0",
        collectedFeesToken0: "0",
        collectedFeesToken1: "0",
        pool: {
          id: poolAddr,
          tick: poolState?.tick?.toString() ?? "0",
          tickSpacing: poolState?.tickSpacing?.toString() ?? "0",
          sqrtPrice: poolState?.sqrtPrice?.toString() ?? "0",
          fee: poolState?.fee?.toString() ?? "0",
          liquidity: poolState?.liquidity?.toString() ?? "0",
          deployer: (p.deployer as string).toLowerCase(),
          token0: { id: (p.token0 as string).toLowerCase(), symbol: t0.symbol, decimals: t0.decimals.toString() },
          token1: { id: (p.token1 as string).toLowerCase(), symbol: t1.symbol, decimals: t1.decimals.toString() },
        },
      };
    });
  } catch {
    return [];
  }
}

// ─── get_user_positions ──────────────────────────────────────────────────────

export interface GetUserPositionsParams {
  userAddress?: string;
}

async function fetchCLPositions(owner: string, tokenPrices: Map<string, { symbol: string; decimals: number; usdPrice: number }>) {
  const ownerLower = owner.toLowerCase();

  // Step 1a: fetch legacy NFPM positions from subgraph
  let subgraphRows: any[] = [];
  try {
    const res = await fetch(SERVER_CONFIG.CL_GRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
          positions(first: 100, where: { owner: "${ownerLower}", liquidity_gt: "0" }) {
            id liquidity
            tickLower { tickIdx }
            tickUpper { tickIdx }
            depositedToken0 depositedToken1
            collectedFeesToken0 collectedFeesToken1
            pool {
              id tick tickSpacing sqrtPrice fee liquidity deployer
              token0 { id symbol decimals }
              token1 { id symbol decimals }
            }
          }
        }`,
      }),
    });
    const json = (await res.json()) as { data?: { positions?: any[] } };
    subgraphRows = json?.data?.positions ?? [];
  } catch {}

  // Step 1b: fetch new NFPM positions on-chain (not indexed by the subgraph)
  const newNfpmRows: any[] = await fetchNewNFPMPositions(owner);

  // Merge — new NFPM rows won't overlap with subgraph (different NFPM contract)
  const allRows: any[] = [...subgraphRows, ...newNfpmRows];

  if (allRows.length === 0) return [];

  // Step 2: call getAllPositionsInfo — use legacy pool API for legacy deployer positions
  const emissionsMap = new Map<number, { earned: bigint; decimals: number; tokenAddr: string }>();
  const legacyRows = allRows.filter((p: any) => isLegacyDeployer(p.pool?.deployer));
  const currentRows = allRows.filter((p: any) => !isLegacyDeployer(p.pool?.deployer));

  async function fetchEmissions(rows: any[], apiAddress: string) {
    if (rows.length === 0) return;
    try {
      const infos = (await publicClient.readContract({
        address: apiAddress as `0x${string}`,
        abi: ALGEBRA_POOL_API_ABI,
        functionName: "getAllPositionsInfo",
        args: [rows.map((p: any) => BigInt(p.id)), owner as `0x${string}`],
      })) as any[];
      for (const info of infos ?? []) {
        emissionsMap.set(Number(info.tokenId), {
          earned: BigInt(info.account_gauge_earned ?? 0n),
          decimals: Number(info.emissions_token_decimals ?? 18),
          tokenAddr: String(info.emissions_token ?? "").toLowerCase(),
        });
      }
    } catch {}
  }

  await Promise.all([
    fetchEmissions(legacyRows, getPoolAPIForDeployer(legacyRows[0]?.pool?.deployer)),
    fetchEmissions(currentRows, getPoolAPIForDeployer(currentRows[0]?.pool?.deployer)),
  ]);

  // Step 3: fetch pool-level emissions for APR calculation (split by legacy vs current)
  const poolEmissionsMap = new Map<string, { totalEmissions: bigint; emissionDecimals: number; emissionTokenAddr: string }>();

  async function fetchPoolEmissions(rows: any[], apiAddress: string) {
    const addrs = [...new Set(rows.map((p: any) => p.pool?.id).filter(Boolean))];
    if (addrs.length === 0) return;
    try {
      const poolInfos = (await publicClient.readContract({
        address: apiAddress as `0x${string}`,
        abi: ALGEBRA_POOL_API_ABI,
        functionName: "getAllPoolInfo",
        args: [addrs.map((a) => a as `0x${string}`)],
      })) as any;
      const infosArray: any[] = Array.isArray(poolInfos) ? poolInfos : (poolInfos?.[0] ?? []);
      for (const pi of infosArray) {
        const addr = String(pi.pair_address ?? "").toLowerCase();
        if (addr) {
          poolEmissionsMap.set(addr, {
            totalEmissions: BigInt(pi.total_emissions ?? 0n),
            emissionDecimals: Number(pi.emissions_token_decimals ?? 18),
            emissionTokenAddr: String(pi.emissions_token ?? "").toLowerCase(),
          });
        }
      }
    } catch {}
  }

  await Promise.all([
    fetchPoolEmissions(legacyRows, getPoolAPIForDeployer(legacyRows[0]?.pool?.deployer)),
    fetchPoolEmissions(currentRows, getPoolAPIForDeployer(currentRows[0]?.pool?.deployer)),
  ]);

  // Step 4: build position objects
  const positions: any[] = [];
  for (const pos of allRows) {
    const pool = pos.pool;
    if (!pool) continue;

    const token0Addr = (pool.token0?.id ?? "").toLowerCase();
    const token1Addr = (pool.token1?.id ?? "").toLowerCase();
    const token0Decimals = Number(pool.token0?.decimals ?? 18);
    const token1Decimals = Number(pool.token1?.decimals ?? 18);
    const price0 = tokenPrices.get(token0Addr)?.usdPrice ?? 0;
    const price1 = tokenPrices.get(token1Addr)?.usdPrice ?? 0;

    const tickLower = Number(pos.tickLower?.tickIdx ?? 0);
    const tickUpper = Number(pos.tickUpper?.tickIdx ?? 0);
    const tickCurrent = Number(pool.tick ?? 0);
    const inRange = tickCurrent >= tickLower && tickCurrent < tickUpper;

    let amount0Human = 0;
    let amount1Human = 0;
    try {
      const { amount0Raw, amount1Raw } = computeAmountsFromLiquidity({
        liquidityRaw: BigInt(pos.liquidity),
        tickLower,
        tickUpper,
        tickCurrent,
        sqrtPriceX96: BigInt(pool.sqrtPrice ?? "0"),
      });
      amount0Human = Number(amount0Raw) / 10 ** token0Decimals;
      amount1Human = Number(amount1Raw) / 10 ** token1Decimals;
    } catch {}

    const positionUsd = amount0Human * price0 + amount1Human * price1;
    const feePercent = Number(pool.fee ?? 0) / 10000;
    const t0s = pool.token0?.symbol ?? "?";
    const t1s = pool.token1?.symbol ?? "?";
    const tickSpacing = resolveCLTickSpacing(pool.tickSpacing, undefined);
    const poolLabel = tickSpacing !== undefined ? formatCLPoolSymbol(tickSpacing, t0s, t1s) : `${t0s}/${t1s}`;

    // Pending emissions
    const tokenId = Number(pos.id);
    const emInfo = emissionsMap.get(tokenId);
    const earnedHuman = emInfo ? Number(formatUnits(emInfo.earned, emInfo.decimals)) : 0;
    const emissionsPrice = emInfo ? (tokenPrices.get(emInfo.tokenAddr)?.usdPrice ?? 0) : 0;
    const pendingEmissionsUsd = earnedHuman * emissionsPrice;

    // Position-specific APR
    let aprPercent = 0;
    const poolInfo = poolEmissionsMap.get((pool.id ?? "").toLowerCase());
    if (poolInfo && positionUsd > 0) {
      const poolLiquidity = Number(pool.liquidity ?? "0");
      const posLiquidity = Number(pos.liquidity ?? "0");
      const emTokenPrice = tokenPrices.get(poolInfo.emissionTokenAddr)?.usdPrice ?? 0;
      const poolEmissionsHuman = Number(formatUnits(poolInfo.totalEmissions, poolInfo.emissionDecimals));
      const poolEmissionsUsd = poolEmissionsHuman * emTokenPrice;
      if (poolLiquidity > 0 && poolEmissionsUsd > 0) {
        aprPercent = (poolEmissionsUsd * EPOCHS_PER_YEAR * 100 * posLiquidity / poolLiquidity) / positionUsd;
      }
    }

    positions.push({
      pool: poolLabel,
      poolAddress: pool.id,
      deployer: pool.deployer ?? null,
      poolType: "concentrated",
      concentrated: true,
      ...(tickSpacing !== undefined ? { tickSpacing } : {}),
      tokenId,
      token0: { symbol: t0s, address: token0Addr, amount: amount0Human.toFixed(6) },
      token1: { symbol: t1s, address: token1Addr, amount: amount1Human.toFixed(6) },
      tickLower,
      tickUpper,
      tickCurrent,
      priceLower: (Math.pow(1.0001, tickLower) * Math.pow(10, token0Decimals - token1Decimals)).toFixed(8),
      priceUpper: (Math.pow(1.0001, tickUpper) * Math.pow(10, token0Decimals - token1Decimals)).toFixed(8),
      priceCurrent: (Math.pow(1.0001, tickCurrent) * Math.pow(10, token0Decimals - token1Decimals)).toFixed(8),
      inRange,
      feePercent,
      liquidity: pos.liquidity,
      positionUsd: positionUsd.toFixed(2),
      depositedToken0: pos.depositedToken0,
      depositedToken1: pos.depositedToken1,
      collectedFeesToken0: pos.collectedFeesToken0,
      collectedFeesToken1: pos.collectedFeesToken1,
      pendingEmissions: earnedHuman.toFixed(6),
      pendingEmissionsUsd: pendingEmissionsUsd.toFixed(2),
      apr: aprPercent.toFixed(2),
    });
  }

  return positions;
}

export async function handleGetUserPositions(params: GetUserPositionsParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const tokenPrices = await fetchTokenPrices();

  // Fetch V2, CL, and ALM positions in parallel
  const [v2Data, clPositions, almPositions] = await Promise.all([
    publicClient.readContract({
      address: BLACKHOLE_PAIR_API_V2_ADDRESS as `0x${string}`,
      abi: BLACKHOLE_PAIR_ABI,
      functionName: "getAllPair",
      args: [userAddress as `0x${string}`, 100n, 0n],
    }) as Promise<any>,
    fetchCLPositions(userAddress, tokenPrices),
    fetchUserALMPositions(userAddress, tokenPrices).catch(() => [] as any[]),
  ]);

  const pairs = (v2Data?.pairs ?? v2Data?.[2] ?? []) as any[];
  const positions: any[] = [];

  for (const p of pairs) {
    const lpBalance = BigInt(p.account_lp_balance ?? 0n);
    const gaugeBalance = BigInt(p.account_gauge_balance ?? 0n);

    if (lpBalance === 0n && gaugeBalance === 0n) continue;

    const token0Decimals = Number(p.token0_decimals ?? 18);
    const token1Decimals = Number(p.token1_decimals ?? 18);
    const pairDecimals = Number(p.decimals ?? 18);

    const token0Addr = String(p.token0 ?? "").toLowerCase();
    const token1Addr = String(p.token1 ?? "").toLowerCase();
    const price0 = tokenPrices.get(token0Addr)?.usdPrice ?? 0;
    const price1 = tokenPrices.get(token1Addr)?.usdPrice ?? 0;

    const reserve0 = Number(formatUnits(BigInt(p.reserve0 ?? 0n), token0Decimals));
    const reserve1 = Number(formatUnits(BigInt(p.reserve1 ?? 0n), token1Decimals));
    const totalSupply = Number(formatUnits(BigInt(p.total_supply ?? 1n), pairDecimals));

    const userLpExact = formatUnits(lpBalance, pairDecimals);
    const userStakedExact = formatUnits(gaugeBalance, pairDecimals);
    const userLp = Number(userLpExact);
    const userStaked = Number(userStakedExact);
    const userTotal = userLp + userStaked;
    const share = totalSupply > 0 ? userTotal / totalSupply : 0;

    const userToken0 = reserve0 * share;
    const userToken1 = reserve1 * share;
    const positionUsd = userToken0 * price0 + userToken1 * price1;

    const claimable0 = Number(formatUnits(BigInt(p.claimable0 ?? 0n), token0Decimals));
    const claimable1 = Number(formatUnits(BigInt(p.claimable1 ?? 0n), token1Decimals));
    const claimableUsd = claimable0 * price0 + claimable1 * price1;

    const gaugeEarned = Number(formatUnits(BigInt(p.account_gauge_earned ?? 0n), 18));
    const emissionsTokenAddr = String(p.emissions_token ?? "").toLowerCase();
    const emissionsTokenPrice = tokenPrices.get(emissionsTokenAddr)?.usdPrice ?? 0;
    const pendingEmissionsUsd = gaugeEarned * emissionsTokenPrice;

    positions.push({
      pool: String(p.symbol ?? ""),
      poolAddress: String(p.pair_address ?? ""),
      poolType: p.stable ? "stable" : "volatile",
      concentrated: false,
      token0: { symbol: String(p.token0_symbol ?? ""), address: token0Addr, amount: userToken0.toFixed(6) },
      token1: { symbol: String(p.token1_symbol ?? ""), address: token1Addr, amount: userToken1.toFixed(6) },
      lpBalance: userLpExact,
      lpBalanceRaw: lpBalance.toString(),
      stakedBalance: userStakedExact,
      stakedBalanceRaw: gaugeBalance.toString(),
      positionUsd: positionUsd.toFixed(2),
      claimableFees: {
        token0: claimable0.toFixed(6),
        token1: claimable1.toFixed(6),
        usd: claimableUsd.toFixed(2),
      },
      pendingEmissions: gaugeEarned.toFixed(6),
      pendingEmissionsUsd: pendingEmissionsUsd.toFixed(2),
      gaugeAddress: String(p.gauge ?? ZERO_ADDRESS),
    });
  }

  // Add CL and ALM positions
  positions.push(...clPositions);
  positions.push(...almPositions);

  positions.sort((a, b) => parseFloat(b.positionUsd) - parseFloat(a.positionUsd));

  const v2Count = positions.filter((p: any) => !p.concentrated).length;
  const clCount = clPositions.length;
  const almCount = almPositions.length;

  return {
    success: true,
    message: `Found ${positions.length} active positions (${v2Count} V2, ${clCount} CL, ${almCount} ALM).`,
    positions,
  };
}

// ─── get_user_locks ──────────────────────────────────────────────────────────

export interface GetUserLocksParams {
  userAddress?: string;
}

export async function handleGetUserLocks(params: GetUserLocksParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");

  const nfts = (await publicClient.readContract({
    address: VE_NFT_API_ADDRESS as `0x${string}`,
    abi: VE_NFT_API_ABI,
    functionName: "getNFTFromAddress",
    args: [userAddress as `0x${string}`],
  })) as any[];

  const locks: any[] = [];

  for (const nft of nfts) {
    const decimals = Number(nft.decimals ?? 18);
    const lockedAmount = Number(formatUnits(BigInt(nft.amount ?? 0n), decimals));
    const votingPower = Number(formatUnits(BigInt(nft.voting_amount ?? 0n), decimals));
    const rebaseAmount = Number(formatUnits(BigInt(nft.rebase_amount ?? 0n), decimals));
    const lockEnd = Number(nft.lockEnd ?? 0);
    const now = Math.floor(Date.now() / 1000);

    const votes = (nft.votes ?? []).map((v: any) => ({
      pair: String(v.pair ?? ""),
      weight: Number(formatUnits(BigInt(v.weight ?? 0n), decimals)).toFixed(4),
    })).filter((v: any) => v.pair !== ZERO_ADDRESS && parseFloat(v.weight) > 0);

    locks.push({
      tokenId: Number(nft.id ?? 0),
      lockedAmount: lockedAmount.toFixed(4),
      votingPower: votingPower.toFixed(4),
      rebaseClaimable: rebaseAmount.toFixed(4),
      lockEnd: lockEnd > 0 ? new Date(lockEnd * 1000).toISOString().split("T")[0] : "permanent",
      daysUntilUnlock: lockEnd > now ? Math.ceil((lockEnd - now) / 86400) : 0,
      isPermanent: Boolean(nft.isPermanent),
      isSuperMassive: Boolean(nft.isSMNFT),
      voted: Boolean(nft.voted),
      hasVotedThisEpoch: Boolean(nft.hasVotedForEpoch),
      token: String(nft.tokenSymbol ?? "BLACK"),
      votes,
    });
  }

  return {
    success: true,
    message: `Found ${locks.length} veNFT lock(s).`,
    locks,
  };
}

// ─── get_whitelisted_tokens ──────────────────────────────────────────────────

export async function handleGetWhitelistedTokens() {
  const tokenPrices = await fetchTokenPrices();

  const tokens = [...tokenPrices.entries()]
    .filter(([addr]) => addr.startsWith("0x") && addr.length === 42)
    .map(([address, info]) => ({
      address,
      symbol: info.symbol,
      decimals: info.decimals,
      usdPrice: info.usdPrice.toFixed(6),
    }))
    .filter((t) => t.symbol && t.usdPrice !== "0.000000")
    .sort((a, b) => parseFloat(b.usdPrice) - parseFloat(a.usdPrice));

  return {
    success: true,
    message: `Found ${tokens.length} whitelisted tokens with prices.`,
    tokens,
  };
}

// ─── Tool definitions ────────────────────────────────────────────────────────

export const getTokenBalancesTool = {
  name: "get_token_balances",
  description:
    "Returns all token balances (ERC20 + native AVAX) for an address with USD values. Use to check vault holdings before trading. Each entry has: `balance` (EXACT decimal string, do NOT round), `balanceRaw` (wei as string), `decimals`. Use `balance` verbatim as `amountIn` when spending the full balance.",
  inputSchema: {
    type: "object",
    properties: {
      userAddress: {
        type: "string",
        description: "Optional. Wallet address to check balances for. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var.",
      },
    },
    required: [],
  },
};

export const getUserPositionsTool = {
  name: "get_user_positions",
  description:
    "Returns all active liquidity positions for an address — V2 LP balances, concentrated CL positions, and ALM (Steer/Gamma) vault positions. Includes exact V2 balances (`lpBalance`, `stakedBalance`) plus raw amounts (`lpBalanceRaw`, `stakedBalanceRaw`), token splits, claimable fees, pending emissions, sourceType (steer/gamma), vaultAddress, strategyName, and USD values for each.",
  inputSchema: {
    type: "object",
    properties: {
      userAddress: {
        type: "string",
        description: "Optional. Wallet address to check positions for. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var.",
      },
    },
    required: [],
  },
};

export const getUserLocksTool = {
  name: "get_user_locks",
  description:
    "Returns all veNFT locks for an address — locked amount, voting power, rebase rewards, lock expiry, vote distribution across pools, permanent/SMNFT status.",
  inputSchema: {
    type: "object",
    properties: {
      userAddress: {
        type: "string",
        description: "Optional. Wallet address to check locks for. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var.",
      },
    },
    required: [],
  },
};

export const getWhitelistedTokensTool = {
  name: "get_whitelisted_tokens",
  description:
    "Returns all whitelisted tokens on Blackhole DEX with current USD prices. Use to discover available tokens and their addresses.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};
