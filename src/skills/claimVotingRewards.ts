import { BLACKHOLE_PAIR_ABI, BLACKHOLE_PAIR_API_V2_ADDRESS } from "../constants/contracts.js";
import { publicClient } from "../utils/viemClient.js";
import { getEnvUserAddress } from "../utils/wallet.js";

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

export interface ClaimVotingRewardsParams {
  userAddress?: string;
  tokenId: number;
  bribeAddresses: string[];
  bribeRewardTokens: string[][];
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

export async function handleClaimVotingRewardsSteps(params: ClaimVotingRewardsParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const { tokenId, bribeAddresses, bribeRewardTokens, gaugeManagerAddress } = params;

  if (!Array.isArray(bribeAddresses) || bribeAddresses.length === 0) {
    throw new Error("Provide at least one bribe address in bribeAddresses.");
  }
  if (!Array.isArray(bribeRewardTokens) || bribeRewardTokens.length !== bribeAddresses.length) {
    throw new Error("bribeRewardTokens must be provided and match bribeAddresses length.");
  }

  const resolvedGaugeManager = await resolveGaugeManagerAddress(gaugeManagerAddress);

  return {
    success: true,
    message: "Computed voting-rewards claim transaction steps.",
    steps: [
      {
        title: "Execute claimBribes",
        description: "Claim voting rewards from bribe contracts for the provided veNFT tokenId.",
        payload: {
          to: resolvedGaugeManager,
          abi: GAUGE_MANAGER_CLAIM_BRIBES_ABI,
          functionName: "claimBribes",
          args: [bribeAddresses, bribeRewardTokens, BigInt(tokenId)],
          value: "0",
        },
      },
    ],
  };
}

export const claimVotingRewardsTool = {
  name: "claim_voting_rewards_steps",
  description: "Returns claimBribes transaction steps for veNFT voting rewards.",
  inputSchema: {
    type: "object",
    properties: {
      userAddress: { type: "string", description: "Optional. User wallet address context. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      tokenId: { type: "number", description: "veNFT lock tokenId used to claim voting rewards." },
      bribeAddresses: { type: "array", items: { type: "string" }, description: "Bribe contract addresses to claim from." },
      bribeRewardTokens: { type: "array", items: { type: "array", items: { type: "string" } }, description: "Reward token addresses per bribe (same order as bribeAddresses)." },
      gaugeManagerAddress: { type: "string", description: "Optional gauge manager override. Defaults to pair API gaugeManager()." },
    },
    required: ["tokenId", "bribeAddresses", "bribeRewardTokens"],
  },
};
