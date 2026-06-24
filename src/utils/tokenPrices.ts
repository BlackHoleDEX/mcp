let cachedPrices: Map<string, number> | null = null;
let cacheTime = 0;
const CACHE_TTL_MS = 60_000;

export async function fetchTokenPrices(): Promise<Map<string, number>> {
  if (cachedPrices && Date.now() - cacheTime < CACHE_TTL_MS) {
    return cachedPrices;
  }
  const map = new Map<string, number>();
  try {
    const res = await fetch("https://resources.blackhole.xyz/token-details.json");
    const data = (await res.json()) as Record<string, any>;
    for (const [key, token] of Object.entries(data ?? {})) {
      map.set(((token as any)?.address ?? key).toLowerCase(), Number((token as any)?.usd_pricing ?? 0));
    }
  } catch {}
  cachedPrices = map;
  cacheTime = Date.now();
  return map;
}
