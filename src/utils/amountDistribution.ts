import BigNumber from 'bignumber.js';

/**
 * The minimum percentage of the input token to use for each route in a split route.
 * All routes will have a multiple of this value. For example if distribution percentage is 5,
 * a potential return swap would be:
 *
 * 5% of input => Route 1
 * 55% of input => Route 2
 * 40% of input => Route 3
 */
export function getAmountDistribution(
  amount: BigNumber,
  distributionPercent: number,
): [number[], BigNumber[]] {
  const percents: number[] = [];
  const amounts: BigNumber[] = [];

  for (let i = 1; i <= 100 / distributionPercent; i++) {
    // Note multiplications here can result in a loss of precision in the amounts (e.g. taking 50% of 101)
    // This is reconciled later when selecting the best route combination.
    const percent = i * distributionPercent;
    percents.push(percent);
    amounts.push(amount.multipliedBy(percent).dividedBy(100));
  }

  return [percents, amounts];
}
