import { formatEther, isAddress, isHex } from "viem";

import { publicClient } from "../utils/viemClient.js";

export interface EstimateGasCall {
  to: string;
  data: string;
  value?: string;
}

export interface EstimateGasAndTxCostParams {
  /** Wallet address that would send the transaction(s). */
  from: string;
  /** Single call: contract or recipient address. */
  to?: string;
  /** Single call: ABI-encoded calldata (use `0x` for a plain native transfer). */
  data?: string;
  /** Single call: value in wei as a decimal string (default 0). */
  value?: string;
  /** Multiple sequential calls; when non-empty, `to` / `data` / `value` on the root are ignored. */
  calls?: EstimateGasCall[];
}

type CallEstimate = {
  index: number;
  to: `0x${string}`;
  estimatedGasLimit: string;
  estimatedCostWei: string;
  estimatedCostAvax: string;
};

function parseWei(value?: string): bigint {
  if (value === undefined || value === "") return 0n;
  return BigInt(value);
}

async function resolvePricePerGasWei(): Promise<{
  gasPriceWei: bigint;
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
}> {
  try {
    const fees = await publicClient.estimateFeesPerGas();
    if (fees.maxFeePerGas != null) {
      return {
        gasPriceWei: fees.maxFeePerGas,
        maxFeePerGas: fees.maxFeePerGas,
        maxPriorityFeePerGas: fees.maxPriorityFeePerGas ?? undefined,
      };
    }
  } catch {
    // fall through to legacy gas price
  }
  const gasPriceWei = await publicClient.getGasPrice();
  return { gasPriceWei };
}

function assertCallShape(to: string, data: string, label: string) {
  if (!isAddress(to)) {
    throw new Error(`${label}: invalid address "to"`);
  }
  if (!isHex(data)) {
    throw new Error(`${label}: "data" must be hex (0x…)`);
  }
}

export async function handleEstimateGasAndTxCost(params: EstimateGasAndTxCostParams) {
  const { from } = params;
  if (!isAddress(from)) {
    throw new Error('Invalid "from" address');
  }

  const fromAddr = from as `0x${string}`;

  let callList: { to: `0x${string}`; data: `0x${string}`; value: bigint }[];

  if (params.calls != null && params.calls.length > 0) {
    callList = params.calls.map((c, i) => {
      assertCallShape(c.to, c.data, `calls[${i}]`);
      return {
        to: c.to as `0x${string}`,
        data: c.data as `0x${string}`,
        value: parseWei(c.value),
      };
    });
  } else {
    const { to, data } = params;
    if (to == null || data == null) {
      throw new Error('Provide either ("to" and "data") or a non-empty "calls" array');
    }
    assertCallShape(to, data, "transaction");
    callList = [
      {
        to: to as `0x${string}`,
        data: data as `0x${string}`,
        value: parseWei(params.value),
      },
    ];
  }

  const { gasPriceWei, maxFeePerGas, maxPriorityFeePerGas } = await resolvePricePerGasWei();
  const chain = publicClient.chain;

  const perCall: CallEstimate[] = [];
  let totalGas = 0n;
  let totalCostWei = 0n;

  for (let i = 0; i < callList.length; i++) {
    const c = callList[i];
    const estimatedGasLimit = await publicClient.estimateGas({
      account: fromAddr,
      to: c.to,
      data: c.data,
      value: c.value,
    });
    const costWei = estimatedGasLimit * gasPriceWei;
    totalGas += estimatedGasLimit;
    totalCostWei += costWei;
    perCall.push({
      index: i,
      to: c.to,
      estimatedGasLimit: estimatedGasLimit.toString(),
      estimatedCostWei: costWei.toString(),
      estimatedCostAvax: formatEther(costWei),
    });
  }

  return {
    success: true,
    chainId: chain?.id,
    nativeSymbol: chain?.nativeCurrency?.symbol ?? "AVAX",
    gasPriceWei: gasPriceWei.toString(),
    ...(maxFeePerGas != null ? { maxFeePerGas: maxFeePerGas.toString() } : {}),
    ...(maxPriorityFeePerGas != null
      ? { maxPriorityFeePerGas: maxPriorityFeePerGas.toString() }
      : {}),
    note:
      "estimatedCostWei uses maxFeePerGas when EIP-1559 estimates are available, otherwise legacy gasPrice — treat as an upper bound, not the exact paid amount.",
    calls: perCall,
    totalEstimatedGasLimit: totalGas.toString(),
    totalEstimatedCostWei: totalCostWei.toString(),
    totalEstimatedCostNative: formatEther(totalCostWei),
  };
}

export const estimateGasAndTxCostTool = {
  name: "estimate_gas_and_tx_cost",
  description:
    "Estimates gas limit and approximate native (AVAX) fee for one or more unsigned transactions on Avalanche C-Chain. Accepts the same { to, data, value } shape as compacted *_steps payloads (hex calldata). Use the user's wallet as `from`. For multi-step flows, pass `calls` in execution order; costs are summed.",
  inputSchema: {
    type: "object",
    properties: {
      from: {
        type: "string",
        description: "Sender address (must match the wallet that will sign).",
      },
      to: {
        type: "string",
        description: "Target address for a single transaction (ignored when `calls` is provided).",
      },
      data: {
        type: "string",
        description: "Hex-encoded calldata for a single transaction; use 0x for a plain AVAX transfer.",
      },
      value: {
        type: "string",
        description: "Optional value in wei (decimal string) for a single transaction. Defaults to 0.",
      },
      calls: {
        type: "array",
        description:
          "Optional list of { to, data, value? } objects. When present, root-level to/data/value are ignored.",
        items: {
          type: "object",
          properties: {
            to: { type: "string" },
            data: { type: "string" },
            value: { type: "string", description: "Wei as decimal string; default 0." },
          },
          required: ["to", "data"],
        },
      },
    },
    required: ["from"],
  },
};
