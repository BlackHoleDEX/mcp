import { formatUnits, parseUnits } from 'viem';

import {
  ERC20_ABI,
  ROUTER_V2_ABI,
  ROUTER_V2_ADDRESS,
} from '../constants/contracts.js';
import { hasSufficientAllowance } from '../utils/erc20.js';
import { getEnvUserAddress } from '../utils/wallet.js';

const DEFAULT_ADD_SLIPPAGE_PERCENT = 1;

function applySlippage(rawAmount: bigint, slippagePercent: number): bigint {
  const clamped = Math.min(Math.max(slippagePercent, 0), 99.99);
  const bps = BigInt(Math.floor(clamped * 100));
  return (rawAmount * (10000n - bps)) / 10000n;
}

export interface AddLiquidityParams {
  tokenA: string;
  tokenB: string;
  stable: boolean;
  amountADesired: string;
  amountBDesired: string;
  amountAMin?: string;
  amountBMin?: string;
  slippagePercent?: number;
  slippageConfirmed?: boolean;
  userAddress?: string;
  tokenADecimals?: number;
  tokenBDecimals?: number;
}

export async function handleAddLiquiditySteps(params: AddLiquidityParams) {
  const userAddress = params.userAddress ?? getEnvUserAddress();
  if (!userAddress) throw new Error("Provide userAddress or set PRIVATE_KEY / USER_ADDRESS in the MCP server environment.");

  const {
    tokenA,
    tokenB,
    stable,
    amountADesired,
    amountBDesired,
    tokenADecimals = 18,
    tokenBDecimals = 18,
    slippagePercent = DEFAULT_ADD_SLIPPAGE_PERCENT,
    slippageConfirmed = false,
  } = params;

  const desiredARaw = parseUnits(amountADesired, tokenADecimals);
  const desiredBRaw = parseUnits(amountBDesired, tokenBDecimals);

  const computedMinARaw = applySlippage(desiredARaw, slippagePercent);
  const computedMinBRaw = applySlippage(desiredBRaw, slippagePercent);

  if (!slippageConfirmed) {
    return {
      success: false,
      action_required: "confirm_slippage",
      message: [
        `Default add liquidity slippage is **${slippagePercent}%**.`,
        `  • Minimum Token A you will deposit: ${formatUnits(computedMinARaw, tokenADecimals)} (${slippagePercent}% slippage on ${amountADesired})`,
        `  • Minimum Token B you will deposit: ${formatUnits(computedMinBRaw, tokenBDecimals)} (${slippagePercent}% slippage on ${amountBDesired})`,
        "Present this to the user and ask if they want to keep this slippage or change it. Once confirmed, re-call this tool with slippageConfirmed=true (and slippagePercent set to any updated value).",
      ].join("\n"),
      slippage: {
        slippage_percent: slippagePercent,
        amountAMin: formatUnits(computedMinARaw, tokenADecimals),
        amountBMin: formatUnits(computedMinBRaw, tokenBDecimals),
      },
    };
  }

  const minARaw = params.amountAMin
    ? parseUnits(params.amountAMin, tokenADecimals).toString()
    : computedMinARaw.toString();
  const minBRaw = params.amountBMin
    ? parseUnits(params.amountBMin, tokenBDecimals).toString()
    : computedMinBRaw.toString();

  // Default deadline: +20 mins from now
  const deadline = Math.floor(Date.now() / 1000) + 60 * 20;

  const steps = [];

  const [hasAllowanceA, hasAllowanceB] = await Promise.all([
    hasSufficientAllowance(tokenA, userAddress, ROUTER_V2_ADDRESS, desiredARaw),
    hasSufficientAllowance(tokenB, userAddress, ROUTER_V2_ADDRESS, desiredBRaw),
  ]);

  if (!hasAllowanceA) {
    steps.push({
      title: 'Approve Token A',
      description: `Approve the Blackhole Router V2 to spend ${amountADesired} of Token ${tokenA}`,
      waitForReceipt: true,
      payload: {
        to: tokenA,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ROUTER_V2_ADDRESS, desiredARaw.toString()],
        value: '0',
      },
    });
  }

  if (!hasAllowanceB) {
    steps.push({
      title: 'Approve Token B',
      description: `Approve the Blackhole Router V2 to spend ${amountBDesired} of Token ${tokenB}`,
      waitForReceipt: true,
      payload: {
        to: tokenB,
        abi: ERC20_ABI,
        functionName: 'approve',
        args: [ROUTER_V2_ADDRESS, desiredBRaw.toString()],
        value: '0',
      },
    });
  }

  steps.push({
    title: 'Execute Add Liquidity',
    description: `Add liquidity to ${stable ? 'stable' : 'volatile'} pool on Router V2`,
    payload: {
      to: ROUTER_V2_ADDRESS,
      abi: ROUTER_V2_ABI,
      functionName: 'addLiquidity',
      args: [
        tokenA,
        tokenB,
        stable,
        desiredARaw.toString(),
        desiredBRaw.toString(),
        minARaw,
        minBRaw,
        userAddress,
        deadline,
      ],
      value: '0',
    },
  });

  return {
    success: true,
    sequential: true,
    message: 'Computed steps necessary for adding liquidity. Note: LP tokens are NOT staked — use stake_liquidity_steps to earn emissions.',
    steps,
  };
}

export const addLiquidityTool = {
  name: "add_liquidity_steps",
  description:
    "Returns the step-by-step transaction payloads to add liquidity on the Blackhole DEX. " +
    `On the first call (slippageConfirmed omitted or false) returns a slippage confirmation prompt at the default ${DEFAULT_ADD_SLIPPAGE_PERCENT}% slippage. ` +
    "Present this to the user and ask if they want to change it. Re-call with slippageConfirmed=true once confirmed. " +
    "IMPORTANT: Adding liquidity only mints LP tokens — it does NOT stake them. LP tokens must be staked in the gauge via stake_liquidity_steps to earn BLACK emissions/APR. Unstaked LP only earns swap fees. " +
    "Steps must be executed sequentially — approval steps (if any) must confirm before the add liquidity transaction.",
  inputSchema: {
    type: "object",
    properties: {
      tokenA: { type: "string", description: "Address of the first token." },
      tokenB: { type: "string", description: "Address of the second token." },
      stable: { type: "boolean", description: "True if the pair is a stable pair." },
      amountADesired: { type: "string", description: "Desired human-readable amount of Token A." },
      amountBDesired: { type: "string", description: "Desired human-readable amount of Token B." },
      slippagePercent: { type: "number", description: `Slippage % for amountAMin/amountBMin (default ${DEFAULT_ADD_SLIPPAGE_PERCENT}%).` },
      slippageConfirmed: { type: "boolean", description: "Set to true after user confirms slippage. Defaults to false, returning a confirmation prompt." },
      amountAMin: { type: "string", description: "Override: minimum human-readable amount of Token A. When omitted, computed from amountADesired × (1 - slippage%)." },
      amountBMin: { type: "string", description: "Override: minimum human-readable amount of Token B. When omitted, computed from amountBDesired × (1 - slippage%)." },
      userAddress: { type: "string", description: "Optional. Wallet address of the user. Defaults to the address derived from PRIVATE_KEY or USER_ADDRESS env var." },
      tokenADecimals: { type: "number", description: "Decimals of Token A (defaults to 18)." },
      tokenBDecimals: { type: "number", description: "Decimals of Token B (defaults to 18)." },
    },
    required: ["tokenA", "tokenB", "stable", "amountADesired", "amountBDesired"],
  },
};
