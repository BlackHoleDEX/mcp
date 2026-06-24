export const AVAX_SENTINEL = "0xavax";

export function getWrappedAvaxAddress(): string {
  return "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7";
}

export function isNativeAvaxToken(token: string): boolean {
  return token.toLowerCase() === AVAX_SENTINEL;
}

export function normalizeTokenAddress(token: string): string {
  return isNativeAvaxToken(token) ? getWrappedAvaxAddress() : token;
}
