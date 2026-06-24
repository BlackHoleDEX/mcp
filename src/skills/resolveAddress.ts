import { CUSTOM_POOL_DEPLOYERS_BY_TICK_SPACING, LEGACY_POOL_DEPLOYERS_BY_TICK_SPACING } from "../common/constants/contracts/custom-pool-deployers.js";
import { legacyAlgebraPoolAPIAddress } from "../common/constants/contracts/algebra-pool-api.js";
import { legacyRouterHelperAddress } from "../common/constants/contracts/router-helper.js";
import { legacyRouterV2Address } from "../common/constants/contracts/router-v2.js";
import {
  ALGEBRA_POOL_API_ADDRESS,
  BLACKHOLE_PAIR_API_V2_ADDRESS,
  LEGACY_NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
  NONFUNGIBLE_POSITION_MANAGER_ADDRESS,
  ROUTER_HELPER_ADDRESS,
  ROUTER_V2_ADDRESS,
} from "../constants/contracts.js";
import { publicClient } from "../utils/viemClient.js";
import { getEnvUserAddress } from "../utils/wallet.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

// Static protocol addresses mirrored from SmartContracts/envFiles/mainnet/generated/*.js
export const PROTOCOL_ADDRESSES: Record<string, `0x${string}`> = {
  router: ROUTER_V2_ADDRESS as `0x${string}`,
  router_legacy: legacyRouterV2Address as `0x${string}`,
  router_helper: ROUTER_HELPER_ADDRESS as `0x${string}`,
  router_helper_legacy: legacyRouterHelperAddress as `0x${string}`,
  pair_api: BLACKHOLE_PAIR_API_V2_ADDRESS as `0x${string}`,
  pool_api_cl: ALGEBRA_POOL_API_ADDRESS as `0x${string}`,
  pool_api_cl_legacy: legacyAlgebraPoolAPIAddress as `0x${string}`,
  nfpm: NONFUNGIBLE_POSITION_MANAGER_ADDRESS as `0x${string}`,
  nfpm_legacy: LEGACY_NONFUNGIBLE_POSITION_MANAGER_ADDRESS as `0x${string}`,
  voter: "0xE30D0C8532721551a51a9FeC7FB233759964d9e3",
  voting_escrow: "0xEac562811cc6abDbB2c9EE88719eCA4eE79Ad763",
  pair_factory: "0xfE926062Fb99CA5653080d6C14fE945Ad68c265C",
  algebra_factory: "0x512eb749541B7cf294be882D636218c84a5e9E5F",
  gauge_manager: "0x59aa177312Ff6Bdf39C8Af6F46dAe217bf76CBf6",
  wavax: "0xb31f66aa3c1e785363f0875a1b74e27b85fd66c7",
  black: "0xcd94a87696FAC69Edae3a70fE5725307Ae1c43f6",
  minter: "0xAcc34Ad51457930989fB5050C2Dce6339F06479B",
  ve_nft_api: "0xb3629c89ed9cB172A3FBa66dfdF8C06A85B35dE9",
  bribe_factory: "0xfE842861b9F79Bb77CCb6043731D433D63B365dF",
  gauge_factory_v2: "0x9E95eF7D8b87708641923C48C4eB298ED7CA6552",
  gauge_factory_cl: "0x6B6a3D5A1c536aCE1D761685aF241b2cb7a6eA5E",
  rewards_distributor: "0x7c7BD86BaF240dB3DbCc3f7a22B35c5bAa83bA28",
  epoch_controller: "0xdCA25B5FF3a4BE4B8C4bB9F45edc77Bc0c3Df21e",
};

export const PAIR_FACTORY_GET_FEE_ABI = [
  {
    inputs: [
      { internalType: "address", name: "pair", type: "address" },
      { internalType: "bool", name: "stable", type: "bool" },
    ],
    name: "getFee",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const PAIR_FACTORY_GET_PAIR_ABI = [
  {
    inputs: [
      { internalType: "address", name: "", type: "address" },
      { internalType: "address", name: "", type: "address" },
      { internalType: "bool", name: "", type: "bool" },
    ],
    name: "getPair",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const ALGEBRA_FACTORY_CUSTOM_POOL_ABI = [
  {
    inputs: [
      { internalType: "address", name: "", type: "address" },
      { internalType: "address", name: "", type: "address" },
      { internalType: "address", name: "", type: "address" },
    ],
    name: "customPoolByPair",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const GAUGE_MANAGER_GAUGES_ABI = [
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "gauges",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const GAUGE_MANAGER_POOL_FOR_GAUGE_ABI = [
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "poolForGauge",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const GAUGE_BRIBE_ABI = [
  {
    inputs: [],
    name: "internal_bribe",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "external_bribe",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export type ResolveAddressKind =
  | "user_address"
  | "protocol"
  | "cl_deployer"
  | "cl_deployer_legacy"
  | "pool"
  | "gauge"
  | "pool_from_gauge"
  | "bribe"
  | "list_protocol";

export interface ResolveAddressParams {
  kind: ResolveAddressKind;
  name?: string;
  tickSpacing?: number;
  tokenA?: string;
  tokenB?: string;
  poolType?: "basic_stable" | "basic_volatile" | "cl";
  poolAddress?: string;
  gaugeAddress?: string;
  variant?: "internal" | "external";
}

function sortTokens(a: string, b: string): [`0x${string}`, `0x${string}`] {
  return (a.toLowerCase() < b.toLowerCase() ? [a, b] : [b, a]) as [`0x${string}`, `0x${string}`];
}

export async function handleResolveAddress(params: ResolveAddressParams) {
  const { kind } = params;

  if (kind === "user_address") {
    const address = getEnvUserAddress();
    if (!address) {
      throw new Error(
        "No user address configured. Set PRIVATE_KEY (preferred) or USER_ADDRESS in the MCP server environment.",
      );
    }
    const source = process.env.PRIVATE_KEY ? "PRIVATE_KEY" : "USER_ADDRESS";
    return { success: true, kind, address, source };
  }

  if (kind === "list_protocol") {
    return { success: true, kind, addresses: PROTOCOL_ADDRESSES };
  }

  if (kind === "protocol") {
    if (!params.name) throw new Error("kind='protocol' requires name.");
    const address = PROTOCOL_ADDRESSES[params.name];
    if (!address) {
      throw new Error(
        `Unknown protocol name "${params.name}". Known: ${Object.keys(PROTOCOL_ADDRESSES).join(", ")}.`,
      );
    }
    return { success: true, kind, name: params.name, address };
  }

  if (kind === "cl_deployer") {
    if (params.tickSpacing === undefined) throw new Error("kind='cl_deployer' requires tickSpacing.");
    const address = CUSTOM_POOL_DEPLOYERS_BY_TICK_SPACING[params.tickSpacing];
    if (!address) {
      throw new Error(
        `No deployer for tickSpacing=${params.tickSpacing}. Known: ${Object.keys(CUSTOM_POOL_DEPLOYERS_BY_TICK_SPACING).join(", ")}.`,
      );
    }
    return { success: true, kind, tickSpacing: params.tickSpacing, address };
  }

  if (kind === "cl_deployer_legacy") {
    if (params.tickSpacing === undefined) throw new Error("kind='cl_deployer_legacy' requires tickSpacing.");
    const address = LEGACY_POOL_DEPLOYERS_BY_TICK_SPACING[params.tickSpacing];
    if (!address) {
      throw new Error(
        `No legacy deployer for tickSpacing=${params.tickSpacing}. Known: ${Object.keys(LEGACY_POOL_DEPLOYERS_BY_TICK_SPACING).join(", ")}.`,
      );
    }
    return { success: true, kind, tickSpacing: params.tickSpacing, address };
  }

  if (kind === "pool") {
    if (!params.tokenA || !params.tokenB || !params.poolType) {
      throw new Error("kind='pool' requires tokenA, tokenB, and poolType.");
    }
    if (params.poolType === "basic_stable" || params.poolType === "basic_volatile") {
      const stable = params.poolType === "basic_stable";
      const address = (await publicClient.readContract({
        address: PROTOCOL_ADDRESSES.pair_factory,
        abi: PAIR_FACTORY_GET_PAIR_ABI,
        functionName: "getPair",
        args: [params.tokenA as `0x${string}`, params.tokenB as `0x${string}`, stable],
      })) as `0x${string}`;
      return {
        success: true,
        kind,
        poolType: params.poolType,
        tokenA: params.tokenA,
        tokenB: params.tokenB,
        address,
        exists: address.toLowerCase() !== ZERO_ADDRESS,
      };
    }
    // CL
    if (params.tickSpacing === undefined) {
      throw new Error("kind='pool' with poolType='cl' requires tickSpacing (1/50/100/200).");
    }
    const deployer = CUSTOM_POOL_DEPLOYERS_BY_TICK_SPACING[params.tickSpacing];
    if (!deployer) {
      throw new Error(
        `No deployer for tickSpacing=${params.tickSpacing}. Known: ${Object.keys(CUSTOM_POOL_DEPLOYERS_BY_TICK_SPACING).join(", ")}.`,
      );
    }
    const [token0, token1] = sortTokens(params.tokenA, params.tokenB);
    const address = (await publicClient.readContract({
      address: PROTOCOL_ADDRESSES.algebra_factory,
      abi: ALGEBRA_FACTORY_CUSTOM_POOL_ABI,
      functionName: "customPoolByPair",
      args: [deployer, token0, token1],
    })) as `0x${string}`;
    return {
      success: true,
      kind,
      poolType: "cl",
      tickSpacing: params.tickSpacing,
      deployer,
      token0,
      token1,
      address,
      exists: address.toLowerCase() !== ZERO_ADDRESS,
    };
  }

  if (kind === "gauge") {
    if (!params.poolAddress) throw new Error("kind='gauge' requires poolAddress.");
    const address = (await publicClient.readContract({
      address: PROTOCOL_ADDRESSES.gauge_manager,
      abi: GAUGE_MANAGER_GAUGES_ABI,
      functionName: "gauges",
      args: [params.poolAddress as `0x${string}`],
    })) as `0x${string}`;
    return {
      success: true,
      kind,
      poolAddress: params.poolAddress,
      address,
      exists: address.toLowerCase() !== ZERO_ADDRESS,
    };
  }

  if (kind === "pool_from_gauge") {
    if (!params.gaugeAddress) throw new Error("kind='pool_from_gauge' requires gaugeAddress.");
    const address = (await publicClient.readContract({
      address: PROTOCOL_ADDRESSES.gauge_manager,
      abi: GAUGE_MANAGER_POOL_FOR_GAUGE_ABI,
      functionName: "poolForGauge",
      args: [params.gaugeAddress as `0x${string}`],
    })) as `0x${string}`;
    return {
      success: true,
      kind,
      gaugeAddress: params.gaugeAddress,
      address,
      exists: address.toLowerCase() !== ZERO_ADDRESS,
    };
  }

  if (kind === "bribe") {
    if (!params.poolAddress) throw new Error("kind='bribe' requires poolAddress.");
    const variant = params.variant ?? "external";
    if (variant !== "internal" && variant !== "external") {
      throw new Error("variant must be 'internal' or 'external'.");
    }
    const gauge = (await publicClient.readContract({
      address: PROTOCOL_ADDRESSES.gauge_manager,
      abi: GAUGE_MANAGER_GAUGES_ABI,
      functionName: "gauges",
      args: [params.poolAddress as `0x${string}`],
    })) as `0x${string}`;
    if (gauge.toLowerCase() === ZERO_ADDRESS) {
      return {
        success: true,
        kind,
        poolAddress: params.poolAddress,
        gauge,
        address: ZERO_ADDRESS,
        exists: false,
        note: "Pool has no gauge, so no bribe contracts exist.",
      };
    }
    const address = (await publicClient.readContract({
      address: gauge,
      abi: GAUGE_BRIBE_ABI,
      functionName: variant === "internal" ? "internal_bribe" : "external_bribe",
      args: [],
    })) as `0x${string}`;
    return {
      success: true,
      kind,
      poolAddress: params.poolAddress,
      gauge,
      variant,
      address,
      exists: address.toLowerCase() !== ZERO_ADDRESS,
    };
  }

  throw new Error(`Unknown kind "${kind}".`);
}

export const resolveAddressTool = {
  name: "resolve_address",
  description:
    "Look up protocol/system addresses. Kinds: 'user_address' (the address configured via PRIVATE_KEY or USER_ADDRESS env var — use when the user asks for 'my address', 'my wallet', 'configured address', etc.), 'protocol' (router, voter, pair_api, nfpm, wavax, black, etc. — see 'list_protocol' for full list), 'cl_deployer' (current deployer by tickSpacing 1/10/50/100/200), 'cl_deployer_legacy' (legacy/pre-migration deployer by tickSpacing 1/50/100/200), 'pool' (basic_stable/basic_volatile/cl for tokenA+tokenB, CL requires tickSpacing), 'gauge' (for a pool), 'pool_from_gauge' (reverse lookup via GaugeManager.poolForGauge), and 'bribe' (internal or external bribe for a pool's gauge). Always use this tool instead of guessing addresses.",
  inputSchema: {
    type: "object",
    properties: {
      kind: {
        type: "string",
        enum: ["user_address", "protocol", "cl_deployer", "cl_deployer_legacy", "pool", "gauge", "pool_from_gauge", "bribe", "list_protocol"],
        description: "What to resolve.",
      },
      name: {
        type: "string",
        description:
          "Protocol name for kind='protocol'. One of: router, router_helper, voter, voting_escrow, pair_api, pool_api_cl, pair_factory, algebra_factory, gauge_manager, nfpm, wavax, black, minter, ve_nft_api, bribe_factory, gauge_factory_v2, gauge_factory_cl, rewards_distributor, epoch_controller.",
      },
      tickSpacing: {
        type: "number",
        enum: [1, 50, 100, 200],
        description: "CL tick spacing. Required for kind='cl_deployer' and for kind='pool' with poolType='cl'.",
      },
      tokenA: { type: "string", description: "First token address. Required for kind='pool'." },
      tokenB: { type: "string", description: "Second token address. Required for kind='pool'." },
      poolType: {
        type: "string",
        enum: ["basic_stable", "basic_volatile", "cl"],
        description: "Pool category for kind='pool'.",
      },
      poolAddress: { type: "string", description: "Pool address. Required for kind='gauge' or kind='bribe'." },
      gaugeAddress: { type: "string", description: "Gauge address. Required for kind='pool_from_gauge'." },
      variant: {
        type: "string",
        enum: ["internal", "external"],
        description: "Bribe contract variant for kind='bribe'. Defaults to 'external'.",
      },
    },
    required: ["kind"],
  },
};
