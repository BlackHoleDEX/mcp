const DEBUG_KEYS = ["mcp_debug", "debug"] as const;

function isTruthyDebug(v: unknown): boolean {
  if (v === true) return true;
  if (typeof v === "string") return v === "1" || v.toLowerCase() === "true";
  return false;
}

/** Reads MCP debug flag from tool arguments (not passed through to skill handlers). */
export function takeMcpDebugFromArgs(raw: unknown): { debug: boolean; args: Record<string, unknown> } {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return { debug: false, args: {} };
  }
  const o = { ...(raw as Record<string, unknown>) };
  let debug = false;
  for (const key of DEBUG_KEYS) {
    if (key in o) {
      if (isTruthyDebug(o[key])) debug = true;
      delete o[key];
    }
  }
  return { debug, args: o };
}
