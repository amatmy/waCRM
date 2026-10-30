# Guarded reply ownership and dispatch — Issue #3

This change is stacked on unmerged [PR #10](https://github.com/amatmy/waCRM/pull/10),
foundation `51073f0`. Its branch also includes the execution brief from main at
`d5b8ac7`. Neither PR is merged or deployed by this work. Scope and results live
in [Issue #3](https://github.com/amatmy/waCRM/issues/3) and [roadmap #9](https://github.com/amatmy/waCRM/issues/9).

## Authority and policy

Each API key is bound by an account admin to a current human operator. Keys
must have only `copilot:act` and optional contact/conversation/message read
scopes. The human starts their session through #10's human endpoint. The server
claims a conversation for the key and session generation and returns an
ownership revision plus the latest inbound ID. Native human assignments remain
in `assigned_agent_id`; claim does not overwrite them. Any human assignee,
paused AI flag or closed conversation blocks claim/dispatch.

The initial policy is **human approval**, disabled by default. An admin enables
it explicitly. A model can prepare an immutable outbox draft but cannot approve
it, activate a human, change policy or take a conversation away from a human.
The bound human must review the draft and approve that outbox ID. Policy changes
invalidate old approval. Automatic routine-reply rules belong to #4.

Dispatch checks current key scopes/revocation/expiry, human account membership
and role, active session/generation/expiry, exact owner/revision, newest inbound
ID, open conversation, policy revision and exact human approval. Plain-text
replies also require a connected WhatsApp configuration and a verified inbound
within 24 hours. Historical rows default to unverified: a new trusted inbound
is required. Human-created/imported message rows cannot establish that window.

## Concurrency contract and provider boundary

The dispatcher uses one `pg` connection per transaction. It locks the human
membership, key/binding, session, policy and conversation, rechecks the database
clock after waiting, then holds the locks across one provider request (maximum
10 seconds) and persistence. Native message insert/assignment triggers use the
same conversation row; the human session transition locks the same session.
Human manual sending invokes a guarded human-only RPC **before** its provider
request. Native inbox assignment and human-message persistence also revoke
AI ownership. Customer edits invalidate old context; duplicate webhook inserts
do not replace the pointer with an uninserted UUID.

If takeover/pause/context change wins before dispatch authorization, the reply
is refused, including a model result produced earlier. If provider submission
already started under the locks, takeover/pause waits for that bounded attempt.
After takeover/pause succeeds, no further AI submission can begin under the old
authority. A provider-accepted request cannot be recalled: WhatsApp may deliver
it later, including after a timeout and human takeover. This protocol does not
promise network cancellation or atomic delivery across Postgres and Meta.

## Durable outbox and unknown outcomes

`copilot_outbox` stores the immutable text, key/operator, session, ownership and
policy revisions, inbound ID, idempotency key, approval, attempt time and outcome.
Unique constraints cover key/idempotency and conversation/inbound, so changing
the request key cannot produce a second AI attempt for the same inbound.

States: `draft → approved → dispatching → sent | failed | unknown`.
Ownership changes cancel drafts/approved entries and quarantine a dispatch latch
as unknown. The `dispatching` latch commits before the provider transaction, so
a process/connection failure cannot roll it back and authorize a duplicate.
The second transaction rechecks everything before submission. A crash in the
small gap may leave an unsent latch; safety favors an unresolved record over a
duplicate. No automatic retry or reset-to-approved operation exists.

HTTP 4xx is terminal rejected; timeouts, HTTP 5xx, malformed success and uncertain
database completion are indeterminate. Inspect the stored outcome rather than
preparing a new request. If the database is unavailable, a committed dispatch
latch remains sufficient to prevent replay after recovery.

For reconciliation, the human explicitly links the unknown outbox entry to a
provider message ID observed in the provider logs. The server requires a status
receipt for that ID/account already stored by the existing signature-verified
Meta webhook in `pending_message_statuses`. A human is responsible for matching
the receipt to the correct attempted message; account receipt presence alone
does not prove content correlation. Reconciliation persists the result/history
and records the human and timestamp; it never resends. No receipt or expired
receipt retention means the outcome stays quarantined. Automatic correlation,
background reconciliation and queue recovery remain #5; real-provider proof is
#8. `sent` records provider acceptance, not guaranteed customer delivery.

## Deliberate compatibility changes

- `POST /api/v1/messages` and `POST /api/v1/broadcasts` reject every machine key,
  including legacy send-capable keys. The server cannot infer whether a bearer
  key is being driven by a model, so raw machine sends are unavailable in this
  fork. Read APIs and legacy MCP tool discovery remain compatible; raw sending
  through those discovered tools receives a server denial.
- Dedicated copilot keys cannot use other legacy write/broadcast capabilities.
- Native provider-based AI autoreply is disabled before any inference or send.
  The legacy flow text sender rejects `aiGenerated: true`. Deterministic flows
  retain their existing behavior and are not the AI copilot runtime.
- Manual human sending requires the new migration's takeover RPC; missing
  migrations fail closed. It does not need the new direct-Postgres environment
  variable. Copilot APIs do need that connection, and fail unavailable without it.
- Human takeover/handoff preserves history and handoff summary; pause/expiry
  leaves records intact. An explicit human release clears the paused flag and
  assignment before a new AI claim. Old outbox/session approvals cannot be reused.

## Server setup and API contract

Apply the foundation and guarded-dispatch migrations to a test instance first.
Configure `COPILOT_DATABASE_URL` as a **server-only** privileged Postgres URL for
this same CRM database. Use a direct or session-pooler connection with proper
TLS verification; never expose it to the browser/MCP host or configure it as a
`NEXT_PUBLIC_` variable. `pg@8.23.1` is the only new runtime dependency. The pool
is bounded to four connections; locks time out after five seconds and the
provider attempt after ten. This feature introduces no inference API or model.

Human control: cookie authentication, agent+ (admin for policy/binding), same
origin `Origin` header, rate limited. `POST /api/copilot/control` actions:

| Action      | Body fields                        | Effect                                                                |
| ----------- | ---------------------------------- | --------------------------------------------------------------------- |
| `policy`    | `enabled` boolean                  | Admin sets human-approval policy and advances revision                |
| `bind`      | `key_id`, optional `operator_id`   | Admin binds a dedicated key to an account operator (default self)     |
| `approve`   | `outbox_id`                        | Bound human approves immutable draft                                  |
| `takeover`  | `conversation_id`                  | Assign to caller and revoke AI authority                              |
| `release`   | `conversation_id`                  | Explicitly release human assignment/pause; claim is a separate action |
| `reconcile` | `outbox_id`, `provider_message_id` | Human links an indeterminate attempt to a stored verified receipt     |

Machine control: `POST /api/v1/copilot/actions`, API key with `copilot:act`:

| Action     | Body fields                                                                                                                   |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `claim`    | `conversation_id`, `session_id`                                                                                               |
| `prepare`  | claim fields plus `ownership_revision` (decimal string), `inbound_id`, `idempotency_key` (8–128 chars), `text` (1–4096 chars) |
| `inspect`  | `outbox_id`                                                                                                                   |
| `dispatch` | `outbox_id`                                                                                                                   |
| `handoff`  | `conversation_id`, `ownership_revision`, `summary` (1–2000 chars)                                                             |

Responses use `{data: ...}` / `{error: {code,message}}` and are not cached on
success. A conflict is HTTP 409; denied authority is 403. Inspect `state`:
HTTP success does not imply a reply was sent (draft/unknown may be returned).
No body may substitute account/key/operator identity for authenticated context.

Existing MCP: `WACRM_COPILOT_MODE=true`, `WACRM_OPERATOR_ID=<bound operator>`,
`WACRM_ENABLE_WRITES=true`, and a dedicated key. Read-only mode is still default.
The guarded tools are `claim_conversation`, `prepare_authorized_reply`,
`get_reply_outcome`, `send_authorized_reply` and `handoff_to_human`. No human
approval/session-start/policy or broadcast tool is exposed. Build from this
fork; the upstream published package does not include these changes.

## Verification boundaries

Run app tests/types/lint/build and the MCP tests. For real SQL/RLS/concurrency
tests against a disposable loopback database with all migrations applied:

```sh
COPILOT_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
  npm test -- src/lib/copilot/service.integration.test.ts --maxWorkers=1
```

These tests inject a synthetic provider and never contact Meta. They create and
remove random fixture accounts. The Migrations workflow replays all migrations,
runs schema/session SQL checks and these real-database race tests. The ordinary
unit suite skips this database file when no explicit test URL is set. UI,
production credentials, model invocation, actual Meta delivery and live human
handoff are not established by fixture/CI success and remain their roadmap gates.
