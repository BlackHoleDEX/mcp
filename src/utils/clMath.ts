import BigNumber from "bignumber.js";

const Q96_BN = new BigNumber(2).pow(96);
const Q96_NUM = 2 ** 96;

/**
 * Uniswap v3 / Algebra sqrt(1.0001^tick) * 2^96.
 * Uses Number math for the exponent (sufficient precision for tick range
 * ±887272) and converts to BigNumber for large-number arithmetic.
 */
export function sqrtRatioAtTickX96(tick: number): BigNumber {
  return new BigNumber(Math.pow(1.0001, tick / 2) * Q96_NUM);
}

/**
 * Returns amount0 and amount1 (raw, token decimals) for a position with the
 * given `liquidityRaw` over [tickLower, tickUpper] at a pool in the current
 * tick `tickCurrent` with `sqrtPriceX96`. Uses the standard Uniswap v3 math.
 */
export function computeAmountsFromLiquidity(args: {
  liquidityRaw: bigint;
  tickLower: number;
  tickUpper: number;
  tickCurrent: number;
  sqrtPriceX96: bigint | string;
}): { amount0Raw: bigint; amount1Raw: bigint } {
  const { liquidityRaw, tickLower, tickUpper, tickCurrent } = args;
  if (tickLower >= tickUpper) {
    throw new Error("tickLower must be less than tickUpper.");
  }

  const L = new BigNumber(liquidityRaw.toString());
  const sqrtL = sqrtRatioAtTickX96(tickLower);
  const sqrtU = sqrtRatioAtTickX96(tickUpper);
  const sqrtP = new BigNumber(args.sqrtPriceX96.toString());

  let amount0: BigNumber;
  let amount1: BigNumber;

  if (tickCurrent < tickLower) {
    amount0 = L.multipliedBy(sqrtU.minus(sqrtL))
      .multipliedBy(Q96_BN)
      .dividedBy(sqrtL.multipliedBy(sqrtU));
    amount1 = new BigNumber(0);
  } else if (tickCurrent >= tickUpper) {
    amount0 = new BigNumber(0);
    amount1 = L.multipliedBy(sqrtU.minus(sqrtL)).dividedBy(Q96_BN);
  } else {
    amount0 = L.multipliedBy(sqrtU.minus(sqrtP))
      .multipliedBy(Q96_BN)
      .dividedBy(sqrtP.multipliedBy(sqrtU));
    amount1 = L.multipliedBy(sqrtP.minus(sqrtL)).dividedBy(Q96_BN);
  }

  const toBigInt = (v: BigNumber): bigint =>
    BigInt(v.integerValue(BigNumber.ROUND_DOWN).toFixed(0));

  return {
    amount0Raw: toBigInt(amount0),
    amount1Raw: toBigInt(amount1),
  };
}

/**
 * Mirrors client's "dummy in-range position" used for CL APR TVL:
 * tickLower = floor(tick/tickSpacing)*tickSpacing, tickUpper = tickLower + tickSpacing,
 * liquidity = pool.liquidity (active).
 */
export function computeInRangePositionAmounts(args: {
  sqrtPriceX96: bigint | string;
  tickCurrent: number;
  tickSpacing: number;
  activeLiquidityRaw: bigint;
}): { amount0Raw: bigint; amount1Raw: bigint; tickLower: number; tickUpper: number } {
  const { tickCurrent, tickSpacing, activeLiquidityRaw, sqrtPriceX96 } = args;
  if (!tickSpacing || tickSpacing <= 0) {
    throw new Error("tickSpacing must be a positive integer.");
  }
  const tickLower = Math.floor(tickCurrent / tickSpacing) * tickSpacing;
  const tickUpper = tickLower + tickSpacing;
  const amounts = computeAmountsFromLiquidity({
    liquidityRaw: activeLiquidityRaw,
    tickLower,
    tickUpper,
    tickCurrent,
    sqrtPriceX96,
  });
  return { ...amounts, tickLower, tickUpper };
}
