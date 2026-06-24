/**
 * Fee-derived volume — used by both V2 and CL pools.
 * Mirrors web client: pair.ts getTokenVolumes = tokenFees / feePercent * 100
 * feePercent is in percentage units (e.g. 0.04 for a 0.04% stable pool).
 */
export function computeVolumeFromFees(feesUsd: number, feePercent: number): number {
  return feePercent > 0 ? (feesUsd * 100) / feePercent : 0;
}

/**
 * Returns true if the poolDayData entry date is within the last 24 hours.
 * Matches web client staleness check in convertClPairObjectToPairInfo (pair.ts ~line 993).
 */
export function isDayDataFresh(dayDateUnixSeconds: number | string): boolean {
  return Date.now() - Number(dayDateUnixSeconds) * 1000 <= 24 * 60 * 60 * 1000;
}
