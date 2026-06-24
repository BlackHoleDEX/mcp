import {
  LEGACY_NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
  NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
  ROUTER_HELPER_ADDRESS,
  ROUTER_V2_ADDRESS,
} from "../constants/contracts.js";
import { legacyRouterV2Address } from "../common/constants/contracts/router-v2.js";
import { legacyRouterHelperAddress } from "../common/constants/contracts/router-helper.js";
import { publicClient } from "../utils/viemClient.js";
import { formatUnits } from "viem";
import { getEnvUserAddress } from "../utils/wallet.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const UNLIMITED_THRESHOLD = (2n ** 128n); // allowance > this → treat as unlimited

const KEY_SPENDERS: Record<string, `0x${string}`> = {
  router:                ROUTER_V2_ADDRESS as `0x${string}`,
  router_legacy:         legacyRouterV2Address as `0x${string}`,
  router_helper:         ROUTER_HELPER_ADDRESS as `0x${string}`,
  router_helper_legacy:  legacyRouterHelperAddress as `0x${string}`,
  nfpm:                  NONFUNGIBLE_POSITION_MANAGER_ADDRESS as `0x${string}`,
  nfpm_legacy:           LEGACY_NONFUNGIBLE_POSITION_MANAGER_ADDRESS as `0x${string}`,
  voting_escrow:         "0xEac562811cc6abDbB2c9EE88719eCA4eE79Ad763",
  gauge_manager:         "0x59aa177312Ff6Bdf39C8Af6F46dAe217bf76CBf6",
};

const ALLOWANCE_ABI = [
  {
    inputs: [
      { internalType: "address", name: "owner", type: "address" },
      { internalType: "address", name: "spender", type: "address" },
    ],
    name: "allowance",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const SYMBOL_ABI = [
  {
    inputs: [],
    name: "symbol",
    outputs: [{ internalType: "string", name: "", type: "string" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const DECIMALS_ABI = [
  {
    inputs: [],
    name: "decimals",
    outputs: [{ internalType: "uint8", name: "", type: "uint8" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

function normalizeAddress(addr: string): string {
  return addr.toLowerCase();
}

async function fetchTokenMeta(
  tokens: string[],
): Promise<Map<string, { symbol: string; decimals: number }>> {
  const map = new Map<string, { symbol: string; decimals: number }>();
  try {
    const res = await fetch("https://resources.blackhole.xyz/token-details.json");
    const data = (await res.json()) as Record<string, any>;
    for (const [key, token] of Object.entries(data ?? {})) {
      const address = normalizeAddress((token as any)?.address ?? key);
      map.set(address, {
        symbol: String((token as any)?.ticker ?? ""),
        decimals: Number((token as any)?.decimal ?? 18),
      });
    }
  } catch {}

  // For any token not in the pricing map, fetch on-chain
  const missing = tokens.filter((t) => !map.has(normalizeAddress(t)) && t !== ZERO_ADDRESS && t.startsWith("0x"));
  if (missing.length > 0) {
    const symbolCalls = missing.map((t) => ({
      address: t as `0x${string}`,
      abi: SYMBOL_ABI,
      functionName: "symbol" as const,
    }));
    const decimalsCalls = missing.map((t) => ({
      address: t as `0x${string}`,
      abi: DECIMALS_ABI,
      functionName: "decimals" as const,
    }));
    const [symbolResults, decimalsResults] = await Promise.all([
      publicClient.multicall({ contracts: symbolCalls, allowFailure: true }),
      publicClient.multicall({ contracts: decimalsCalls, allowFailure: true }),
    ]);
    missing.forEach((t, i) => {
      const sym = symbolResults[i]?.status === "success" ? String(symbolResults[i].result) : "?";
      const dec = decimalsResults[i]?.status === "success" ? Number(decimalsResults[i].result) : 18;
      map.set(normalizeAddress(t), { symbol: sym, decimals: dec });
    });
  }

  return map;
}

export interface GetAllowancesParams {
  userAddress?: string;
  /** Token addresses to check. Defaults to all whitelisted tokens. */
  tokens?: string[];
  /** Spender names from the key spenders list (router, router_helper, nfpm, voting_escrow, gauge_manager). Defaults to all. */
  spenders?: string[];
  /** Include zero allowances in the result. Defaults to false. */
  includeZero?: boolean;
}

export async function handleGetAllowances(params: GetAllowancesParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const {
    tokens: tokenOverride,
    spenders: spenderOverride,
    includeZero = false,
  } = params;

  // Resolve spenders
  const spenderNames = spenderOverride?.length
    ? spenderOverride.filter((s) => KEY_SPENDERS[s])
    : Object.keys(KEY_SPENDERS);

  if (spenderNames.length === 0) {
    throw new Error(`No valid spenders. Valid names: ${Object.keys(KEY_SPENDERS).join(", ")}.`);
  }

  // Resolve tokens
  let tokenAddresses: string[];
  if (tokenOverride?.length) {
    tokenAddresses = tokenOverride.map(normalizeAddress).filter((t) => t !== ZERO_ADDRESS);
  } else {
    // Fetch from whitelisted pricing map
    try {
      const res = await fetch("https://resources.blackhole.xyz/token-details.json");
      const data = (await res.json()) as Record<string, any>;
      tokenAddresses = Object.entries(data ?? {})
        .map(([key, token]) => normalizeAddress((token as any)?.address ?? key))
        .filter((a) => a !== ZERO_ADDRESS && a.startsWith("0x") && a.length === 42);
    } catch {
      throw new Error("Failed to fetch token list.");
    }
  }

  const tokenMeta = await fetchTokenMeta(tokenAddresses);

  // Build multicall: all (token, spender) pairs
  const pairs: { token: string; spenderName: string; spender: `0x${string}` }[] = [];
  for (const token of tokenAddresses) {
    for (const spenderName of spenderNames) {
      pairs.push({ token, spenderName, spender: KEY_SPENDERS[spenderName] });
    }
  }

  const calls = pairs.map(({ token, spender }) => ({
    address: token as `0x${string}`,
    abi: ALLOWANCE_ABI,
    functionName: "allowance" as const,
    args: [userAddress as `0x${string}`, spender],
  }));

  const results = await publicClient.multicall({ contracts: calls, allowFailure: true });

  const allowances: any[] = [];
  pairs.forEach(({ token, spenderName, spender }, i) => {
    const r = results[i];
    if (!r || r.status !== "success") return;
    const raw = r.result as bigint;
    if (!includeZero && raw === 0n) return;

    const meta = tokenMeta.get(normalizeAddress(token)) ?? { symbol: "?", decimals: 18 };
    const isUnlimited = raw >= UNLIMITED_THRESHOLD;
    const human = isUnlimited ? "unlimited" : formatUnits(raw, meta.decimals);

    allowances.push({
      token,
      symbol: meta.symbol,
      decimals: meta.decimals,
      spender,
      spenderName,
      allowance: human,
      allowanceRaw: raw.toString(),
      isUnlimited,
    });
  });

  // Sort: non-zero first, then by token symbol
  allowances.sort((a, b) => {
    if (a.allowanceRaw === "0" && b.allowanceRaw !== "0") return 1;
    if (a.allowanceRaw !== "0" && b.allowanceRaw === "0") return -1;
    return a.symbol.localeCompare(b.symbol);
  });

  return {
    success: true,
    message: `Found ${allowances.length} allowance${allowances.length !== 1 ? "s" : ""} for ${spenderNames.length} spender(s) across ${tokenAddresses.length} tokens.`,
    spenders: Object.fromEntries(spenderNames.map((n) => [n, KEY_SPENDERS[n]])),
    allowances,
  };
}

export const getAllowancesTool = {
  name: "get_allowances",
  description:
    "Returns current ERC20 allowances for a wallet across the key Blackhole DEX spenders (router, router_helper, nfpm, voting_escrow, gauge_manager). Use this before executing any transaction to check whether approvals are already in place and avoid redundant approve steps. By default only non-zero allowances are returned.",
  inputSchema: {
    type: "object",
    properties: {
      userAddress: { type: "string", description: "Optional. Wallet address to check allowances for. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      tokens: {
        type: "array",
        items: { type: "string" },
        description: "Specific token addresses to check. Omit to check all whitelisted tokens.",
      },
      spenders: {
        type: "array",
        items: { type: "string", enum: ["router", "router_helper", "nfpm", "voting_escrow", "gauge_manager"] },
        description: "Spender names to check. Omit to check all key spenders.",
      },
      includeZero: {
        type: "boolean",
        description: "Include tokens with zero allowance. Defaults to false.",
      },
    },
    required: [],
  },
};
