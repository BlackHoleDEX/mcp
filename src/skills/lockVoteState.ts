import { formatUnits, zeroAddress } from "viem";
import { publicClient } from "../utils/viemClient.js";

const VOTING_ESCROW_ADDRESS = "0xEac562811cc6abDbB2c9EE88719eCA4eE79Ad763" as const;
const VOTER_V3_ADDRESS = "0xE30D0C8532721551a51a9FeC7FB233759964d9e3" as const;
const AVM_ADDRESS = "0x3755DF8a937e9505aF7B14D8b13E83f133Ed11c3" as const;
const MINTER_ADDRESS = "0xAcc34Ad51457930989fB5050C2Dce6339F06479B" as const;

const VOTING_ESCROW_ABI = [
  {
    inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    name: "locked",
    outputs: [
      { internalType: "int128", name: "amount", type: "int128" },
      { internalType: "uint256", name: "end", type: "uint256" },
      { internalType: "bool", name: "isPermanent", type: "bool" },
      { internalType: "bool", name: "isSMNFT", type: "bool" },
    ],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
    name: "balanceOfNFT",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    name: "voted",
    outputs: [{ internalType: "bool", name: "", type: "bool" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "_tokenId", type: "uint256" }],
    name: "ownerOf",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "amount", type: "uint256" }],
    name: "calculate_sm_nft_bonus",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const VOTER_V3_ABI = [
  {
    inputs: [],
    name: "EPOCH_DURATION",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    name: "lastVoted",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    name: "lastVotedTimestamp",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    name: "usedWeights",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "tokenId", type: "uint256" }],
    name: "poolVoteLength",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "", type: "uint256" },
      { internalType: "uint256", name: "", type: "uint256" },
    ],
    name: "poolVote",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [
      { internalType: "uint256", name: "", type: "uint256" },
      { internalType: "address", name: "", type: "address" },
    ],
    name: "votes",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const AVM_ABI = [
  {
    inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    name: "originalOwner",
    outputs: [{ internalType: "address", name: "", type: "address" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    name: "tokenIdToAVMId",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const MINTER_ABI = [
  {
    inputs: [],
    name: "active_period",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "WEEK",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export interface LockVoteStateParams {
  tokenId: string | number;
}

export async function handleGetLockVoteState(params: LockVoteStateParams) {
  const tokenIdBig = BigInt(params.tokenId);

  // ── Round 1: all base state in parallel ───────────────────────────────────
  const [
    lockedRaw,
    votingPowerRaw,
    hasActiveVotes,
    ownerAddress,
    lastVotedEpochStart,
    lastVotedTimestamp,
    usedWeightRaw,
    poolVoteLengthRaw,
    activePeriodRaw,
    epochWeekRaw,
    avmOriginalOwner,
    avmIdRaw,
  ] = await Promise.all([
    publicClient.readContract({ address: VOTING_ESCROW_ADDRESS, abi: VOTING_ESCROW_ABI, functionName: "locked", args: [tokenIdBig] }),
    publicClient.readContract({ address: VOTING_ESCROW_ADDRESS, abi: VOTING_ESCROW_ABI, functionName: "balanceOfNFT", args: [tokenIdBig] }),
    publicClient.readContract({ address: VOTING_ESCROW_ADDRESS, abi: VOTING_ESCROW_ABI, functionName: "voted", args: [tokenIdBig] }),
    publicClient.readContract({ address: VOTING_ESCROW_ADDRESS, abi: VOTING_ESCROW_ABI, functionName: "ownerOf", args: [tokenIdBig] }),
    publicClient.readContract({ address: VOTER_V3_ADDRESS, abi: VOTER_V3_ABI, functionName: "lastVoted", args: [tokenIdBig] }),
    publicClient.readContract({ address: VOTER_V3_ADDRESS, abi: VOTER_V3_ABI, functionName: "lastVotedTimestamp", args: [tokenIdBig] }),
    publicClient.readContract({ address: VOTER_V3_ADDRESS, abi: VOTER_V3_ABI, functionName: "usedWeights", args: [tokenIdBig] }),
    publicClient.readContract({ address: VOTER_V3_ADDRESS, abi: VOTER_V3_ABI, functionName: "poolVoteLength", args: [tokenIdBig] }),
    publicClient.readContract({ address: MINTER_ADDRESS, abi: MINTER_ABI, functionName: "active_period" }),
    publicClient.readContract({ address: MINTER_ADDRESS, abi: MINTER_ABI, functionName: "WEEK" }),
    publicClient.readContract({ address: AVM_ADDRESS, abi: AVM_ABI, functionName: "originalOwner", args: [tokenIdBig] }).catch(() => zeroAddress),
    publicClient.readContract({ address: AVM_ADDRESS, abi: AVM_ABI, functionName: "tokenIdToAVMId", args: [tokenIdBig] }).catch(() => 0n),
  ]);

  const [lockedAmount, lockEnd, isPermanent, isSMNFT] = lockedRaw as [bigint, bigint, boolean, boolean];

  const currentEpochStart = activePeriodRaw as bigint;
  const epochDurationSec = epochWeekRaw as bigint;
  const nextEpochStart = currentEpochStart + epochDurationSec;

  const lastVotedEpoch = lastVotedEpochStart as bigint;
  const carryForward = (hasActiveVotes as boolean) &&
    lastVotedEpoch > 0n &&
    lastVotedEpoch < currentEpochStart;

  const autoVoteEnabled =
    (avmOriginalOwner as string).toLowerCase() !== zeroAddress.toLowerCase();

  // ── Round 2: pool addresses in parallel ───────────────────────────────────
  const numPools = Number(poolVoteLengthRaw as bigint);
  let allocations: Array<{
    poolAddress: string;
    voteWeightRaw: string;
    voteWeight: string;
    percentOfUsed: string;
  }> = [];

  if (numPools > 0) {
    const poolAddresses = await Promise.all(
      Array.from({ length: numPools }, (_, i) =>
        publicClient.readContract({
          address: VOTER_V3_ADDRESS,
          abi: VOTER_V3_ABI,
          functionName: "poolVote",
          args: [tokenIdBig, BigInt(i)],
        })
      )
    ) as string[];

    // ── Round 3: vote weights in parallel ─────────────────────────────────
    const voteWeights = await Promise.all(
      poolAddresses.map((poolAddr) =>
        publicClient.readContract({
          address: VOTER_V3_ADDRESS,
          abi: VOTER_V3_ABI,
          functionName: "votes",
          args: [tokenIdBig, poolAddr as `0x${string}`],
        })
      )
    ) as bigint[];

    const usedWeight = usedWeightRaw as bigint;
    allocations = poolAddresses.map((poolAddr, i) => {
      const weight = voteWeights[i];
      const pct = usedWeight > 0n ? (weight * 10000n) / usedWeight : 0n;
      return {
        poolAddress: poolAddr,
        voteWeightRaw: weight.toString(),
        voteWeight: formatUnits(weight, 18),
        percentOfUsed: `${(Number(pct) / 100).toFixed(2)}%`,
      };
    });
  }

  // ── SMNFT bonus (only for superMassive locks) ─────────────────────────────
  let smNFTBonus: string | null = null;
  let smNFTBonusRaw: string | null = null;
  if (isSMNFT) {
    try {
      const absAmount = lockedAmount < 0n ? -lockedAmount : lockedAmount;
      const bonus = await publicClient.readContract({
        address: VOTING_ESCROW_ADDRESS,
        abi: VOTING_ESCROW_ABI,
        functionName: "calculate_sm_nft_bonus",
        args: [absAmount],
      }) as bigint;
      smNFTBonusRaw = bonus.toString();
      smNFTBonus = formatUnits(bonus, 18);
    } catch {
      // non-critical
    }
  }

  // ── Build response ─────────────────────────────────────────────────────────
  const absLockedAmount = lockedAmount < 0n ? -lockedAmount : lockedAmount;
  // isSMNFT locks are permanently locked (SMveNFT) — never expire despite having a lockEnd in contract storage
  const lockType = isPermanent ? "permanent" : isSMNFT ? "smnt_permanent" : "standard";
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const daysUntilExpiry = !isPermanent && !isSMNFT && lockEnd > nowSec
    ? Math.floor(Number(lockEnd - nowSec) / 86400)
    : null;

  return {
    success: true,
    tokenId: String(params.tokenId),
    owner: ownerAddress as string,

    lock: {
      lockedAmount: formatUnits(absLockedAmount, 18),
      lockedAmountRaw: absLockedAmount.toString(),
      expiry: isPermanent ? null : Number(lockEnd),
      expiryFormatted: isPermanent
        ? "permanent"
        : lockEnd > 0n
          ? new Date(Number(lockEnd) * 1000).toISOString()
          : "expired",
      isPermanent,
      isSMNFT,
      lockType,
      daysUntilExpiry,
    },

    votingPower: {
      current: formatUnits(votingPowerRaw as bigint, 18),
      currentRaw: (votingPowerRaw as bigint).toString(),
      smNFTBonus,
      smNFTBonusRaw,
    },

    voteState: {
      hasActiveVotes: hasActiveVotes as boolean,
      carryForward,
      lastVotedEpochStart: lastVotedEpoch.toString(),
      lastVotedEpochStartFormatted: lastVotedEpoch > 0n
        ? new Date(Number(lastVotedEpoch) * 1000).toISOString()
        : null,
      lastVotedTimestamp: Number(lastVotedTimestamp as bigint),
      lastVotedTimestampFormatted: (lastVotedTimestamp as bigint) > 0n
        ? new Date(Number(lastVotedTimestamp as bigint) * 1000).toISOString()
        : null,
      usedWeight: formatUnits(usedWeightRaw as bigint, 18),
      usedWeightRaw: (usedWeightRaw as bigint).toString(),
      currentEpochStart: currentEpochStart.toString(),
      currentEpochStartFormatted: new Date(Number(currentEpochStart) * 1000).toISOString(),
      nextEpochStart: nextEpochStart.toString(),
      nextEpochStartFormatted: new Date(Number(nextEpochStart) * 1000).toISOString(),
      epochDurationSeconds: Number(epochDurationSec),
    },

    allocations,

    autoVote: {
      enabled: autoVoteEnabled,
      avmId: autoVoteEnabled ? (avmIdRaw as bigint).toString() : null,
      originalOwner: autoVoteEnabled ? (avmOriginalOwner as string) : null,
    },
  };
}

export const getLockVoteStateTool = {
  name: "get_lock_vote_state",
  description:
    "Returns the complete state of a veNFT lock: locked amount, expiry, lock type (standard / superMassive / permanent), days until expiry, current voting power (including SMNFT boost), active pool allocations with percentages, carry-forward status, last-voted epoch timestamps, and auto-vote status. Use this whenever you need to inspect where a lock is currently voted, how much power it has, or whether its votes are carrying forward from a previous epoch.",
  inputSchema: {
    type: "object",
    properties: {
      tokenId: {
        type: "string",
        description: "The veNFT token ID to query.",
      },
    },
    required: ["tokenId"],
  },
};
