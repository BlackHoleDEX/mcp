import BigNumber from 'bignumber.js';

import { BaseRoute, RouteStep } from './routing.js';

export type RouteWithoutQuote = BaseRoute & {
  amount: BigNumber;
  percent: number;
};

export type RouteWithQuote = BaseRoute & {
  amount: BigNumber;
  percent: number;
  quote: BigNumber;
  route: RouteStep[];
};

export type BestRoutes = {
  routes: Array<{
    percent: number;
    amount: BigNumber;
    quote: BigNumber;
    route: RouteStep[];
  }>;
  totalQuote: BigNumber;
  inputAmount: BigNumber;
  outputAmount: BigNumber;
};

interface Config {
  minSplits?: number;
  maxSplits?: number;
  seedCandidatesPerPercent?: number;
  // eslint-disable-next-line no-unused-vars
  isRouteWithQuoteValid?: (routeWithQuote: RouteWithQuote) => boolean;
}

class Queue<T> {
  private items: T[] = [];

  enqueue(item: T): void {
    this.items.push(item);
  }

  dequeue(): T | undefined {
    return this.items.shift();
  }

  get size(): number {
    return this.items.length;
  }
}

function getPoolAddress(route: RouteStep): string {
  return route.pair;
}

function findFirstRouteNotUsingUsedPools(
  usedRoutes: RouteWithQuote[],
  candidateRouteQuotes: RouteWithQuote[],
): RouteWithQuote | null {
  const usedPoolAddresses = new Set<string>();

  for (const usedRoute of usedRoutes) {
    for (const routeStep of usedRoute.routes) {
      usedPoolAddresses.add(getPoolAddress(routeStep).toLowerCase());
    }
  }

  for (const routeQuote of candidateRouteQuotes) {
    const hasSharedPool = routeQuote.routes.some((r) =>
      usedPoolAddresses.has(getPoolAddress(r).toLowerCase()),
    );

    if (!hasSharedPool) {
      return routeQuote;
    }
  }

  return null;
}

export function getBestRouteCombinationByQuotes(
  amount: BigNumber,
  routesWithQuote: RouteWithQuote[],
  config: Config = { maxSplits: 4, minSplits: 0 },
): BestRoutes | null {
  const percents: number[] = [];
  const percentToQuotes: { [percent: number]: RouteWithQuote[] } = {};

  for (const routeWithQuote of routesWithQuote) {
    if (!percentToQuotes[routeWithQuote.percent]) {
      percentToQuotes[routeWithQuote.percent] = [];
      percents.push(routeWithQuote.percent);
    }
    percentToQuotes[routeWithQuote.percent]!.push(routeWithQuote);
  }

  const swapRoute = getBestSwapRouteBy(
    percentToQuotes,
    percents.sort((a, b) => a - b),
    config,
  );

  if (!swapRoute) {
    return null;
  }

  const { routes: routeAmounts } = swapRoute;
  const totalAmount = routeAmounts.reduce(
    (total, routeAmount) => total.plus(routeAmount.amount),
    BigNumber(0),
  );

  const missingAmount = amount.minus(totalAmount);
  if (missingAmount.isGreaterThan(0)) {
    routeAmounts[routeAmounts.length - 1]!.amount =
      routeAmounts[routeAmounts.length - 1]!.amount.plus(missingAmount);
  }

  const sortedRoutes = routeAmounts.sort(
    (a, b) => b.amount.comparedTo(a.amount) || 0,
  );

  const totalQuote = sortedRoutes.reduce((sum, r) => sum.plus(r.quote), BigNumber(0));

  return {
    routes: sortedRoutes.map(
      ({ percent, amount: routeAmount, quote, route }) => ({
        percent,
        amount: routeAmount,
        quote,
        route,
      }),
    ),
    totalQuote,
    inputAmount: amount,
    outputAmount: totalQuote,
  };
}

function getBestSwapRouteBy(
  percentToQuotes: { [percent: number]: RouteWithQuote[] },
  percents: number[],
  {
    maxSplits = 4,
    minSplits = 0,
    seedCandidatesPerPercent = 2,
    isRouteWithQuoteValid,
  }: Config,
): {
  quote: BigNumber;
  routes: RouteWithQuote[];
} | null {
  const percentToSortedQuotes: { [percent: number]: RouteWithQuote[] } = {};

  for (const percent in percentToQuotes) {
    const routes = percentToQuotes[percent]!;
    const filteredRoutes = isRouteWithQuoteValid
      ? routes.filter(isRouteWithQuoteValid)
      : routes;
    if (filteredRoutes.length === 0) {
      continue;
    }
    percentToSortedQuotes[percent] = filteredRoutes.sort(
      (a, b) => b.quote.comparedTo(a.quote) || 0,
    );
  }

  let bestQuote: BigNumber | undefined;
  let bestSwap: RouteWithQuote[] | undefined;

  if (percentToSortedQuotes[100] && minSplits <= 1) {
    bestQuote = percentToSortedQuotes[100][0]!.quote;
    bestSwap = [percentToSortedQuotes[100][0]!];
  }

  const queue = new Queue<{
    percentIndex: number;
    curRoutes: RouteWithQuote[];
    remainingPercent: number;
  }>();

  for (let i = percents.length - 1; i >= 0; i--) {
    const percent = percents[i]!;

    if (!percentToSortedQuotes[percent]) {
      continue;
    }

    const seedCount = Math.max(1, Math.floor(seedCandidatesPerPercent));
    const seedRoutes = percentToSortedQuotes[percent]!.slice(0, seedCount);
    for (const seedRoute of seedRoutes) {
      queue.enqueue({
        curRoutes: [seedRoute],
        percentIndex: i,
        remainingPercent: 100 - percent,
      });
    }
  }

  let splits = 1;

  while (queue.size > 0) {
    const layer = queue.size;
    splits++;

    if (splits >= 3 && bestSwap && bestSwap.length < splits - 1) {
      break;
    }

    if (splits > maxSplits) {
      break;
    }

    let currentLayer = layer;
    while (currentLayer > 0) {
      currentLayer--;

      const { remainingPercent, curRoutes, percentIndex } = queue.dequeue()!;

      for (let i = percentIndex; i >= 0; i--) {
        const percentA = percents[i]!;

        if (percentA > remainingPercent) {
          continue;
        }

        if (!percentToSortedQuotes[percentA]) {
          continue;
        }

        const candidateRoutesA = percentToSortedQuotes[percentA]!;
        const routeWithQuoteA = findFirstRouteNotUsingUsedPools(
          curRoutes,
          candidateRoutesA,
        );

        if (!routeWithQuoteA) {
          continue;
        }

        const remainingPercentNew = remainingPercent - percentA;
        const curRoutesNew = [...curRoutes, routeWithQuoteA];

        if (remainingPercentNew === 0 && splits >= minSplits) {
          const quoteNew = curRoutesNew.reduce(
            (sum, r) => sum.plus(r.quote),
            BigNumber(0),
          );

          if (!bestQuote || quoteNew.isGreaterThan(bestQuote)) {
            bestQuote = quoteNew;
            bestSwap = curRoutesNew;
          }
        } else if (remainingPercentNew > 0) {
          queue.enqueue({
            curRoutes: curRoutesNew,
            remainingPercent: remainingPercentNew,
            percentIndex: i,
          });
        }
      }
    }
  }

  if (!bestSwap) {
    return null;
  }

  const quote = bestSwap.reduce((sum, r) => sum.plus(r.quote), BigNumber(0));

  return {
    quote,
    routes: bestSwap,
  };
}
