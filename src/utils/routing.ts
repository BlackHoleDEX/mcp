// Simplified route computation port from blackhole-website

import { ROUTER_HELPER_ADDRESS } from '../constants/contracts.js';

export const enum PoolType {
  BASIC_VOLATILE = 0,
  BASIC_STABLE = 1,
  CONCENTRATED_VOLATILE = 2,
  CONCENTRATED_STABLE = 3,
}

export interface CandidatePool {
  pairAddress: string;
  token0: string;
  token1: string;
  tempToken0?: string;
  tempToken1?: string;
  poolType: PoolType;
  stable: boolean;
  concentrated: boolean;
}

export type RouteStep = {
  pair: string;
  from: string;
  to: string;
  token0: string; // canonical pool token0 — used to determine swap direction for price impact
  stable: boolean;
  concentrated: boolean;
  receiver: string;
};

export type BaseRoute = {
  routes: RouteStep[];
};

export function buildPoolMap(candidatePools: CandidatePool[]) {
  const poolMap: Record<string, Record<string, CandidatePool[]>> = {};
  for (const pool of candidatePools) {
    const t0 = pool.token0.toLowerCase();
    const t1 = pool.token1.toLowerCase();

    if (!poolMap[t0]) poolMap[t0] = {};
    if (!poolMap[t1]) poolMap[t1] = {};
    if (!poolMap[t0][t1]) poolMap[t0][t1] = [];
    if (!poolMap[t1][t0]) poolMap[t1][t0] = [];
    poolMap[t0][t1].push(pool);
    poolMap[t1][t0].push(pool);
  }
  return poolMap;
}

export const buildBaseRoute = (
  currentRoute: CandidatePool[],
  user: string,
): RouteStep[] => {
  return currentRoute.map((pairInfo, i) => ({
    pair: pairInfo.pairAddress,
    from: pairInfo.tempToken0!,
    to: pairInfo.tempToken1!,
    token0: pairInfo.token0,
    stable: pairInfo.stable,
    concentrated: pairInfo.concentrated,
    // Mirror website logic: intermediate hops route tokens to the next pool
    // (or the router helper for CL next-hops). Last hop delivers to the user.
    receiver:
      i < currentRoute.length - 1
        ? currentRoute[i + 1]!.concentrated
          ? ROUTER_HELPER_ADDRESS   // CL next hop: use router helper as callback recipient
          : currentRoute[i + 1]!.pairAddress  // basic next hop: send directly to next pool
        : user,
  }));
};

export function computeAllRoutes(
  input: string,
  output: string,
  candidatePools: CandidatePool[],
  user: string,
): BaseRoute[] {
  const poolMap = buildPoolMap(candidatePools);
  const routes: BaseRoute[] = [];
  const inputL = input.toLowerCase();
  const outputL = output.toLowerCase();

  // 1-hop
  if (poolMap[inputL]?.[outputL]) {
    for (const pool of poolMap[inputL][outputL]) {
      routes.push({
        routes: buildBaseRoute(
          [{ ...pool, tempToken0: input, tempToken1: output }],
          user,
        ),
      });
    }
  }

  // 2-hop: input -> X -> output
  for (const x in poolMap[inputL]) {
    if (x === outputL) continue;
    if (poolMap[x]?.[outputL]) {
      for (const pool1 of poolMap[inputL][x]) {
        for (const pool2 of poolMap[x][outputL]) {
          if (pool1.pairAddress === pool2.pairAddress) continue;
          routes.push({
            routes: buildBaseRoute(
              [
                { ...pool1, tempToken0: input, tempToken1: x },
                { ...pool2, tempToken0: x, tempToken1: output },
              ],
              user,
            ),
          });
        }
      }
    }
  }

  // 3-hop: input -> X -> Y -> output
  for (const x in poolMap[inputL]) {
    if (x === outputL) continue;
    for (const y in poolMap[x]) {
      if (y === inputL || y === outputL) continue;
      if (poolMap[y]?.[outputL]) {
        for (const pool1 of poolMap[inputL][x]) {
          for (const pool2 of poolMap[x][y]) {
            for (const pool3 of poolMap[y][outputL]) {
              const addresses = [
                pool1.pairAddress,
                pool2.pairAddress,
                pool3.pairAddress,
              ];
              if (new Set(addresses).size < 3) continue;
              routes.push({
                routes: buildBaseRoute(
                  [
                    { ...pool1, tempToken0: input, tempToken1: x },
                    { ...pool2, tempToken0: x, tempToken1: y },
                    { ...pool3, tempToken0: y, tempToken1: output },
                  ],
                  user,
                ),
              });
            }
          }
        }
      }
    }
  }
  return routes;
}
