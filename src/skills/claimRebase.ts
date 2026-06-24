import { getEnvUserAddress } from "../utils/wallet.js";

const REWARDS_DISTRIBUTOR_ADDRESS = "0x7c7BD86BaF240dB3DbCc3f7a22B35c5bAa83bA28";

const REWARDS_DISTRIBUTOR_ABI = [
  {
    inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
    name: "claim",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "nonpayable",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256[]", name: "_tokenIds", type: "uint256[]" }],
    name: "claim_many",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

export interface ClaimRebaseParams {
  tokenIds: number[];
  userAddress?: string;
}

export async function handleClaimRebaseSteps(params: ClaimRebaseParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const { tokenIds } = params;

  if (!tokenIds || tokenIds.length === 0) {
    throw new Error("Provide at least one tokenId.");
  }

  if (tokenIds.length === 1) {
    return {
      success: true,
      message: "Computed rebase claim transaction step.",
      steps: [
        {
          title: "Claim Rebase",
          description: `Claim rebase (anti-dilution) rewards for veNFT #${tokenIds[0]} from RewardsDistributor.`,
          payload: {
            to: REWARDS_DISTRIBUTOR_ADDRESS,
            abi: REWARDS_DISTRIBUTOR_ABI,
            functionName: "claim",
            args: [BigInt(tokenIds[0]!)],
            value: "0",
          },
        },
      ],
    };
  }

  return {
    success: true,
    message: `Computed rebase claim transaction step for ${tokenIds.length} veNFTs.`,
    steps: [
      {
        title: "Claim Rebase (batch)",
        description: `Claim rebase (anti-dilution) rewards for veNFTs ${tokenIds.join(", ")} from RewardsDistributor.`,
        payload: {
          to: REWARDS_DISTRIBUTOR_ADDRESS,
          abi: REWARDS_DISTRIBUTOR_ABI,
          functionName: "claim_many",
          args: [tokenIds.map((id) => BigInt(id))],
          value: "0",
        },
      },
    ],
  };
}

export const claimRebaseTool = {
  name: "claim_rebase_steps",
  description:
    "Returns transaction steps to claim rebase (anti-dilution) rewards for one or more veNFT locks from the RewardsDistributor. " +
    "Rebase rewards accumulate each epoch proportional to voting power and compensate veBLACK holders for token inflation. " +
    "Use get_user_locks to find tokenIds with non-zero rebaseClaimable before calling this.",
  inputSchema: {
    type: "object",
    properties: {
      tokenIds: {
        type: "array",
        items: { type: "number" },
        description: "One or more veNFT tokenIds to claim rebase for. Single tokenId calls claim(); multiple calls claim_many().",
      },
      userAddress: {
        type: "string",
        description: "Optional. User wallet address. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var.",
      },
    },
    required: ["tokenIds"],
  },
};
