import { Server } from "@modelcontextprotocol/sdk/server/index.js";
import { CallToolRequestSchema, ListToolsRequestSchema } from "@modelcontextprotocol/sdk/types.js";

import { toolDefinitions } from "./toolDefinitions.js";
import { toolHandlers } from "./toolHandlers.js";
import { formatToolError } from "./utils/errorFormatter.js";
import { takeMcpDebugFromArgs } from "./utils/mcpDebugArgs.js";
import { compactMcpToolResult } from "./utils/mcpToolOutput.js";
import { withEnvUserAddress } from "./utils/wallet.js";

function toolAcceptsUserAddress(name: string): boolean {
  const tool = toolDefinitions.find((definition) => definition.name === name);
  const properties = tool?.inputSchema.properties as Record<string, unknown> | undefined;
  return Boolean(properties?.userAddress);
}

export function createMcpServer(): Server {
  const server = new Server(
    { name: "blackhole-mcp-server", version: "1.0.0" },
    { capabilities: { tools: {} } },
  );

  server.setRequestHandler(ListToolsRequestSchema, async () => ({
    tools: toolDefinitions,
  }));

  server.setRequestHandler(CallToolRequestSchema, async (request) => {
    const { name, arguments: rawArgs } = request.params;
    const handler = toolHandlers[name];

    if (!handler) {
      return {
        content: [{ type: "text", text: formatToolError(name, new Error(`Unknown tool: ${name}`)) }],
      };
    }

    try {
      const { debug: mcpDebug, args } = takeMcpDebugFromArgs(rawArgs);
      const handlerArgs = toolAcceptsUserAddress(name) ? withEnvUserAddress(args) : args;
      const result = await handler(handlerArgs);
      const forWire = mcpDebug ? result : compactMcpToolResult(result);
      return {
        content: [
          {
            type: "text",
            text: JSON.stringify(
              forWire,
              (_key, value) => (typeof value === "bigint" ? value.toString() : value),
              mcpDebug ? 2 : undefined,
            ),
          },
        ],
      };
    } catch (error: any) {
      return {
        content: [{ type: "text", text: formatToolError(name, error) }],
      };
    }
  });

  return server;
}

export { toolDefinitions, toolHandlers };
