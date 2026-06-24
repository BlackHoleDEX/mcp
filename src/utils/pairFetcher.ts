import { publicClient } from './viemClient.js';
import { SERVER_CONFIG } from '../config.js';
import { CandidatePool, PoolType } from './routing.js';
import { BLACKHOLE_PAIR_ABI, BLACKHOLE_PAIR_API_V2_ADDRESS } from '../constants/contracts.js';

const BASIC_POOL_PAGE_SIZES = [1000n, 500n, 200n, 100n];
const MAX_PAGES = 20n;

// This queries GraphQL for CL pools if the URL is provided, otherwise returns []
export async function fetchCLPools(): Promise<CandidatePool[]> {
  try {
    const res = await fetch(SERVER_CONFIG.CL_GRAPH_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ query: '{ pools { id token0 { id } token1 { id } tickSpacing } }' })
    });
    const data = await res.json();
    if (!data?.data?.pools) return [];

    return data.data.pools.map((p: any) => {
      // tickSpacing = 1 → stable, > 1 → volatile (mirrors website pair.ts logic).
      const isStable = Number(p.tickSpacing ?? 0) <= 1;
      return {
        pairAddress: p.id,
        token0: p.token0.id,
        token1: p.token1.id,
        poolType: isStable ? PoolType.CONCENTRATED_STABLE : PoolType.CONCENTRATED_VOLATILE,
        stable: isStable,
        concentrated: true,
      };
    });
  } catch (e) {
    console.error("Failed to fetch CL Pools:", e);
    return [];
  }
}

export async function fetchAllCandidatePools(userAddress: string): Promise<CandidatePool[]> {
  const pools: CandidatePool[] = [];
  
  // 1. Fetch Basic Pools
  let basicPoolsLoaded = false;
  for (const pageSize of BASIC_POOL_PAGE_SIZES) {
    try {
      const attemptPools: CandidatePool[] = [];
      let offset = 0n;
      let pageCount = 0n;

      while (pageCount < MAX_PAGES) {
        const data = (await publicClient.readContract({
          address: BLACKHOLE_PAIR_API_V2_ADDRESS as any,
          abi: BLACKHOLE_PAIR_ABI,
          functionName: 'getAllPair',
          args: [userAddress as any, pageSize, offset],
        })) as any;

        const hasNext = Boolean(data?.[1]);
        const pairsInfo = (data?.[2] ?? []) as any[];

        for (const p of pairsInfo) {
          attemptPools.push({
            pairAddress: p.pair_address,
            token0: p.token0,
            token1: p.token1,
            poolType: p.stable ? PoolType.BASIC_STABLE : PoolType.BASIC_VOLATILE,
            stable: p.stable,
            concentrated: false,
          });
        }

        if (!hasNext || pairsInfo.length === 0) {
          break;
        }

        offset += pageSize;
        pageCount += 1n;
      }

      pools.push(...attemptPools);
      basicPoolsLoaded = true;
      break;
    } catch (e) {
      // Try smaller page size if RPC fails (commonly "out of gas" on large eth_call pages).
      continue;
    }
  }

  if (!basicPoolsLoaded) {
    console.error('Error fetching basic pairs: all page-size attempts failed.');
  }

  // 2. Fetch CL Pools
  const clPools = await fetchCLPools();
  pools.push(...clPools);

  return pools;
}
