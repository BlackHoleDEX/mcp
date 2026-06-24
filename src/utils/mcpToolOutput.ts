import { encodeFunctionData } from "viem";

type EncodableTxPayload = {
  to: string;
  abi: readonly unknown[];
  functionName: string;
  args: readonly unknown[];
  value: string | number | bigint;
};

function isEncodableTxPayload(x: unknown): x is EncodableTxPayload {
  if (!x || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  return (
    typeof o.to === "string" &&
    Array.isArray(o.abi) &&
    o.abi.length > 0 &&
    typeof o.functionName === "string" &&
    Array.isArray(o.args) &&
    (typeof o.value === "string" || typeof o.value === "number" || typeof o.value === "bigint")
  );
}

function toCompressedPayload(p: EncodableTxPayload) {
  const value =
    typeof p.value === "bigint" ? p.value.toString() : typeof p.value === "number" ? String(p.value) : p.value;
  return {
    to: p.to,
    value,
    data: encodeFunctionData({
      abi: p.abi as Parameters<typeof encodeFunctionData>[0]["abi"],
      functionName: p.functionName as string,
      args: p.args as unknown[],
    }),
  };
}

function compressUnknown(val: unknown): unknown {
  if (val === null || typeof val !== "object") return val;
  if (Array.isArray(val)) {
    return val.map((item) => compressUnknown(item));
  }
  const o = val as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(o)) {
    if (isEncodableTxPayload(v)) {
      out[k] = toCompressedPayload(v);
    } else {
      out[k] = compressUnknown(v);
    }
  }
  return out;
}

/** Replace `{ to, abi, functionName, args, value }` with `{ to, value, data }` anywhere in the result tree. */
export function compactMcpToolResult(result: unknown): unknown {
  return compressUnknown(result);
}
