/**
 * Disambiguates concentrated pools that share the same token pair but differ by tickSpacing
 * (e.g. CL1-WAVAX/USDC vs CL50-WAVAX/USDC).
 */
export function formatCLPoolSymbol(
  tickSpacing: number,
  token0Symbol: string,
  token1Symbol: string,
): string {
  const t0 = token0Symbol.trim() || "?";
  const t1 = token1Symbol.trim() || "?";
  const ts = Math.abs(Math.trunc(tickSpacing));
  return `CL${ts}-${t0}/${t1}`;
}

export function formatCLPoolName(
  tickSpacing: number,
  token0Name: string,
  token1Name: string,
): string {
  const t0 = token0Name.trim() || "?";
  const t1 = token1Name.trim() || "?";
  const ts = Math.abs(Math.trunc(tickSpacing));
  return `CL${ts}-${t0}/${t1}`;
}

export function resolveCLTickSpacing(
  subgraphTickSpacing: string | number | undefined,
  onChainTickSpacing: number | string | bigint | undefined,
): number | undefined {
  const fromSg =
    subgraphTickSpacing !== undefined && subgraphTickSpacing !== ""
      ? Number(subgraphTickSpacing)
      : NaN;
  if (Number.isFinite(fromSg) && fromSg > 0) return fromSg;

  const fromChain =
    onChainTickSpacing !== undefined && onChainTickSpacing !== null
      ? Number(onChainTickSpacing)
      : NaN;
  if (Number.isFinite(fromChain) && fromChain > 0) return fromChain;

  return undefined;
}
