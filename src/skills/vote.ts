import { getEnvUserAddress } from "../utils/wallet.js";

type VoteAction = "vote" | "reset" | "poke";

const VOTER_V3_ABI = [
  {
    inputs: [
      { internalType: "uint256", name: "_tokenId", type: "uint256" },
      { internalType: "address[]", name: "_poolVote", type: "address[]" },
      { internalType: "uint256[]", name: "_weights", type: "uint256[]" },
    ],
    name: "vote",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
    name: "reset",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
    name: "poke",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

function getVoterV3Address(): `0x${string}` {
  return "0xE30D0C8532721551a51a9FeC7FB233759964d9e3";
}

export interface VoteStepsParams {
  action: VoteAction;
  userAddress?: string;
  tokenId: number;
  poolAddresses?: string[];
  poolWeights?: Array<string | number>;
}

export async function handleVoteSteps(params: VoteStepsParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const voterV3Address = getVoterV3Address();
  const { action, tokenId } = params;

  if (action === "vote") {
    const pools = params.poolAddresses ?? [];
    const weights = params.poolWeights ?? [];
    if (pools.length === 0) {
      throw new Error("For action='vote' provide poolAddresses.");
    }
    if (pools.length !== weights.length) {
      throw new Error("poolAddresses and poolWeights must have the same length.");
    }

    const normalizedWeights = weights.map((weight) => BigInt(weight));

    return {
      success: true,
      message: "Computed vote transaction steps.",
      steps: [
        {
          title: "Execute vote",
          description: "Cast veNFT votes across selected pools with provided weights.",
          payload: {
            to: voterV3Address,
            abi: VOTER_V3_ABI,
            functionName: "vote",
            args: [BigInt(tokenId), pools, normalizedWeights],
            value: "0",
          },
        },
      ],
    };
  }

  if (action === "reset") {
    return {
      success: true,
      message: "Computed reset-votes transaction steps.",
      steps: [
        {
          title: "Execute reset",
          description: "Clear all votes for the provided veNFT tokenId.",
          payload: {
            to: voterV3Address,
            abi: VOTER_V3_ABI,
            functionName: "reset",
            args: [BigInt(tokenId)],
            value: "0",
          },
        },
      ],
    };
  }

  return {
    success: true,
    message: "Computed poke-votes transaction steps.",
    steps: [
      {
        title: "Execute poke",
        description: "Refresh current vote weights for the provided veNFT tokenId.",
        payload: {
          to: voterV3Address,
          abi: VOTER_V3_ABI,
          functionName: "poke",
          args: [BigInt(tokenId)],
          value: "0",
        },
      },
    ],
  };
}

export const voteTool = {
  name: "vote_steps",
  description: "Returns voterV3 voting transaction steps for veNFT voting actions.",
  inputSchema: {
    type: "object",
    properties: {
      action: { type: "string", enum: ["vote", "reset", "poke"], description: "Voting action to execute on voterV3." },
      userAddress: { type: "string", description: "Optional. User wallet address (context for voting operations). Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      tokenId: { type: "number", description: "veNFT lock tokenId used for vote/reset/poke." },
      poolAddresses: { type: "array", items: { type: "string" }, description: "Pool addresses for action='vote'." },
      poolWeights: { type: "array", items: { type: ["string", "number"] }, description: "Raw weight values for action='vote' (same order as poolAddresses)." },
    },
    required: ["action", "tokenId"],
  },
};
