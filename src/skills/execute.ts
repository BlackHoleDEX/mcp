import { createWalletClient, encodeFunctionData, getAddress, http, isAddress, type Address, type Hex } from "viem";
import { avalanche } from "viem/chains";

import { SERVER_CONFIG } from "../config.js";
import { ERC20_ABI } from "../constants/contracts.js";
import { publicClient } from "../utils/viemClient.js";
import { getEnvWalletAccount } from "../utils/wallet.js";

type TxValue = string | number | bigint;

type RawTransactionCall = {
  to?: unknown;
  data?: unknown;
  value?: unknown;
  payload?: unknown;
  approval?: unknown;
};

type ExecuteTransactionsParams = {
  confirm?: boolean;
  from?: string;
  to?: string;
  data?: string;
  value?: TxValue;
  call?: RawTransactionCall;
  calls?: RawTransactionCall[];
  steps?: RawTransactionCall[];
  waitForReceipt?: boolean;
};

function parseTxValue(value: unknown): bigint {
  if (value === undefined || value === null || value === "") return 0n;
  if (typeof value === "bigint") return value;
  if (typeof value === "number") {
    if (!Number.isSafeInteger(value) || value < 0) {
      throw new Error("Transaction value must be a non-negative safe integer when provided as a number.");
    }
    return BigInt(value);
  }
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (/^0x[0-9a-fA-F]+$/.test(trimmed) || /^[0-9]+$/.test(trimmed)) {
      return BigInt(trimmed);
    }
  }
  throw new Error("Transaction value must be a decimal or hex wei string.");
}

function parseCalldata(data: unknown): Hex {
  if (data === undefined || data === null || data === "") return "0x";
  if (typeof data !== "string" || !/^0x[0-9a-fA-F]*$/.test(data)) {
    throw new Error("Transaction data must be hex calldata.");
  }
  return data as Hex;
}

function normalizeCall(input: RawTransactionCall) {
  if (input.approval && typeof input.approval === "object") {
    return normalizeApproval(input.approval as Record<string, unknown>);
  }

  const source = input.payload && typeof input.payload === "object" ? (input.payload as RawTransactionCall) : input;
  const { to, data, value } = source;

  if (typeof to !== "string" || !isAddress(to)) {
    throw new Error("Each transaction call must include a valid `to` address.");
  }

  return {
    to: getAddress(to) as Address,
    data: parseCalldata(data),
    value: parseTxValue(value),
  };
}

function normalizeApproval(approval: Record<string, unknown>) {
  const { tokenAddress, spender, amount } = approval;
  if (typeof tokenAddress !== "string" || !isAddress(tokenAddress)) {
    throw new Error("Approval steps must include a valid `tokenAddress`.");
  }
  if (typeof spender !== "string" || !isAddress(spender)) {
    throw new Error("Approval steps must include a valid `spender` address.");
  }
  if (typeof amount !== "string" && typeof amount !== "number" && typeof amount !== "bigint") {
    throw new Error("Approval steps must include an `amount` in raw token units.");
  }

  return {
    to: getAddress(tokenAddress) as Address,
    data: encodeFunctionData({
      abi: ERC20_ABI,
      functionName: "approve",
      args: [getAddress(spender), parseTxValue(amount)],
    }),
    value: 0n,
  };
}

function callsFromParams(params: ExecuteTransactionsParams): RawTransactionCall[] {
  if (Array.isArray(params.calls) && params.calls.length > 0) return params.calls;
  if (Array.isArray(params.steps) && params.steps.length > 0) return params.steps;
  if (params.call) return [params.call];
  if (params.to) return [{ to: params.to, data: params.data, value: params.value }];
  return [];
}

export async function handleExecuteTransactions(params: ExecuteTransactionsParams) {
  if (params.confirm !== true) {
    throw new Error("Set `confirm: true` to execute transactions with the configured private key.");
  }

  const account = getEnvWalletAccount();
  if (!account) {
    throw new Error("Execution requires PRIVATE_KEY in the MCP server environment.");
  }

  if (params.from && getAddress(params.from) !== account.address) {
    throw new Error("The provided `from` address does not match the configured private key.");
  }

  const rawCalls = callsFromParams(params);
  const calls = rawCalls.map(normalizeCall);
  if (calls.length === 0) {
    throw new Error("Provide a transaction via `to`/`data`/`value`, `call`, `calls`, or `steps`.");
  }

  const walletClient = createWalletClient({
    account,
    chain: avalanche,
    transport: http(SERVER_CONFIG.RPC_URL),
  });
  const globalWaitForReceipt = params.waitForReceipt !== false;

  const transactions = [];
  for (let index = 0; index < calls.length; index++) {
    const call = calls[index]!;
    const raw = rawCalls[index]! as any;

    // Estimate gas with 30% buffer (mirrors blackhole-website gas-estimation.ts)
    let gas: bigint | undefined;
    try {
      const estimated = await publicClient.estimateGas({
        account: account.address,
        to: call.to,
        data: call.data,
        value: call.value,
      });
      gas = (estimated * 13n) / 10n;
    } catch {
      // fall back to node auto-estimation if estimateGas fails
    }

    const hash = await walletClient.sendTransaction({
      account,
      chain: avalanche,
      to: call.to,
      data: call.data,
      value: call.value,
      ...(gas !== undefined ? { gas } : {}),
    });

    // Per-step waitForReceipt overrides global — approval steps set this to true
    // so they always confirm before the next transaction is sent.
    const stepWaitForReceipt =
      typeof raw.waitForReceipt === "boolean" ? raw.waitForReceipt : globalWaitForReceipt;
    const receipt = stepWaitForReceipt ? await publicClient.waitForTransactionReceipt({ hash }) : undefined;
    transactions.push({
      index,
      to: call.to,
      value: call.value.toString(),
      hash,
      receipt: receipt
        ? {
            status: receipt.status,
            blockNumber: receipt.blockNumber.toString(),
            gasUsed: receipt.gasUsed.toString(),
          }
        : undefined,
    });
  }

  return {
    success: true,
    signer: account.address,
    waitForReceipt: globalWaitForReceipt,
    transactions,
  };
}

export const executeTransactionsTool = {
  name: "execute_transactions",
  description:
    "Executes one or more prepared transaction payloads on Avalanche using PRIVATE_KEY from the MCP server environment. Use only after the user has reviewed and confirmed the transaction steps.",
  inputSchema: {
    type: "object",
    properties: {
      confirm: {
        type: "boolean",
        description: "Must be true to broadcast transactions with the configured private key.",
      },
      from: {
        type: "string",
        description: "Optional signer address safety check; must match the private key-derived address.",
      },
      to: {
        type: "string",
        description: "Single transaction target address. Use this with `data` and optional `value`.",
      },
      data: {
        type: "string",
        description: "Single transaction calldata as a 0x-prefixed hex string.",
      },
      value: {
        type: "string",
        description: "Single transaction native value in wei as a decimal or hex string. Defaults to 0.",
      },
      call: {
        type: "object",
        description: "Single compact transaction object: { to, data, value }.",
      },
      calls: {
        type: "array",
        items: { type: "object" },
        description: "Compact transaction objects to execute sequentially: [{ to, data, value }].",
      },
      steps: {
        type: "array",
        items: { type: "object" },
        description:
          "Step objects from *_steps tools. Executed sequentially — each transaction is confirmed before the next is sent. Critical for approval→action pairs: the approval must land on-chain before the dependent transaction is submitted.",
      },
      waitForReceipt: {
        type: "boolean",
        description: "Wait for each transaction receipt before sending the next call. Defaults to true.",
      },
    },
    required: ["confirm"],
  },
};
