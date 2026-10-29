# Upstream audit — 2026-10-29

Foundation: [ArnasDon/wacrm](https://github.com/ArnasDon/wacrm), pinned at
`3a5b1e7f9f74439d220fd5910463666819d19402`. The fork retains history and the
unmodified MIT license, copyright 2026 Arnas Donauskas. MIT permits modification
and redistribution with its notice preserved; this is a source/license audit,
not a review of WhatsApp/Meta commercial terms.

## Reuse verified in source

| Surface   | Existing implementation                                                              | Implication                                                                         |
| --------- | ------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------- |
| App       | Next.js 16.3.8, React 19, Supabase/Postgres                                          | Extend this stack and CRM database                                                  |
| API       | `src/app/api/v1`, hashed/revocable account-scoped API keys, per-key scopes           | Reuse authentication; every service-role query needs explicit account scoping       |
| MCP       | `mcp-server/src`, SDK stdio, 7 read tools + 3 optional writes + 1 optional broadcast | Extend this server, build locally; registry package does not contain fork additions |
| Reads     | whoami, contact list/get, conversation list/get, messages, broadcast status          | Enough for manual context retrieval                                                 |
| Writes    | send_message, create_contact, update_contact                                         | Raw send is not ownership/session guarded; inappropriate for autonomous copilot     |
| Ownership | conversations.assigned_agent_id                                                      | Reuse native human assignment                                                       |
| Handoff   | ai_autoreply_disabled and ai_handoff_summary; deterministic summary helper           | Reuse fields; add atomic authority transfer rather than parallel ownership truth    |
| AI        | Native OpenAI/Anthropic/OpenAI-compatible providers and optional paid embeddings     | Leave unconfigured; not the selected no-paid-inference copilot runtime              |
| Events    | message.received, conversation.created, message.status_updated                       | Best-effort single-attempt delivery, no durable queue; reconcile stored messages    |

Primary inspected files: `LICENSE`, `package.json`, `docs/public-api.md`,
`docs/mcp.md`, `mcp-server/src/{config,client,index}.ts`, tool registration,
`src/lib/auth/{api-context,account,roles}.ts`, `src/lib/ai/{config,auto-reply,handoff}.ts`,
and account/inbox/AI integrity migrations. Native auto-reply is called from inbound
processing and does not implement this fork's human session contract. Do not
enable it as a substitute for the future copilot worker.

## Missing capabilities tracked in Issues

Human session lifecycle: #2. Atomic ownership, per-send session/policy checks,
handoff, authorization scopes, duplicate/ambiguous-send reconciliation: #3.
Notes, pipeline/status/assignment API/MCP actions: #4. Durable queue and missed
webhook recovery: #5. Actual local model invocation: #6. Human controls: #7.
Real WhatsApp/runtime proof: #8. [Issue #9](https://github.com/amatmy/waCRM/issues/9)
is the source of truth for delivery order and status.

## Runtime evidence boundaries

The first milestone proves the stdio MCP protocol against an explicitly
synthetic local HTTP CRM fixture. No inference API, provider credential, real
customer record, or WhatsApp send participates. This proves the transport and
tool contract, not real WhatsApp delivery, local model quality, ChatGPT/Dot
connection, event-triggered invocation, or unattended writes.

An interactive chat can inspect MCP tools when invoked; the architecture does
not rely on it being a continuously running webhook listener. Selection and
benchmarking of a callable, locally hosted model remains #6. No paid AI API
subscription/key is required by the new session or MCP profile code. Hosting,
hardware, and WhatsApp/provider message costs are separate and not assumed free.

## Implementation references

Supabase's [explicit table grant change](https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically),
[RLS documentation](https://supabase.com/docs/guides/database/postgres/row-level-security),
and [function security guidance](https://supabase.com/docs/guides/database/functions)
informed explicit grants, RLS and separation of privileged functions. The
changelog was checked, including the PostgreSQL minor release notice; this
change introduces no affected ltree, legacy PGP, btree_gist or custom operator use.
The installed Next.js package did not include `dist/docs`; the
[official route-handler reference](https://nextjs.org/docs/app/api-reference/file-conventions/route)
was used as the fallback along with existing route conventions.
