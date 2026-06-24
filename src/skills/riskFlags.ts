import { SERVER_CONFIG } from "../config.js";
import { publicClient } from "../utils/viemClient.js";
import { getEnvUserAddress } from "../utils/wallet.js";

const ZERO_ADDRESS = "0x0000000000000000000000000000000000000000";
const DAYS_30 = 30;
const DAYS_7 = 7;

const VE_NFT_API_ADDRESS = "0xb3629c89ed9cB172A3FBa66dfdF8C06A85B35dE9";

const VE_NFT_API_ABI = [
  {
    inputs: [{ internalType: "address", name: "_user", type: "address" }],
    name: "getNFTFromAddress",
    outputs: [
      {
        components: [
          { name: "decimals", type: "uint8" },
          { name: "voted", type: "bool" },
          { name: "hasVotedForEpoch", type: "bool" },
          { name: "attachments", type: "uint256" },
          { name: "id", type: "uint256" },
          { name: "amount", type: "uint128" },
          { name: "voting_amount", type: "uint256" },
          { name: "rebase_amount", type: "uint256" },
          { name: "lockEnd", type: "uint256" },
          { name: "vote_ts", type: "uint256" },
          {
            components: [
              { name: "pair", type: "address" },
              { name: "weight", type: "uint256" },
            ],
            name: "votes",
            type: "tuple[]",
          },
          { name: "account", type: "address" },
          { name: "isSMNFT", type: "bool" },
          { name: "isPermanent", type: "bool" },
          { name: "token", type: "address" },
          { name: "tokenSymbol", type: "string" },
          { name: "tokenDecimals", type: "uint256" },
        ],
        internalType: "struct veNFTAPI.veNFT[]",
        name: "venft",
        type: "tuple[]",
      },
    ],
    stateMutability: "view",
    type: "function",
  },
] as const;

type Priority = "high" | "medium" | "low";

interface Opportunity {
  priority: Priority;
  type:
    | "expiring_lock"
    | "expired_lock"
    | "oor_position"
    | "unvoted_lock"
    | "vote_review"
    | "rebase_unclaimed";
  tokenId?: number;
  positionId?: number;
  poolAddress?: string;
  message: string;
  action?: string;
}

async function checkLockOpportunities(userAddress: string): Promise<Opportunity[]> {
  const items: Opportunity[] = [];
  const now = Math.floor(Date.now() / 1000);

  let nfts: any[] = [];
  try {
    nfts = (await publicClient.readContract({
      address: VE_NFT_API_ADDRESS as `0x${string}`,
      abi: VE_NFT_API_ABI,
      functionName: "getNFTFromAddress",
      args: [userAddress as `0x${string}`],
    })) as any[];
  } catch {
    return items;
  }

  for (const nft of nfts) {
    const tokenId = Number(nft.id ?? 0);
    const isPermanent = Boolean(nft.isPermanent);
    const lockEnd = Number(nft.lockEnd ?? 0);
    const voted = Boolean(nft.voted);
    const hasVotedForEpoch = Boolean(nft.hasVotedForEpoch);
    const decimals = Number(nft.decimals ?? 18);
    const rebaseAmount = Number(BigInt(nft.rebase_amount ?? 0n)) / 10 ** decimals;

    // Expired lock — can withdraw or re-lock
    if (!isPermanent && lockEnd > 0 && lockEnd <= now) {
      items.push({
        priority: "high",
        type: "expired_lock",
        tokenId,
        message: `veNFT #${tokenId} lock expired ${new Date(lockEnd * 1000).toISOString().split("T")[0]} — tokens are withdrawable.`,
        action: "Withdraw via lock_advanced_steps or re-lock to regain voting power.",
      });
      continue; // no point checking other conditions on an expired lock
    }

    // Expiring soon
    if (!isPermanent && lockEnd > now) {
      const daysLeft = Math.ceil((lockEnd - now) / 86400);
      if (daysLeft <= DAYS_30) {
        items.push({
          priority: daysLeft <= DAYS_7 ? "high" : "medium",
          type: "expiring_lock",
          tokenId,
          message: `veNFT #${tokenId} expires in ${daysLeft} day${daysLeft !== 1 ? "s" : ""} (${new Date(lockEnd * 1000).toISOString().split("T")[0]}).`,
          action: "Extend via increase_lock_steps or convert to permanent to maintain full voting power.",
        });
      }
    }

    // Votes carrying forward — suggest review in case they want to rebalance
    if (voted && !hasVotedForEpoch) {
      items.push({
        priority: "low",
        type: "vote_review",
        tokenId,
        message: `veNFT #${tokenId} votes are carrying forward from a previous epoch.`,
        action: "Votes persist automatically, but if you want to update your pool allocations this epoch, use vote_steps.",
      });
    }

    // Lock with no votes at all — earning nothing
    if (!voted) {
      items.push({
        priority: "high",
        type: "unvoted_lock",
        tokenId,
        message: `veNFT #${tokenId} has never voted — earning no gauge fees or bribes.`,
        action: "Allocate votes via vote_steps to start earning rewards each epoch.",
      });
    }

    // Unclaimed rebase
    if (rebaseAmount > 0.001) {
      items.push({
        priority: "low",
        type: "rebase_unclaimed",
        tokenId,
        message: `veNFT #${tokenId} has ${rebaseAmount.toFixed(4)} claimable rebase tokens.`,
        action: "Claim via claim_voting_rewards_steps to compound your voting power.",
      });
    }
  }

  return items;
}

async function checkCLPositionOpportunities(userAddress: string): Promise<Opportunity[]> {
  const items: Opportunity[] = [];
  const ownerLower = userAddress.toLowerCase();

  try {
    const res = await fetch(SERVER_CONFIG.CL_GRAPH_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        query: `{
          positions(first: 100, where: { owner: "${ownerLower}", liquidity_gt: "0" }) {
            id
            tickLower { tickIdx }
            tickUpper { tickIdx }
            pool {
              id
              tick
              token0 { symbol }
              token1 { symbol }
            }
          }
        }`,
      }),
    });
    const json = (await res.json()) as { data?: { positions?: any[] } };
    const rows = json?.data?.positions ?? [];

    for (const pos of rows) {
      const pool = pos.pool;
      if (!pool) continue;
      const tickLower = Number(pos.tickLower?.tickIdx ?? 0);
      const tickUpper = Number(pos.tickUpper?.tickIdx ?? 0);
      const tickCurrent = Number(pool.tick ?? 0);
      const inRange = tickCurrent >= tickLower && tickCurrent < tickUpper;

      if (!inRange) {
        const symbol = `${pool.token0?.symbol ?? "?"}/${pool.token1?.symbol ?? "?"}`;
        items.push({
          priority: "medium",
          type: "oor_position",
          positionId: Number(pos.id),
          poolAddress: pool.id,
          message: `CL position #${pos.id} (${symbol}) is out of range — earning no fees.`,
          action: `Current tick ${tickCurrent} is outside [${tickLower}, ${tickUpper}). Rebalance via zap_remove_liquidity_steps + zap_mint_cl_steps.`,
        });
      }
    }
  } catch {}

  return items;
}

export interface GetOpportunitiesParams {
  userAddress?: string;
}

export async function handleGetOpportunities(params: GetOpportunitiesParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");

  const [lockItems, clItems] = await Promise.all([
    checkLockOpportunities(userAddress),
    checkCLPositionOpportunities(userAddress),
  ]);

  const items: Opportunity[] = [...lockItems, ...clItems];

  // Sort by priority: high → medium → low
  const order: Record<Priority, number> = { high: 0, medium: 1, low: 2 };
  items.sort((a, b) => order[a.priority] - order[b.priority]);

  const highCount = items.filter((f) => f.priority === "high").length;
  const medCount = items.filter((f) => f.priority === "medium").length;
  const lowCount = items.filter((f) => f.priority === "low").length;

  const summary =
    items.length === 0
      ? "Everything looks good — no missed opportunities detected."
      : `${highCount} urgent, ${medCount} medium, ${lowCount} low-priority items.`;

  return {
    success: true,
    message: summary,
    count: items.length,
    opportunities: items,
  };
}

export const getOpportunitiesTool = {
  name: "get_opportunities",
  description:
    "Scans a wallet for actionable items: expiring or expired veNFT locks (loss of voting power and rewards), unvoted locks (earning nothing), out-of-range CL positions (earning zero fees), and unclaimed rebase tokens. Note: votes carry forward automatically each epoch — there is no need to re-vote unless changing allocations. Run this proactively before any epoch-related action.",
  inputSchema: {
    type: "object",
    properties: {
      userAddress: {
        type: "string",
        description: "Optional. Wallet address to scan. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var.",
      },
    },
    required: [],
  },
};
