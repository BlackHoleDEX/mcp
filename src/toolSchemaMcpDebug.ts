const MCP_DEBUG_PROPERTY = {
  mcp_debug: {
    type: "boolean",
    description:
      "Optional. When true: pretty-print JSON and keep full transaction payloads (abi, functionName, args). When false or omitted: compact JSON and encode calldata as { to, value, data }.",
  },
} as const;

type ToolDef = {
  name: string;
  description: string;
  inputSchema: {
    type: string;
    properties?: Record<string, unknown>;
    required?: string[];
    [key: string]: unknown;
  };
};

const ENV_USER_ADDRESS_NOTE =
  " If omitted, the server uses the address derived from PRIVATE_KEY, or USER_ADDRESS.";

function withEnvUserAddressFallback(schema: ToolDef["inputSchema"]): ToolDef["inputSchema"] {
  const userAddressProperty = schema.properties?.userAddress;
  const required = schema.required?.filter((key) => key !== "userAddress");
  const properties =
    userAddressProperty && typeof userAddressProperty === "object" && !Array.isArray(userAddressProperty)
      ? {
          ...schema.properties,
          userAddress: {
            ...(userAddressProperty as Record<string, unknown>),
            description: `${String((userAddressProperty as Record<string, unknown>).description ?? "User wallet address.")}${ENV_USER_ADDRESS_NOTE}`,
          },
        }
      : schema.properties;

  return {
    ...schema,
    properties,
    ...(required && required.length > 0 ? { required } : {}),
  };
}

/** Adds optional `mcp_debug` to every tool schema so the LLM can request verbose responses per call. */
export function withMcpDebugOption<T extends ToolDef>(tool: T): T {
  const inputSchema = withEnvUserAddressFallback(tool.inputSchema);

  return {
    ...tool,
    inputSchema: {
      ...inputSchema,
      properties: {
        ...inputSchema.properties,
        ...MCP_DEBUG_PROPERTY,
      },
    },
  };
}
