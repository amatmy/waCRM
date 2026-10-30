> **Fork behavior:** raw machine message/broadcast sending is disabled. Use the
> [guarded copilot outbox and human approval](copilot-dispatch.md). The legacy
> send descriptions below are retained as upstream reference, not available
> capabilities of this fork. Read endpoints remain available.

# MCP server

wacrm ships a [Model Context Protocol](https://modelcontextprotocol.io)
server so you can drive your CRM from AI assistants — Claude Desktop,
Claude Code, Cursor, and any other MCP client — in natural language:

> "How many conversations are still open today?"
> "Show the last five messages with +1 415 555 0123."
> "Send the `order_update` template to that contact."

It lives in [`mcp-server/`](../mcp-server) and is published to npm as
[`wacrm-mcp`](https://www.npmjs.com/package/wacrm-mcp). Under the hood
it's a thin wrapper over the [public API](./public-api.md), so every
request is authenticated and scoped by your instance exactly like any
other API call.

## Quick start

1. Create an API key in the dashboard: **Settings → API keys**. Grant
   only the scopes your assistant needs (a read-only assistant only
   needs the `*:read` scopes).
2. Add the server to your MCP client config:

   ```jsonc
   {
     "mcpServers": {
       "wacrm": {
         "command": "npx",
         "args": ["-y", "wacrm-mcp"],
         "env": {
           "WACRM_BASE_URL": "https://crm.example.com",
           "WACRM_API_KEY": "wacrm_live_xxxxxxxxxxxxxxxxxxxxxxxx",
         },
       },
     },
   }
   ```

That's **read-only** — the safe default. To let the assistant change
data or send messages, add `"WACRM_ENABLE_WRITES": "true"` (and
`"WACRM_ENABLE_BROADCASTS": "true"` for mass sends) to `env`.

## What it exposes

- **Reads (always on):** `whoami`, contacts (list/get), conversations
  (list/get), messages (list), broadcast status.
- **Writes (opt-in):** send a message, create/update a contact.
- **Broadcasts (opt-in):** launch a template broadcast — requires an
  explicit `confirm` and is marked destructive.

## Safety

Because sending WhatsApp messages is a real side effect, the server is
**read-only until you opt in**, layered on top of the API key's own
scopes. Give an assistant a read-only key and read-only config and it
physically cannot send anything. See the
[server README](../mcp-server/README.md) for the full tool list and
safety model.


## Controlled CRM and hybrid policy

See [the Issue #4 contract](copilot-crm.md) for the `copilot:crm` scope,
audited active-session CRM actions, new handoff inputs and explicit verified-answer
hybrid policy. The old `/api/v1/copilot/actions` handoff action is retired; use
the audited `/api/v1/copilot/crm` action. Assistance stays disabled by default.


## Durable inbound work

See [the Issue #5 work protocol](copilot-work.md) for `/api/v1/copilot/work`,
the dedicated `copilot:work` scope and new lease/recovery tools. Queue-owned
reply/CRM/context operations require the returned `work_token`. Human queue
resolution is available only through the human control API and never resends
or reconciles an ambiguous outbox attempt. No resident/local-model worker is
started by these interfaces.
