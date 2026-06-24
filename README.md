# Blackhole MCP Server

Model Context Protocol server for the Blackhole DEX on Avalanche. Provides 32 tools for swaps, liquidity, CL positions, voting, locks, gauges, bribes, yield queries, vote leaderboard, epoch state, allowances, pool status, risk flags, and transaction execution.

## Tools

| Category | Tools |
|---|---|
| **Swap** | `swap_steps`, `quote` |
| **Liquidity (V2)** | `add_liquidity_steps`, `remove_liquidity_steps`, `withdraw_liquidity_steps` |
| **Liquidity (CL)** | `add_liquidity_cl_steps` |
| **Zap** | `zap_add_liquidity_steps`, `zap_mint_cl_steps`, `zap_increase_liquidity_steps`, `zap_remove_liquidity_steps`, `zap_split_plan` |
| **Staking** | `stake_liquidity_steps`, `unstake_liquidity_steps` |
| **Fees & Emissions** | `claim_fees_steps`, `claim_emissions_steps`, `claim_voting_rewards_steps`, `claim_voting_rewards_payload` |
| **Locks (veNFT)** | `create_lock_steps`, `increase_lock_steps`, `merge_lock_steps`, `lock_advanced_steps` |
| **Voting** | `vote_steps`, `vote_leaderboard` |
| **Epoch** | `get_epoch_state` |
| **Gauges & Bribes** | `create_gauge_steps`, `add_bribes_steps` |
| **Pools** | `create_cl_pool_steps`, `pool_yield` |
| **Operational / Safety** | `get_allowances`, `get_pool_status`, `get_opportunities` |
| **Execution** | `execute_transactions` |

## Installation

### 1. Stdio -- for MCP clients (Claude Desktop, Cursor, Codex)

#### Cursor (`.cursor/mcp.json`)

```json
{
  "mcpServers": {
    "blackhole-mcp": {
      "command": "npx",
      "args": ["@blackhole-dex/blackhole-mcp-server"],
      "env": {
        "PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

Or from source:

```json
{
  "mcpServers": {
    "blackhole-mcp": {
      "command": "bash",
      "args": ["-lc", "cd /path/to/mcp-server && NODE_ENV=prod npx tsx src/index.ts"],
      "env": {
        "PRIVATE_KEY": "0x..."
      }
    }
  }
}
```

#### Claude Desktop

**Option A — one command (recommended):**

From npm:
```bash
claude mcp add --scope user blackhole-mcp -- npx @blackhole-dex/blackhole-mcp-server
```

From source:
```bash
claude mcp add --scope user blackhole-mcp -- bash -lc "cd /path/to/mcp-server && NODE_ENV=prod npx tsx src/index.ts"
```

`--scope user` writes to your global Claude config (`~/.claude.json`) so the server is available in every project. Restart Claude Desktop after running.

**Option B — manual JSON** (`~/Library/Application Support/Claude/claude_desktop_config.json` on macOS, `%APPDATA%\Claude\claude_desktop_config.json` on Windows):

From npm:
```json
{
  "mcpServers": {
    "blackhole-mcp": {
      "command": "npx",
      "args": ["@blackhole-dex/blackhole-mcp-server"]
    }
  }
}
```

From source:
```json
{
  "mcpServers": {
    "blackhole-mcp": {
      "command": "bash",
      "args": ["-lc", "cd /path/to/mcp-server && NODE_ENV=prod npx tsx src/index.ts"]
    }
  }
}
```

Restart Claude Desktop after editing the file.

#### Codex

Codex reads MCP server config from `~/.codex/config.toml` (global) or `.codex/config.toml` (project-scoped, trusted projects only). The CLI and IDE extension share this file. See the [Codex MCP docs](https://developers.openai.com/codex/mcp) for details.

**Option A — Codex app / IDE (UI)**

1. Open **Settings** (gear icon) in the Codex app or IDE extension.
2. Go to **MCP settings** and add a server (or choose **Open config.toml** and paste the TOML from Option C below).
3. Set the command to `npx` with args `@blackhole-dex/blackhole-mcp-server`, and add `PRIVATE_KEY` under environment variables if you plan to execute transactions.

![Codex MCP settings UI](docs/images/codex-mcp-setup.png)

**Option B — CLI:**

From npm:
```bash
codex mcp add blackhole-mcp --env PRIVATE_KEY=0x... -- npx @blackhole-dex/blackhole-mcp-server
```

From source:
```bash
codex mcp add blackhole-mcp --env PRIVATE_KEY=0x... -- bash -lc "cd /path/to/mcp-server && NODE_ENV=prod npx tsx src/index.ts"
```

In the Codex TUI, use `/mcp` to verify the server is active.

**Option C — manual `config.toml`** (`~/.codex/config.toml` or `.codex/config.toml` in the project):

From npm:
```toml
[mcp_servers.blackhole-mcp]
command = "npx"
args = ["@blackhole-dex/blackhole-mcp-server"]

[mcp_servers.blackhole-mcp.env]
PRIVATE_KEY = "0x..."
```

From source:
```toml
[mcp_servers.blackhole-mcp]
command = "bash"
args = ["-lc", "cd /path/to/mcp-server && NODE_ENV=prod npx tsx src/index.ts"]

[mcp_servers.blackhole-mcp.env]
PRIVATE_KEY = "0x..."
```

### 2. Library -- import into your own Node.js app

```bash
npm install @blackhole-dex/blackhole-mcp-server
```

```ts
import { createMcpServer } from "@blackhole-dex/blackhole-mcp-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
```

Options:
- Exported API: `createMcpServer()`
- Also exported: `toolDefinitions`, `toolHandlers`

## Environment

The server uses production Avalanche mainnet configuration.

| Env | Network | RPC |
|---|---|---|
| `prod` | Avalanche Mainnet | `https://api.avax.network/ext/bc/C/rpc` |

Optional runtime variables:

| Variable | Purpose |
|---|---|
| `RPC_URL` | Override the Avalanche C-Chain RPC endpoint used for reads and execution. |
| `BASIC_GRAPH_URL` | Override the basic pools subgraph URL. |
| `CL_GRAPH_URL` | Override the concentrated-liquidity subgraph URL. |
| `GAMMA_VAULT_ADDRESSES` | Comma-separated Gamma vault allowlist override. |
| `PRIVATE_KEY` | Private key used by `execute_transactions`. The server derives `userAddress` from this key for any tool that needs it. |
| `USER_ADDRESS` | Read-only fallback address when no private key is configured. |

When `PRIVATE_KEY` is configured, tools with `userAddress` can omit it; the server fills in the private key-derived address. `execute_transactions` requires the private key and will only broadcast when called with `confirm: true`.