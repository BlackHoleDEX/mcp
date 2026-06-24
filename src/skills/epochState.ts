import { publicClient } from "../utils/viemClient.js";

const MINTER_ADDRESS = "0xAcc34Ad51457930989fB5050C2Dce6339F06479B" as const;

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
    name: "epochCount",
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
  {
    inputs: [],
    name: "weekly",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

export async function handleGetEpochState() {
  const [activePeriodRaw, epochCountRaw, weekRaw, weeklyRaw] = (await Promise.all([
    publicClient.readContract({ address: MINTER_ADDRESS, abi: MINTER_ABI, functionName: "active_period" }),
    publicClient.readContract({ address: MINTER_ADDRESS, abi: MINTER_ABI, functionName: "epochCount" }),
    publicClient.readContract({ address: MINTER_ADDRESS, abi: MINTER_ABI, functionName: "WEEK" }),
    publicClient.readContract({ address: MINTER_ADDRESS, abi: MINTER_ABI, functionName: "weekly" }),
  ])) as [bigint, bigint, bigint, bigint];

  const epochStart = Number(activePeriodRaw);
  const epochDurationSec = Number(weekRaw);
  const epochEnd = epochStart + epochDurationSec;
  const nowSec = Math.floor(Date.now() / 1000);
  const secondsRemaining = Math.max(0, epochEnd - nowSec);
  const hoursRemaining = Math.floor(secondsRemaining / 3600);
  const minutesRemaining = Math.floor((secondsRemaining % 3600) / 60);

  // weeklyRaw is in 18-decimal token units (BLACK emissions scheduled for this epoch)
  const weeklyEmissions = Number(weeklyRaw) / 1e18;

  return {
    success: true,
    epochNumber: Number(epochCountRaw),
    epochStart: new Date(epochStart * 1000).toISOString(),
    epochEnd: new Date(epochEnd * 1000).toISOString(),
    epochDurationSeconds: epochDurationSec,
    nowUtc: new Date(nowSec * 1000).toISOString(),
    secondsRemaining,
    timeRemaining: `${hoursRemaining}h ${minutesRemaining}m`,
    isWithinEpoch: nowSec >= epochStart && nowSec < epochEnd,
    scheduledWeeklyEmissions: weeklyEmissions.toFixed(4),
  };
}

export const getEpochStateTool = {
  name: "get_epoch_state",
  description:
    "Returns the current epoch timing state from the Blackhole minter: epoch number, start/end timestamps, time remaining, and scheduled BLACK emissions for this epoch. Use this to determine where in the vote cycle you are before placing or adjusting votes.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};
