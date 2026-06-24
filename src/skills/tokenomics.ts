import { publicClient } from "../utils/viemClient.js";

const MINTER_ADDRESS = "0xAcc34Ad51457930989fB5050C2Dce6339F06479B" as const;
const BLACK_ADDRESS = "0xcd94a87696FAC69Edae3a70fE5725307Ae1c43f6" as const;
const VE_ADDRESS = "0xEac562811cc6abDbB2c9EE88719eCA4eE79Ad763" as const;
const BLACK_ADDRESS_LOWER = BLACK_ADDRESS.toLowerCase();

const MINTER_ABI = [
  {
    inputs: [],
    name: "circulating_supply",
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
  {
    inputs: [],
    name: "epochCount",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
  {
    inputs: [],
    name: "tailEmissionRate",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const BLACK_ABI = [
  {
    inputs: [],
    name: "totalSupply",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const BLACK_BALANCE_ABI = [
  {
    inputs: [{ internalType: "address", name: "", type: "address" }],
    name: "balanceOf",
    outputs: [{ internalType: "uint256", name: "", type: "uint256" }],
    stateMutability: "view",
    type: "function",
  },
] as const;

const TAIL_START = 67n;
const WEEKLY_GROWTH = 10_300n; // +3% per epoch (epochs 1–14)
const WEEKLY_DECAY = 9_900n;   // -1% per epoch (epochs 15–66)
const MAX_BPS = 10_000n;

async function fetchBlackPrice(): Promise<number> {
  try {
    const res = await fetch("https://resources.blackhole.xyz/token-details.json");
    const data = (await res.json()) as Record<string, any>;
    for (const [key, token] of Object.entries(data ?? {})) {
      const addr = ((token as any)?.address ?? key).toLowerCase();
      if (addr === BLACK_ADDRESS_LOWER) {
        return Number((token as any)?.usd_pricing ?? 0);
      }
    }
  } catch {}
  return 0;
}

// Projects future epoch emissions starting from the stored `weekly` value.
// `weekly` on-chain is what will be emitted on the next update_period() call (epoch currentEpoch+1).
function projectEmissionsSchedule(
  startWeekly: bigint,
  currentEpoch: bigint,
  tailRate: bigint,
  numEpochs: number
): Array<{ epoch: number; emissionsBLACK: string }> {
  const schedule: Array<{ epoch: number; emissionsBLACK: string }> = [];
  let weekly = startWeekly;
  let epoch = currentEpoch;

  for (let i = 0; i < numEpochs; i++) {
    const emission = weekly;
    epoch += 1n;

    // Mirror update_period() adjustment logic
    if (epoch > TAIL_START) {
      weekly = (weekly * tailRate) / MAX_BPS;
    } else if (epoch < 15n) {
      weekly = (weekly * WEEKLY_GROWTH) / MAX_BPS;
    } else {
      weekly = (weekly * WEEKLY_DECAY) / MAX_BPS;
    }

    schedule.push({
      epoch: Number(epoch),
      emissionsBLACK: Math.round(Number(emission) / 1e18).toLocaleString("en-US"),
    });
  }

  return schedule;
}

export async function handleGetTokenomics() {
  const [totalSupplyRaw, circulatingRaw, weeklyRaw, epochCountRaw, tailRateRaw, veSupplyRaw, blackPrice] =
    (await Promise.all([
      publicClient.readContract({ address: BLACK_ADDRESS, abi: BLACK_ABI, functionName: "totalSupply" }),
      publicClient.readContract({ address: MINTER_ADDRESS, abi: MINTER_ABI, functionName: "circulating_supply" }),
      publicClient.readContract({ address: MINTER_ADDRESS, abi: MINTER_ABI, functionName: "weekly" }),
      publicClient.readContract({ address: MINTER_ADDRESS, abi: MINTER_ABI, functionName: "epochCount" }),
      publicClient.readContract({ address: MINTER_ADDRESS, abi: MINTER_ABI, functionName: "tailEmissionRate" }),
      publicClient.readContract({ address: BLACK_ADDRESS, abi: BLACK_BALANCE_ABI, functionName: "balanceOf", args: [VE_ADDRESS] }),
      fetchBlackPrice(),
    ])) as [bigint, bigint, bigint, bigint, bigint, bigint, number];

  const totalSupply = Number(totalSupplyRaw) / 1e18;
  const circulatingSupply = Number(circulatingRaw) / 1e18;
  const totalLockedBlack = Number(veSupplyRaw) / 1e18;
  const lockRatio = totalSupply > 0 ? (totalLockedBlack / totalSupply) * 100 : 0;
  const currentEpochEmissions = Number(weeklyRaw) / 1e18;
  const epochCount = Number(epochCountRaw);

  const marketCap = blackPrice > 0 ? circulatingSupply * blackPrice : null;
  const fdv = blackPrice > 0 ? totalSupply * blackPrice : null;

  let emissionPhase: string;
  if (epochCountRaw >= TAIL_START) {
    emissionPhase = `tail (vote-based, current rate ${Number(tailRateRaw) / 100}%)`;
  } else if (epochCount < 14) {
    emissionPhase = "growth (+3% per epoch, epochs 1–14)";
  } else {
    emissionPhase = "decay (-1% per epoch, epochs 15–66)";
  }

  const emissionsSchedule = projectEmissionsSchedule(weeklyRaw, epochCountRaw, tailRateRaw, 10);

  return {
    success: true,
    token: "BLACK",
    address: BLACK_ADDRESS,
    blackPriceUsd: blackPrice > 0 ? blackPrice : null,
    totalSupply: Math.round(totalSupply).toLocaleString("en-US"),
    circulatingSupply: Math.round(circulatingSupply).toLocaleString("en-US"),
    totalLockedBlack: Math.round(totalLockedBlack).toLocaleString("en-US"),
    lockRatio: lockRatio.toFixed(2) + "%",
    marketCapUsd: marketCap !== null ? Math.round(marketCap).toLocaleString("en-US") : null,
    fdvUsd: fdv !== null ? Math.round(fdv).toLocaleString("en-US") : null,
    currentEpoch: epochCount,
    emissionPhase,
    currentEpochEmissions: Math.round(currentEpochEmissions).toLocaleString("en-US"),
    emissionsScheduleNext10Epochs: emissionsSchedule,
    note: "totalLockedBlack = BLACK.balanceOf(VotingEscrow) — raw BLACK held by the ve contract. circulatingSupply = totalSupply − lockedInVe − burned. marketCap/fdv require live price feed; null if unavailable.",
  };
}

export const getTokenomicsTool = {
  name: "get_tokenomics",
  description:
    "Returns BLACK token tokenomics: total supply, circulating supply, market cap, FDV, current epoch emissions, and a projected 10-epoch emissions schedule. Circulating supply excludes tokens locked in veNFTs and burned tokens. Market cap and FDV are null if the price feed is unavailable.",
  inputSchema: {
    type: "object",
    properties: {},
  },
};
