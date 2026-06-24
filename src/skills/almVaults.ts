import { SERVER_CONFIG } from "../config.js";
import { publicClient } from "../utils/viemClient.js";
import { formatUnits } from "viem";

const STEER_SUBGRAPH_URL =
  "https://subgraph-proxy-server-xf2uthetka-as.a.run.app/gateway-arbitrum/GZotTj3rQJ8ZqVyodtK8TcnKcUxMgeF7mCJHGPYbu8dA";

// ── Shared vault ABI (both Steer and Gamma implement this interface) ───────────

const VAULT_ABI = [
  {
    inputs: [],
    name: "getTotalAmounts",
    outputs: [
      { name: "total0", internalType: "uint256", type: "uint256" },
      { name: "total1", internalType: "uint256", type: "uint256" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ name: "account", internalType: "address", type: "address" }],
    name: "balanceOf",
    outputs: [{ name: "", internalType: "uint256", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "pool",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token0",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "token1",
    outputs: [{ name: "", internalType: "address", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "name",
    outputs: [{ name: "", internalType: "string", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const ERC20_DECIMALS_ABI = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ name: "", internalType: "uint8", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

// ── Internal vault record type ─────────────────────────────────────────────────

interface VaultRecord {
  vaultAddress: string;
  poolAddress: string;
  sourceType: "steer" | "gamma";
  strategyName: string;
  token0: string;
  token1: string;
  token0Decimals: number;
  token1Decimals: number;
  strategyMetadata?: { executionBundle?: string; strategyTokenId?: string; strategyTokenName?: string };
}

// ── Token pricing helper ───────────────────────────────────────────────────────

export async function fetchALMTokenPrices(): Promise<
  Map<string, { symbol: string; decimals: number; usdPrice: number }>
> {
  const map = new Map<string, { symbol: string; decimals: number; usdPrice: number }>();
  try {
    const res = await fetch("https://resources.blackhole.xyz/token-details.json");
    const data = (await res.json()) as Record<string, any>;
    for (const [key, token] of Object.entries(data ?? {})) {
      const address = ((token as any)?.address ?? key).toLowerCase();
      map.set(address, {
        symbol: String((token as any)?.ticker ?? ""),
        decimals: Number((token as any)?.decimal ?? 18),
        usdPrice: Number((token as any)?.usd_pricing ?? 0),
      });
    }
  } catch {}
  return map;
}

// ── Fetch all Blackhole CL pool addresses from subgraph ───────────────────────

async function fetchBlackholePools(): Promise<Set<string>> {
  const pools = new Set<string>();
  try {
    // Paginate if needed — most deployments have < 1000 pools
    let skip = 0;
    while (true) {
      const res = await fetch(SERVER_CONFIG.CL_GRAPH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `{ pools(first: 1000, skip: ${skip}) { id } }`,
        }),
      });
      const json = (await res.json()) as { data?: { pools?: any[] } };
      const page = json?.data?.pools ?? [];
      for (const p of page) pools.add(String(p.id ?? "").toLowerCase());
      if (page.length < 1000) break;
      skip += 1000;
    }
  } catch {}
  return pools;
}

// ── Steer: query ALL vaults, then filter by known Blackhole pools ─────────────

async function fetchSteerVaultsDynamic(blackholePools: Set<string>): Promise<VaultRecord[]> {
  try {
    // Paginate — a Steer deployment can have many vaults across all DEXs
    const records: VaultRecord[] = [];
    let skip = 0;
    while (true) {
      const res = await fetch(STEER_SUBGRAPH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          query: `{
            vaults(first: 1000, skip: ${skip}) {
              id
              pool
              token0
              token1
              token0Decimals
              token1Decimals
              strategyToken { id name executionBundle }
            }
          }`,
        }),
      });
      const json = (await res.json()) as { data?: { vaults?: any[] } };
      const page = json?.data?.vaults ?? [];

      for (const v of page) {
        const poolAddr = String(v.pool ?? "").toLowerCase();
        if (!blackholePools.has(poolAddr)) continue; // skip vaults not on this DEX

        records.push({
          vaultAddress: String(v.id ?? "").toLowerCase(),
          poolAddress: poolAddr,
          sourceType: "steer",
          strategyName: v.strategyToken?.name ?? "Steer Vault",
          token0: String(v.token0 ?? "").toLowerCase(),
          token1: String(v.token1 ?? "").toLowerCase(),
          token0Decimals: Number(v.token0Decimals ?? 18),
          token1Decimals: Number(v.token1Decimals ?? 18),
          strategyMetadata: v.strategyToken
            ? {
                strategyTokenId: v.strategyToken.id,
                strategyTokenName: v.strategyToken.name,
                executionBundle: v.strategyToken.executionBundle,
              }
            : undefined,
        });
      }

      if (page.length < 1000) break;
      skip += 1000;
    }
    return records;
  } catch {
    return [];
  }
}

// ── Gamma: on-chain discovery from configured vault addresses ─────────────────
// Addresses come from GAMMA_VAULT_ADDRESSES env var (or defaults in config.ts).
// All metadata (pool, tokens, name) is fetched from the contracts — no hardcoding.

async function fetchGammaVaultsDynamic(): Promise<VaultRecord[]> {
  const addresses = SERVER_CONFIG.GAMMA_VAULT_ADDRESSES;
  if (addresses.length === 0) return [];

  // Batch 1: pool(), token0(), token1(), name() for each vault
  const batch1 = addresses.flatMap((addr) => [
    { address: addr as `0x${string}`, abi: VAULT_ABI, functionName: "pool" as const },
    { address: addr as `0x${string}`, abi: VAULT_ABI, functionName: "token0" as const },
    { address: addr as `0x${string}`, abi: VAULT_ABI, functionName: "token1" as const },
    { address: addr as `0x${string}`, abi: VAULT_ABI, functionName: "name" as const },
  ]);

  const results1 = await publicClient.multicall({ contracts: batch1, allowFailure: true });

  // Collect unique token addresses for decimal lookup
  const tokenSet = new Set<string>();
  const vaultMeta: Array<{ addr: string; pool: string; token0: string; token1: string; name: string } | null> =
    addresses.map((addr, i) => {
      const rPool  = results1[i * 4 + 0];
      const rTok0  = results1[i * 4 + 1];
      const rTok1  = results1[i * 4 + 2];
      const rName  = results1[i * 4 + 3];
      if (rPool.status !== "success" || rTok0.status !== "success" || rTok1.status !== "success") return null;
      const pool   = String(rPool.result as string).toLowerCase();
      const token0 = String(rTok0.result as string).toLowerCase();
      const token1 = String(rTok1.result as string).toLowerCase();
      tokenSet.add(token0);
      tokenSet.add(token1);
      return { addr, pool, token0, token1, name: rName.status === "success" ? String(rName.result) : "Gamma Vault" };
    });

  // Batch 2: decimals() for each unique token
  const uniqueTokens = [...tokenSet];
  const decimalResults = await publicClient.multicall({
    contracts: uniqueTokens.map((t) => ({
      address: t as `0x${string}`,
      abi: ERC20_DECIMALS_ABI,
      functionName: "decimals" as const,
    })),
    allowFailure: true,
  });

  const decimalsMap = new Map<string, number>();
  for (let i = 0; i < uniqueTokens.length; i++) {
    const r = decimalResults[i];
    decimalsMap.set(uniqueTokens[i], r.status === "success" ? Number(r.result as unknown as number) : 18);
  }

  return vaultMeta
    .filter((m): m is NonNullable<typeof m> => m !== null)
    .map((m) => ({
      vaultAddress: m.addr,
      poolAddress: m.pool,
      sourceType: "gamma" as const,
      strategyName: m.name,
      token0: m.token0,
      token1: m.token1,
      token0Decimals: decimalsMap.get(m.token0) ?? 18,
      token1Decimals: decimalsMap.get(m.token1) ?? 18,
    }));
}

// ── Combine Steer + Gamma into unified vault list ─────────────────────────────

async function buildVaultList(): Promise<VaultRecord[]> {
  // Fetch Blackhole pool IDs first (needed to filter Steer vaults)
  const blackholePools = await fetchBlackholePools();
  const [steerVaults, gammaVaults] = await Promise.all([
    fetchSteerVaultsDynamic(blackholePools),
    fetchGammaVaultsDynamic(),
  ]);
  return [...steerVaults, ...gammaVaults];
}

// ── Batch fetch getTotalAmounts + totalSupply for a list of vaults ─────────────

async function fetchVaultTVLData(
  vaults: VaultRecord[]
): Promise<Map<string, { total0: bigint; total1: bigint; totalSupply: bigint }>> {
  const map = new Map<string, { total0: bigint; total1: bigint; totalSupply: bigint }>();
  if (vaults.length === 0) return map;

  const calls = vaults.flatMap((v) => [
    { address: v.vaultAddress as `0x${string}`, abi: VAULT_ABI, functionName: "getTotalAmounts" as const },
    { address: v.vaultAddress as `0x${string}`, abi: VAULT_ABI, functionName: "totalSupply" as const },
  ]);

  const results = await publicClient.multicall({ contracts: calls, allowFailure: true });

  for (let i = 0; i < vaults.length; i++) {
    const rAmounts = results[i * 2];
    const rSupply  = results[i * 2 + 1];
    if (rAmounts.status === "success" && rSupply.status === "success") {
      const [total0, total1] = rAmounts.result as [bigint, bigint];
      map.set(vaults[i].vaultAddress, { total0, total1, totalSupply: rSupply.result as bigint });
    }
  }
  return map;
}

// ── Fetch pool-level volume + fees from CL subgraph ───────────────────────────

async function fetchPoolMetrics(
  poolAddresses: string[]
): Promise<Map<string, { volumeUSD: number; feesUSD: number }>> {
  const map = new Map<string, { volumeUSD: number; feesUSD: number }>();
  if (poolAddresses.length === 0) return map;
  try {
    const res = await fetch(SERVER_CONFIG.CL_GRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
          pools(where: { id_in: [${poolAddresses.map((a) => `"${a}"`).join(",")}] }) {
            id volumeUSD feesUSD
          }
        }`,
      }),
    });
    const json = (await res.json()) as { data?: { pools?: any[] } };
    for (const pool of json?.data?.pools ?? []) {
      map.set(String(pool.id ?? "").toLowerCase(), {
        volumeUSD: Number(pool.volumeUSD ?? 0),
        feesUSD: Number(pool.feesUSD ?? 0),
      });
    }
  } catch {}
  return map;
}

// ── handleGetALMVaults ─────────────────────────────────────────────────────────

export interface GetALMVaultsParams {
  poolAddress?: string;
  activeOnly?: boolean;
  sourceType?: "steer" | "gamma" | "all";
}

export async function handleGetALMVaults(params: GetALMVaultsParams) {
  const { poolAddress, activeOnly = false, sourceType = "all" } = params;

  const [allVaults, tokenPrices] = await Promise.all([buildVaultList(), fetchALMTokenPrices()]);

  let vaults = allVaults;
  if (poolAddress) vaults = vaults.filter((v) => v.poolAddress === poolAddress.toLowerCase());
  if (sourceType !== "all") vaults = vaults.filter((v) => v.sourceType === sourceType);

  const poolAddresses = [...new Set(vaults.map((v) => v.poolAddress).filter(Boolean))];
  const [tvlData, poolMetrics] = await Promise.all([
    fetchVaultTVLData(vaults),
    fetchPoolMetrics(poolAddresses),
  ]);

  const results = vaults
    .map((vault) => {
      const tvl    = tvlData.get(vault.vaultAddress);
      const pool   = poolMetrics.get(vault.poolAddress);
      const price0 = tokenPrices.get(vault.token0)?.usdPrice ?? 0;
      const price1 = tokenPrices.get(vault.token1)?.usdPrice ?? 0;
      const symbol0 = tokenPrices.get(vault.token0)?.symbol ?? "";
      const symbol1 = tokenPrices.get(vault.token1)?.symbol ?? "";

      let amount0 = 0, amount1 = 0, tvlUsd = 0, totalSupply = "0";
      if (tvl) {
        amount0 = Number(formatUnits(tvl.total0, vault.token0Decimals));
        amount1 = Number(formatUnits(tvl.total1, vault.token1Decimals));
        tvlUsd  = amount0 * price0 + amount1 * price1;
        totalSupply = formatUnits(tvl.totalSupply, 18);
      }

      return {
        sourceType: vault.sourceType,
        vaultAddress: vault.vaultAddress,
        poolAddress: vault.poolAddress,
        strategyName: vault.strategyName,
        managerAddress: vault.sourceType === "steer" ? "Steer Protocol" : "Gamma",
        active: tvlUsd > 0,
        token0: { address: vault.token0, symbol: symbol0, decimals: vault.token0Decimals, amount: amount0.toFixed(6) },
        token1: { address: vault.token1, symbol: symbol1, decimals: vault.token1Decimals, amount: amount1.toFixed(6) },
        tvlUsd: Number(tvlUsd.toFixed(2)),
        totalSupply,
        volumeUSD: pool != null ? Number(pool.volumeUSD.toFixed(2)) : null,
        feesUSD: pool != null ? Number(pool.feesUSD.toFixed(2)) : null,
        strategyMetadata: vault.strategyMetadata ?? null,
      };
    })
    .filter((v) => !activeOnly || v.active)
    .sort((a, b) => b.tvlUsd - a.tvlUsd);

  const totalTvl = results.reduce((s, v) => s + v.tvlUsd, 0);
  const steerTvl = results.filter((v) => v.sourceType === "steer").reduce((s, v) => s + v.tvlUsd, 0);
  const gammaTvl = results.filter((v) => v.sourceType === "gamma").reduce((s, v) => s + v.tvlUsd, 0);

  return {
    success: true,
    message: `Found ${results.length} ALM vault(s). Total managed TVL: $${totalTvl.toFixed(2)} (Steer: $${steerTvl.toFixed(2)}, Gamma: $${gammaTvl.toFixed(2)}).`,
    totalTvlUsd: Number(totalTvl.toFixed(2)),
    steerTvlUsd: Number(steerTvl.toFixed(2)),
    gammaTvlUsd: Number(gammaTvl.toFixed(2)),
    vaults: results,
  };
}

// ── fetchALMVaultsForPool — used by poolStatus.ts ─────────────────────────────

export async function fetchALMVaultsForPool(
  poolAddress: string,
  tokenPrices: Map<string, { symbol: string; decimals: number; usdPrice: number }>
) {
  const allVaults = await buildVaultList();
  const poolVaults = allVaults.filter((v) => v.poolAddress === poolAddress.toLowerCase());
  if (poolVaults.length === 0) return [];

  const tvlData = await fetchVaultTVLData(poolVaults);

  return poolVaults
    .map((vault) => {
      const tvl    = tvlData.get(vault.vaultAddress);
      const price0 = tokenPrices.get(vault.token0)?.usdPrice ?? 0;
      const price1 = tokenPrices.get(vault.token1)?.usdPrice ?? 0;
      const symbol0 = tokenPrices.get(vault.token0)?.symbol ?? "";
      const symbol1 = tokenPrices.get(vault.token1)?.symbol ?? "";

      let amount0 = 0, amount1 = 0, tvlUsd = 0;
      if (tvl) {
        amount0 = Number(formatUnits(tvl.total0, vault.token0Decimals));
        amount1 = Number(formatUnits(tvl.total1, vault.token1Decimals));
        tvlUsd  = amount0 * price0 + amount1 * price1;
      }

      return {
        sourceType: vault.sourceType,
        vaultAddress: vault.vaultAddress,
        strategyName: vault.strategyName,
        managerAddress: vault.sourceType === "steer" ? "Steer Protocol" : "Gamma",
        active: tvlUsd > 0,
        token0: { address: vault.token0, symbol: symbol0, amount: amount0.toFixed(6) },
        token1: { address: vault.token1, symbol: symbol1, amount: amount1.toFixed(6) },
        tvlUsd: Number(tvlUsd.toFixed(2)),
        strategyMetadata: vault.strategyMetadata ?? null,
      };
    })
    .sort((a, b) => b.tvlUsd - a.tvlUsd);
}

// ── fetchUserALMPositions — used by portfolio.ts ──────────────────────────────

export async function fetchUserALMPositions(
  userAddress: string,
  tokenPrices: Map<string, { symbol: string; decimals: number; usdPrice: number }>
) {
  const allVaults = await buildVaultList();

  const balanceCalls = allVaults.map((v) => ({
    address: v.vaultAddress as `0x${string}`,
    abi: VAULT_ABI,
    functionName: "balanceOf" as const,
    args: [userAddress as `0x${string}`],
  }));

  const balanceResults = await publicClient.multicall({ contracts: balanceCalls, allowFailure: true });

  const active: Array<{ vault: VaultRecord; shares: bigint }> = [];
  for (let i = 0; i < allVaults.length; i++) {
    const r = balanceResults[i];
    if (r.status === "success" && (r.result as bigint) > 0n) {
      active.push({ vault: allVaults[i], shares: r.result as bigint });
    }
  }

  if (active.length === 0) return [];

  const tvlData = await fetchVaultTVLData(active.map((a) => a.vault));

  return active
    .map(({ vault, shares }) => {
      const tvl = tvlData.get(vault.vaultAddress);
      let amount0 = 0, amount1 = 0, positionUsd = 0;

      if (tvl && tvl.totalSupply > 0n) {
        const userAmount0 = (tvl.total0 * shares) / tvl.totalSupply;
        const userAmount1 = (tvl.total1 * shares) / tvl.totalSupply;
        amount0 = Number(formatUnits(userAmount0, vault.token0Decimals));
        amount1 = Number(formatUnits(userAmount1, vault.token1Decimals));
        const price0 = tokenPrices.get(vault.token0)?.usdPrice ?? 0;
        const price1 = tokenPrices.get(vault.token1)?.usdPrice ?? 0;
        positionUsd = amount0 * price0 + amount1 * price1;
      }

      const symbol0 = tokenPrices.get(vault.token0)?.symbol ?? "";
      const symbol1 = tokenPrices.get(vault.token1)?.symbol ?? "";

      return {
        pool: `${symbol0}/${symbol1} (${vault.strategyName})`,
        poolAddress: vault.poolAddress,
        poolType: "concentrated",
        concentrated: true,
        sourceType: vault.sourceType,
        vaultAddress: vault.vaultAddress,
        strategyName: vault.strategyName,
        managerAddress: vault.sourceType === "steer" ? "Steer Protocol" : "Gamma",
        token0: { symbol: symbol0, address: vault.token0, amount: amount0.toFixed(6) },
        token1: { symbol: symbol1, address: vault.token1, amount: amount1.toFixed(6) },
        shares: formatUnits(shares, 18),
        positionUsd: positionUsd.toFixed(2),
      };
    })
    .sort((a, b) => parseFloat(b.positionUsd) - parseFloat(a.positionUsd));
}

// ── Tool definition ────────────────────────────────────────────────────────────

export const getALMVaultsTool = {
  name: "get_alm_vaults",
  description:
    "Lists all ALM (Automated Liquidity Management) vaults managed by Steer Protocol and Gamma on Blackhole DEX. Steer vaults are discovered dynamically via the Steer subgraph (filtered to Blackhole pools). Gamma vaults are discovered via on-chain calls to configured vault addresses. Returns per vault: sourceType, poolAddress, vaultAddress, strategyName, managerAddress, token amounts, tvlUsd, pool volumeUSD/feesUSD (cumulative), active (tvlUsd > 0), and Steer strategy metadata. Filter by poolAddress, activeOnly, or sourceType.",
  inputSchema: {
    type: "object",
    properties: {
      poolAddress: {
        type: "string",
        description: "Optional: filter to vaults managing liquidity for a specific pool address.",
      },
      activeOnly: {
        type: "boolean",
        description: "If true, return only vaults with tvlUsd > 0. Defaults to false.",
      },
      sourceType: {
        type: "string",
        enum: ["steer", "gamma", "all"],
        description: "Filter by ALM provider. Defaults to 'all'.",
      },
    },
  },
};
