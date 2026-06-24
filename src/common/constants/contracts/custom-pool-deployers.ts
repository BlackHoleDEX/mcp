// Mainnet custom pool deployers keyed by tickSpacing.
// Mirrored from SmartContracts/envFiles/mainnet/generated/custom-pool-deployers.json.
export const CUSTOM_POOL_DEPLOYERS_BY_TICK_SPACING: Record<number, `0x${string}`> = {
  1:   "0x43c4b7BD4C173992C6711c631859A2EAC84BF8Db",
  10:  "0x48b1d49fB891bAb3543Db6e902cC54726A133acE",
  50:  "0x14E4E36f70ff06DC874F0e827B174ced91e51Cc8",
  100: "0x5ef3876cA93b93c9BcfD637783Ed99412b1efF43",
  200: "0x0AFf494476Dc74CF7BB5Dd005c2B1fE7Be76efA2",
};

// Legacy deployers — mirrored from blackhole-website prodEnvConstants.customPoolBackups.
// Pools created with these deployers must use the legacy router/NFPM stack.
export const LEGACY_POOL_DEPLOYERS_BY_TICK_SPACING: Record<number, `0x${string}`> = {
  1:   "0xDcFccf2e8c4EfBba9127B80eAc76c5A122125d29",
  50:  "0x58b05074D52D1a84D8FfDAddA3c1b652e8C56994",
  100: "0xf9221dE143A0E57c324bF2a0f281e605e845D767",
  200: "0x5D433A94A4a2aA8f9AA34D8D15692Dc2E9960584",
};

export const LEGACY_POOL_DEPLOYERS = new Set<string>(
  Object.values(LEGACY_POOL_DEPLOYERS_BY_TICK_SPACING).map(a => a.toLowerCase()),
);
