import { BLACKHOLE_PAIR_ABI, BLACKHOLE_PAIR_API_V2_ADDRESS } from "../constants/contracts.js";
import { publicClient } from "../utils/viemClient.js";
import { getEnvUserAddress } from "../utils/wallet.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";

const VE_NFT_API_ABI = [
  {
    inputs: [
      { internalType: "address", name: "_user", type: "address" },
      { internalType: "uint256", name: "_lockBatchSize", type: "uint256" },
      { internalType: "uint256", name: "_lockOffset", type: "uint256" },
      { internalType: "uint256", name: "_gaugeBatchSize", type: "uint256" },
      { internalType: "uint256", name: "_gaugeOffset", type: "uint256" },
    ],
    name: "getAllPairRewards",
    outputs: [
      {
        components: [
          { internalType: "uint256", name: "id", type: "uint256" },
          { internalType: "uint128", name: "lockedAmount", type: "uint128" },
          {
            components: [
              { internalType: "address", name: "pair", type: "address" },
              {
                components: [
                  { internalType: "uint256", name: "id", type: "uint256" },
                  { internalType: "uint256", name: "amount", type: "uint256" },
                  { internalType: "uint8", name: "decimals", type: "uint8" },
                  { internalType: "address", name: "pair", type: "address" },
                  { internalType: "address", name: "token", type: "address" },
                  { internalType: "address", name: "bribe", type: "address" },
                  { internalType: "string", name: "symbol", type: "string" },
                ],
                internalType: "struct veNFTAPI.Reward[]",
                name: "votingRewards",
                type: "tuple[]",
              },
            ],
            internalType: "struct veNFTAPI.PairReward[]",
            name: "pairRewards",
            type: "tuple[]",
          },
        ],
        internalType: "struct veNFTAPI.LockReward[]",
        name: "_lockReward",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

const GAUGE_MANAGER_CLAIM_BRIBES_ABI = [
  {
    inputs: [
      { internalType: "address[]", name: "_bribes", type: "address[]" },
      { internalType: "address[][]", name: "_tokens", type: "address[][]" },
      { internalType: "uint256", name: "_tokenId", type: "uint256" },
    ],
    name: "claimBribes",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

function getVeNftApiAddress(): `0x${string}` {
  return "0xb3629c89ed9cB172A3FBa66dfdF8C06A85B35dE9";
}

function getNested<T = any>(value: any, key: string, index: number): T | undefined {
  return (value?.[key] ?? value?.[index]) as T | undefined;
}

export interface ClaimVotingRewardsPayloadParams {
  userAddress?: string;
  tokenId: number;
  lockBatchSize?: number;
  lockOffset?: number;
  gaugeBatchSize?: number;
  gaugeOffset?: number;
  includeZeroAmounts?: boolean;
  gaugeManagerAddress?: string;
}

async function resolveGaugeManagerAddress(override?: string) {
  if (override) return override as `0x${string}`;
  return (await publicClient.readContract({
    address: BLACKHOLE_PAIR_API_V2_ADDRESS as `0x${string}`,
    abi: BLACKHOLE_PAIR_ABI,
    functionName: "gaugeManager",
    args: [],
  })) as `0x${string}`;
}

export async function handleClaimVotingRewardsPayload(params: ClaimVotingRewardsPayloadParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const {
    tokenId,
    lockBatchSize = 50,
    lockOffset = 0,
    gaugeBatchSize = 300,
    gaugeOffset = 0,
    includeZeroAmounts = false,
    gaugeManagerAddress,
  } = params;

  const veNftApiAddress = getVeNftApiAddress();
  const rewardsResult = (await publicClient.readContract({
    address: veNftApiAddress,
    abi: VE_NFT_API_ABI,
    functionName: "getAllPairRewards",
    args: [
      userAddress as `0x${string}`,
      BigInt(lockBatchSize),
      BigInt(lockOffset),
      BigInt(gaugeBatchSize),
      BigInt(gaugeOffset),
    ],
  })) as any;

  const lockRewards = Array.isArray(rewardsResult)
    ? rewardsResult
    : (getNested<any[]>(rewardsResult, "_lockReward", 0) ?? []);

  const targetLock = lockRewards.find((lockReward: any) => {
    const id = getNested<bigint>(lockReward, "id", 0);
    return id !== undefined && BigInt(id) === BigInt(tokenId);
  });

  if (!targetLock) {
    throw new Error("No lock reward entry found for tokenId in current veNFTAPI page.");
  }

  const pairRewards = getNested<any[]>(targetLock, "pairRewards", 2) ?? [];
  const bribeToTokens = new Map<string, Set<string>>();

  for (const pairReward of pairRewards) {
    const votingRewards = getNested<any[]>(pairReward, "votingRewards", 1) ?? [];
    for (const reward of votingRewards) {
      const token = getNested<string>(reward, "token", 4);
      const bribe = getNested<string>(reward, "bribe", 5);
      const amount = getNested<bigint>(reward, "amount", 1) ?? 0n;

      if (!token || !bribe) continue;
      if (bribe.toLowerCase() === ZERO_ADDRESS || token.toLowerCase() === ZERO_ADDRESS) continue;
      if (!includeZeroAmounts && BigInt(amount) === 0n) continue;

      const key = bribe.toLowerCase();
      const existing = bribeToTokens.get(key) ?? new Set<string>();
      existing.add(token);
      bribeToTokens.set(key, existing);
    }
  }

  const bribeAddresses = Array.from(bribeToTokens.keys()) as `0x${string}`[];
  const bribeRewardTokens = bribeAddresses.map((bribe) => Array.from(bribeToTokens.get(bribe) ?? []));

  if (bribeAddresses.length === 0) {
    throw new Error("No claimable voting rewards found for tokenId from veNFTAPI response.");
  }

  const resolvedGaugeManager = await resolveGaugeManagerAddress(gaugeManagerAddress);
  const payload = {
    to: resolvedGaugeManager,
    abi: GAUGE_MANAGER_CLAIM_BRIBES_ABI,
    functionName: "claimBribes",
    args: [bribeAddresses, bribeRewardTokens, BigInt(tokenId)],
    value: "0",
  };

  return {
    success: true,
    message: "Computed claimBribes payload from veNFTAPI rewards.",
    source: {
      veNftApiAddress,
      veNftApiCall: {
        functionName: "getAllPairRewards",
        args: [userAddress, lockBatchSize, lockOffset, gaugeBatchSize, gaugeOffset],
      },
    },
    derived: {
      bribeAddresses,
      bribeRewardTokens,
    },
    payload,
    steps: [
      {
        title: "Execute claimBribes",
        description: "Claim voting rewards using payload derived from veNFTAPI lock rewards.",
        payload,
      },
    ],
  };
}

export const claimVotingRewardsPayloadTool = {
  name: "claim_voting_rewards_payload",
  description: "Fetches voting rewards from veNFTAPI and returns a ready claimBribes payload for agents to execute.",
  inputSchema: {
    type: "object",
    properties: {
      userAddress: { type: "string", description: "Optional. User wallet address used to query veNFTAPI rewards. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      tokenId: { type: "number", description: "veNFT lock tokenId to build claim payload for." },
      lockBatchSize: { type: "number", description: "Optional lock page size for veNFTAPI.getAllPairRewards (default 50)." },
      lockOffset: { type: "number", description: "Optional lock offset for veNFTAPI.getAllPairRewards (default 0)." },
      gaugeBatchSize: { type: "number", description: "Optional gauge page size for veNFTAPI.getAllPairRewards (default 300)." },
      gaugeOffset: { type: "number", description: "Optional gauge offset for veNFTAPI.getAllPairRewards (default 0)." },
      includeZeroAmounts: { type: "boolean", description: "Include zero-amount rewards while deriving payload (default false)." },
      gaugeManagerAddress: { type: "string", description: "Optional gauge manager override. Defaults to pair API gaugeManager()." },
    },
    required: ["tokenId"],
  },
};
