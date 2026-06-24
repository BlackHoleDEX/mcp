import { NONFUNGIBLE_POSITION_MANAGER_ABI } from "../constants/contracts.js";
import { resolveDeployer } from "../utils/customPoolDeployer.js";
import { getNFPMForDeployer } from "../utils/legacyContracts.js";
import { getEnvUserAddress } from "../utils/wallet.js";

type ClaimFeesMode = "v2" | "cl";

const PAIR_ABI = [
  {
    inputs: [],
    name: "claimFees",
    outputs: [
      { internalType: "uint256", name: "claimed0", type: "uint256" },
      { internalType: "uint256", name: "claimed1", type: "uint256" },
    ],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

const MAX_UINT128 = "340282366920938463463374607431768211455";

export interface ClaimFeesParams {
  mode: ClaimFeesMode;
  userAddress?: string;
  // v2
  pairAddress?: string;
  // cl
  tokenId?: number;
  deployer?: string;
  poolAddress?: string;
  collectTo?: string;
}

export async function handleClaimFeesSteps(params: ClaimFeesParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");
  const { mode } = params;

  if (mode === "v2") {
    if (!params.pairAddress) {
      throw new Error("For mode='v2' provide pairAddress.");
    }

    return {
      success: true,
      message: "Computed V2 claim-fees transaction steps.",
      steps: [
        {
          title: "Execute claimFees",
          description: "Claim accrued swap fees from the V2 pair.",
          payload: {
            to: params.pairAddress,
            abi: PAIR_ABI,
            functionName: "claimFees",
            args: [],
            value: "0",
          },
        },
      ],
    };
  }

  if (params.tokenId === undefined) {
    throw new Error("For mode='cl' provide tokenId.");
  }
  const recipient = (params.collectTo ?? userAddress) as `0x${string}`;
  const deployer = await resolveDeployer(params.deployer, params.poolAddress);
  const nfpmAddress = getNFPMForDeployer(deployer);

  return {
    success: true,
    message: "Computed CL claim-fees transaction steps.",
    steps: [
      {
        title: "Execute collect",
        description: "Collect accrued fees from the CL position NFT.",
        payload: {
          to: nfpmAddress,
          abi: NONFUNGIBLE_POSITION_MANAGER_ABI,
          functionName: "collect",
          args: [
            {
              tokenId: BigInt(params.tokenId),
              recipient,
              amount0Max: BigInt(MAX_UINT128),
              amount1Max: BigInt(MAX_UINT128),
            },
          ],
          value: "0",
        },
      },
    ],
  };
}

export const claimFeesTool = {
  name: "claim_fees_steps",
  description: "Returns claim-fees transaction steps for v2 pairs or CL positions.",
  inputSchema: {
    type: "object",
    properties: {
      mode: { type: "string", enum: ["v2", "cl"], description: "Choose claim mode: v2 pair or concentrated liquidity position." },
      pairAddress: { type: "string", description: "V2 pair address (required for mode='v2')." },
      tokenId: { type: "number", description: "CL position NFT tokenId (required for mode='cl')." },
      deployer: { type: "string", description: "Pool deployer address (mode='cl'). Pass when known (from get_user_positions) to target the correct NFPM." },
      poolAddress: { type: "string", description: "Pool address (mode='cl'). Used to resolve deployer when deployer is not provided." },
      collectTo: { type: "string", description: "Optional CL fee recipient override (mode='cl'). Defaults to userAddress." },
      userAddress: { type: "string", description: "Optional. Recipient address for claimed tokens. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
    },
    required: ["mode"],
  },
};
