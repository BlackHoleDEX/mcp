# Blackhole MCP: Product Guide

## Blackhole MCP Capabilities and Business Value

### Blackhole MCP in One View

Blackhole MCP is a Model Context Protocol server for Blackhole DEX on Avalanche. It gives AI agents a structured way to:

- Understand user portfolio and protocol state
- Plan DeFi actions (swap, LP, lock, vote, claim, stake)
- Generate safe, step-by-step transaction payloads
- Execute reviewed transaction payloads with an explicitly configured private key
- Execute advanced workflows (especially zaps and concentrated liquidity)

This means users can go from a natural-language request (for example, "move my AVAX into a balanced CL position and stake it") to a precise, executable transaction plan through an agent.

### Supported Onchain Workflows

At a high level, Blackhole MCP supports 6 major capability groups:

1. **Trading and Routing**
   - Get quotes and routes
   - Generate swap transaction steps
   - Support split-route optimization

2. **Liquidity Management (V2 + Concentrated Liquidity)**
   - Add/remove/withdraw liquidity
   - Create CL pools
   - Manage CL ranges, ticks, and position details
   - Simulate CL APR and perform CL math helpers

3. **Zaps and Automation-Friendly Liquidity Flows**
   - Build split plans for optimal entry
   - Zap into V2 LP
   - Zap into CL mint / increase
   - Zap out of liquidity

4. **Rewards, Locks, Governance**
   - Stake and unstake liquidity
   - Claim fees, emissions, voting rewards
   - Create and manage veNFT locks
   - Vote on pools
   - Add bribes and create gauges

5. **Portfolio and Discovery**
   - Resolve token/symbol/address context
   - Fetch balances, user positions, and lock data
   - Fetch whitelisted tokens
   - Query pool yield and ranked opportunities

6. **Execution**
   - Broadcast compact transaction payloads through `execute_transactions`
   - Derive default `userAddress` from `PRIVATE_KEY`
   - Support read-only `userAddress` defaults through `USER_ADDRESS`

### Product and Business Impact

- **Faster user action:** Lower friction from discovery to execution.
- **Higher protocol engagement:** Easier staking, voting, and claiming increases retention loops.
- **Better UX for complex strategies:** Zaps and CL workflows become approachable to non-expert users.
- **Agent-native growth:** Products can ship chat-first or copilot-first experiences instead of only form-based UIs.

### Representative User Journeys

- "Find me the best AVAX -> USDC route and execute safely."
- "I have USDC and WAVAX; create a concentrated position around current price."
- "Claim all my pending rewards and restake where possible."
- "Show my veNFT locks and help me vote this week."
- "Compare top yielding pools and build a rebalance plan."

---

## Stakeholder Demo Prompts and Product Opportunities

### Demo Prompts to Validate Capabilities

Use these as demo prompts in Cursor/Claude/agent products:

- "What are the top 10 pools by LP emissions APR and TVL?"
- "Quote swapping 250 AVAX to USDC using split routes and explain the route choice."
- "Generate swap steps for 50 AVAX to USDC with conservative min output."
- "Show my current positions, staked LP, and claimable rewards."
- "Create a zap split plan for entering the AVAX-USDC pool with 1,000 USDC."
- "Generate zap add liquidity steps for a basic pool using my input token."
- "Mint and stake a concentrated liquidity position in one flow."
- "Increase my existing CL position using a single input token."
- "Claim fees for my CL position tokenId and then claim emissions."
- "Create a new lock for 5,000 tokens for 52 weeks."
- "Increase lock amount for tokenId 123 and then extend lock duration."
- "Reset vote and re-vote my lock across 3 pools with new weights."
- "Build voting rewards claim payload from my lock data."
- "Create a gauge for this pool and add a bribe campaign."

### Product Experiences You Can Build

1. **AI DeFi Copilot (Retail)**
   - Chat interface for swaps, LP, zaps, rewards, and governance.
   - Guided execution with transparent "step preview" and risk hints.

2. **Portfolio Command Center**
   - Unified balances/positions/locks/rewards dashboard.
   - One-click or one-prompt "claim + restake + rebalance" flows.

3. **Governance Automation Assistant**
   - Weekly vote recommendations from pool yield data.
   - Lock management and claim reminders with auto-generated transactions.

4. **Liquidity Strategy Builder**
   - CL range recommendations and APR simulations.
   - Zap-driven entry/exit automation for single-asset users.

5. **Institutional/Rebalancing Bot**
   - Policy-driven allocations across pools and gauges.
   - Scheduled execution plans with guardrails (slippage, min output, route constraints).

6. **Growth and Retention Layer for Wallets/Exchanges**
   - Embed Blackhole actions directly in wallet assistant experiences.
   - Drive user retention via rewards and governance loops.

### Recommended Product Safety Guardrails

- Always show a human-readable summary before signing.
- Require user confirmation before any transaction execution.
- Set conservative defaults for slippage and min amounts.
- Surface route assumptions and token decimal handling clearly.
- Record an execution log for support and compliance review.

---

## Implementation Guide: Blackhole MCP

### Supported Integration Patterns

Blackhole MCP supports two practical integration patterns:

1. **Stdio mode (best for Cursor/Claude desktop MCP clients)**
2. **Library mode (`createMcpServer`) for embedding in your Node app**

### npm Package Availability

Blackhole MCP is published as an npm package, so teams can integrate directly from npm instead of cloning and running from source.

- Install: `npm install @blackhole-dex/blackhole-mcp-server`
- Cursor/Claude MCP config can call it via `npx @blackhole-dex/blackhole-mcp-server`
- Node agent runtimes can import `createMcpServer` from the package

### Setting Up MCP with Cursor

Add this to `.cursor/mcp.json`:

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

If running from source:

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

Once saved, Cursor indexes the server tools and they become available to the agent.

### Setting Up MCP with Claude Code

Add this MCP from JSON:

```bash
claude mcp add-json blackhole-dex '{
  "command": "npx",
  "args": ["@blackhole-dex/blackhole-mcp-server"]
}'
```

You can use the same MCP JSON definition across Cursor, Claude Code, and other MCP-capable clients.

### Using This MCP in Your Own Agent Runtime

```ts
import { createMcpServer } from "@blackhole-dex/blackhole-mcp-server";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const server = createMcpServer();
const transport = new StdioServerTransport();
await server.connect(transport);
```

### Other Tools

Other AI tools and frameworks that support MCP generally work the same way:

- Provide the MCP command JSON for this server
- Ensure the tool can discover and index MCP tools
- Reuse the same config pattern (`command` + `args`) for portable setup

### Recommended Agent Orchestration Flow

Use a deterministic planning-execution chain:

1. **Intent understanding**
   - Parse user goal and constraints (budget, risk, allowed assets, deadlines).

2. **Discovery and context**
   - Call portfolio/discovery tools:
     - `get_token_balances`
     - `get_user_positions`
     - `get_user_locks`
     - `get_whitelisted_tokens`
     - `resolve_address`

3. **Planning**
   - Call quote/yield/simulation tools:
     - `quote`
     - `pool_yield`
     - `cl_apr_simulator`
     - `cl_position_detail`

4. **Transaction payload generation**
   - Call step tools (`*_steps`) only after user confirmation:
     - swaps/liquidity/zaps/claims/votes/locks

5. **Pre-signing checks**
   - Validate token decimals, min output, deadlines, and recipient address.

6. **Execution + post-action verification**
   - Call `execute_transactions` with the reviewed compact payloads and `confirm: true`, then refresh balances/positions to confirm outcomes.

### Prompt-to-Tool Mapping for Agent Builders

- **"Best route for swap"** -> `quote` -> `swap_steps`
- **"Single-token LP entry"** -> `zap_split_plan` -> `zap_add_liquidity_steps`
- **"CL mint from one token"** -> `zap_split_plan` -> `zap_mint_cl_steps`
- **"Claim all rewards"** -> `claim_fees_steps` + `claim_emissions_steps` + `claim_voting_rewards_payload`
- **"Governance rebalance"** -> `pool_yield` + `vote_steps` + `add_bribes_steps`

### Environment Configuration Notes

- Use `prod`/`mainnet` for Avalanche mainnet.
- Ensure your agent surfaces the active network clearly before execution.
- Configure `PRIVATE_KEY` only in the MCP server environment when server-side execution is intended.
- If a private key is configured, `userAddress` is derived from it automatically for tools that need wallet context. For read-only context without execution, use `USER_ADDRESS`.

### Execution Safety and Reliability Checklist

- Never auto-sign; always require wallet confirmation.
- Simulate/preview all steps before execution.
- Require `confirm: true` when calling `execute_transactions`.
- Handle retries idempotently at the orchestration layer.
- Persist conversation-to-transaction audit trails.
- Add policy controls per user tier (max notional, approved tokens, allowed actions).

---

## Appendix: Current Tool Families

- Trading: `quote`, `swap_steps`
- V2 liquidity: `add_liquidity_steps`, `remove_liquidity_steps`, `withdraw_liquidity_steps`
- CL liquidity: `add_liquidity_cl_steps`, `create_cl_pool_steps`
- Zaps: `zap_split_plan`, `zap_add_liquidity_steps`, `zap_remove_liquidity_steps`, `zap_mint_cl_steps`, `zap_increase_liquidity_steps`
- Staking: `stake_liquidity_steps`, `unstake_liquidity_steps`
- Rewards: `claim_fees_steps`, `claim_emissions_steps`, `claim_voting_rewards_steps`, `claim_voting_rewards_payload`
- Locks/governance: `create_lock_steps`, `increase_lock_steps`, `merge_lock_steps`, `lock_advanced_steps`, `vote_steps`, `create_gauge_steps`, `add_bribes_steps`
- Portfolio/discovery: `resolve_address`, `get_token_balances`, `get_user_positions`, `get_user_locks`, `get_whitelisted_tokens`, `pool_yield`
- CL helpers: `cl_tick_to_price`, `cl_price_to_tick`, `cl_position_detail`, `cl_apr_simulator`
- Execution: `execute_transactions`
