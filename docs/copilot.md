# Human-active-session copilot

Scope and acceptance status live in [GitHub Issues](https://github.com/amatmy/waCRM/issues/9).
This document describes the implementation and its boundaries.

## Architecture

WhatsApp → existing CRM ingestion/database → durable pending work (planned) →
active operator session → callable local runtime (planned) → extended existing
MCP → server-enforced policy/ownership/outbox dispatch or human handoff (implemented in the guarded-dispatch review branch).

The human explicitly starts assistance while working and pauses when finished.
A short heartbeat lease detects a lost client; it is not a shift schedule.
Pause and lease expiry preserve CRM conversations and pending work rather than
assigning everything to a human. Human takeover is a separate atomic operation.

Hybrid policy will allow verified routine replies. Negotiation, complaints,
refunds/disputes, uncertainty and requests for a person require human approval
or handoff. The server must enforce this independently of the model. Customer
messages and retrieved documents are untrusted input, never tool authorization.

## Implemented foundation

`copilot_sessions` stores one current session per account/operator. PostgreSQL
sets a 90-second lease. Start rotates a random session ID; heartbeat and pause
must supply that ID. A stale tab cannot pause/renew a newer session. Paused or
expired sessions require explicit start; heartbeat cannot resurrect them.
Database transactions serialize changes and lock membership during transitions.
Status checks invalidate downgraded, removed, or moved operators immediately.
The lease is evidence of recent human activity, not proof a human remains at
the keyboard. Future UI must stop renewing on inactivity/disconnect.

Only an authenticated human at agent role or above can transition their own
session. A private, guarded definer function handles writes; exposed wrappers
are security invokers. Direct table writes and anonymous access are revoked.
RLS restricts human reads to their own session. Service-role reads are available
only through account-filtered API calls. Operator ID is configured by the MCP
host, not supplied as model tool input. **Session active does not grant send
authority.** Guarded human-approved dispatch and explicit handoff are described in [the dispatch contract](copilot-dispatch.md).

### Human endpoint

`GET /api/copilot/session` reads the signed-in human's status.
`POST /api/copilot/session` uses the CRM's authenticated cookies, a same-origin
`Origin` header, and a JSON body:

```json
{ "action": "start" }
```

Save the returned `data.session_id`. While the human is active, the future UI
will renew about every 30 seconds (the lease expires at 90 seconds):

```json
{ "action": "heartbeat", "session_id": "<returned UUID>" }
```

Pause explicitly with `action: "pause"` and the same session ID. Invalid body
returns 400; wrong origin/role returns 403; stale/expired heartbeat returns 409.
Successful status and transition responses are `Cache-Control: no-store`.
The first milestone exposes this backend contract; the inbox controls are #7.

### Machine endpoint and existing MCP extension

`GET /api/v1/copilot/session?operator_id=<UUID>` requires `conversations:read`.
It scopes the RPC by the API key's account. Response data has `state` of
`inactive`, `active`, `paused`, or `expired`. No machine activation route exists.

Build the fork's MCP rather than installing the upstream published package:

```sh
cd mcp-server
npm ci
npm run build
```

An MCP host that supports local stdio servers can launch:

```json
{
  "mcpServers": {
    "wacrm-copilot": {
      "command": "node",
      "args": ["/absolute/path/to/waCRM/mcp-server/dist/index.js"],
      "env": {
        "WACRM_BASE_URL": "https://your-crm.example.com",
        "WACRM_API_KEY": "<read-only CRM API key>",
        "WACRM_COPILOT_MODE": "true",
        "WACRM_OPERATOR_ID": "<human auth user UUID>"
      }
    }
  }
}
```

Grant only `contacts:read`, `conversations:read`, and `messages:read` to this key.
Do not grant legacy send/write/broadcast scopes. For guarded replies add `copilot:act` and follow [the dispatch setup](copilot-dispatch.md). This adds `get_copilot_session` to the
existing read tools. Existing CRM reads remain available when paused. With `WACRM_ENABLE_WRITES=true`, copilot mode exposes only guarded outbox/claim/handoff tools. Broadcast flags are rejected. The server also rejects raw machine sends and broadcasts, including from legacy keys; see the dispatch contract for this deliberate compatibility change.

## Verification

```sh
npm ci
npm run typecheck
npm run lint
npm test
cd mcp-server
npm ci
npm run typecheck
npm test
```

In a disposable local Supabase database, replay migrations using the upstream
Migrations workflow, then run `supabase/ci/verify-schema.sql` and
`supabase/ci/copilot-sessions.sql`. The latter uses synthetic users and rolls
back all test data. CI now runs it and the MCP protocol tests. Real WhatsApp
and chosen-runtime acceptance remain #8; deployment is not part of this PR.

Keep upstream native AI settings unconfigured: those paths use provider APIs
; native automatic provider dispatch is disabled in this fork. This foundation introduces no model
dependency, key, provider call, scheduler, or listener.
