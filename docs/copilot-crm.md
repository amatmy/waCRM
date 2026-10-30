# Controlled CRM actions and hybrid replies (Issue #4)

This builds on the unmerged PR #10 session foundation and PR #11 guarded
outbox. GitHub Issue #4 and roadmap #9 own delivery status. The copilot works
only during an explicitly active human session. No scheduler, hosted inference
integration, paid AI API, deployment, or real WhatsApp acceptance is included.
Upstream MIT attribution is retained.

## Credentials and authority

A dedicated key must have `copilot:act`; add `copilot:crm` for CRM actions.
Only these and `contacts:read`, `conversations:read`, `messages:read` may be bound
to an operator. An admin binds the key to a current account agent/admin/owner.
The server rechecks the binding, key expiry/revocation/scopes, live role and
account on every operation. Copilot keys cannot use legacy writes or broadcast.
MCP discovery is an interface, never the permission boundary.

Every new CRM mutation requires `conversation_id`, `session_id`,
`ownership_revision`, `inbound_id`, `idempotency_key` (8–128 characters), and a
small action-specific `payload`. IDs, fields and enums are allowlisted. Identity
comes exclusively from authentication. The database transaction locks the
operator, key, session, policy and account-scoped conversation. It checks the
current claim/revision, latest inbound, open/unassigned/unpaused conversation,
enabled policy and session generation. It checks the database clock again after
waiting for a target/deal lock and after the final audit write. Expiry during
foreign-key, trigger or audit waits rolls back the entire action and outcome. Pause, takeover and membership revocation
serialize with these short transactions. Human controls stay available when the
AI session is inactive. CRM actions have no external side effects or customer
messages and do not require an open WhatsApp reply window.

## API and MCP

`POST /api/v1/copilot/crm` requires `copilot:crm` at HTTP auth and both copilot
scopes plus a valid binding inside the service.

| API action | MCP tool                  | Behavior                                                                                                                                                                                                                                                                                                    |
| ---------- | ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `context`  | `get_crm_context`         | Current claim/session/revision required; returns eligible account operators and only this conversation/contact's linked native deals and pipeline stages.                                                                                                                                                   |
| `note`     | `add_internal_note`       | `payload.note`: native `contact_notes` insert attributed to the bound operator; maximum 4,000 characters.                                                                                                                                                                                                   |
| `assign`   | `assign_conversation`     | `payload.operator_id`, `summary`: eligible human in the same account; clears AI claim, pauses AI, cancels unsent outbox work and stores a summary. Cannot steal a human-owned conversation.                                                                                                                 |
| `handoff`  | `handoff_to_human`        | `payload.summary`: assigns the bound operator, clears the claim and pauses AI. Same safeguards as assignment.                                                                                                                                                                                               |
| `status`   | `set_conversation_status` | `payload.status`: open/pending/closed. Leaving open clears authority and cancels unsent work. Reopening cannot revive an old approval.                                                                                                                                                                      |
| `deal`     | `update_linked_deal`      | `payload.deal_id` plus title, stage_id and/or status (open/won/lost). Existing native deal must belong to the account and link to this conversation **and** contact. Stage must belong to its current account pipeline. No value, currency, ownership, pipeline move, creation, deletion or bulk operation. |
| `outcome`  | `get_crm_action_outcome`  | `action_id`: persisted result restricted to this account and key. May be read after pause/takeover; still requires live credentials/role.                                                                                                                                                                   |

Context uses conversation/session/revision only; outcome uses action ID only.
MCP maps flat tool arguments into the API payload. Writes remain opt-in via
`WACRM_COPILOT_MODE=true`, `WACRM_ENABLE_WRITES=true` and the configured operator.
Read-only startup remains the default. No policy curation, approval, session
activation, human takeover, raw send or broadcast tool is exposed to the model.

The previous unaudited `action: handoff` on `/api/v1/copilot/actions` now returns
400 with migration guidance. Its MCP replacement requires the active session,
latest inbound and an idempotency key. Update clients and grant `copilot:crm`
explicitly; existing keys do not acquire this new permission automatically.

## Idempotency and evidence

Successful mutations and their exact request/result are stored atomically in
`copilot_actions`. A key/idempotency pair serializes concurrent calls. Matching
replays return the prior result, including after takeover/pause, without a new
mutation; changed payloads return 409. CRM and reply outbox idempotency are
separate namespaces. Inspection/replay reports what committed at the recorded
time, not a promise that a human has not subsequently changed the resource.
Validation/authorization failures return errors and roll back all CRM writes;
they do not create success audit rows. Unknown network outcomes for replies
remain in the existing outbox, never in the CRM mutation log.

Curated answers are included in the existing team-join data guard so joining
another account cannot silently delete business knowledge.

New public tables use account-member SELECT RLS and explicit grants. Direct
anon/authenticated/service-role writes to policy knowledge or action outcomes
are denied; the server-only database connection performs guarded transactions.
The native inbox/contact/deal tables remain the CRM source of truth. Native
conversation status, contact or account changes now revoke old claims and
approvals as assignment and pause already do. Contact/account changes also clear the latest-inbound pointer, requiring fresh
context after human release. CRM actions explicitly lock and verify that the
conversation contact belongs to the same account. Summaries and message history are
preserved. No history reset or implicit human release is provided to the AI.

## Hybrid reply policy

The migration leaves assistance disabled and `human_approval` as the default.
Only a same-origin authenticated admin/owner can use the human control API:

- `POST /api/copilot/control` with `{action:"policy", enabled:true, mode:"hybrid"}`
  explicitly selects hybrid mode. Omitting mode preserves an existing mode.
- `{action:"verify_answer", answer:{question, answer, source_reference,
expires_at, enabled:true}}` records a human-verified routine business answer.
  Supply a future expiry and an attributable business source. `enabled:false`
  disables that exact question; answer/source/future-expiry remain required.

These are contracts for a later human interface (#7), not a claim that the UI
exists. Do not enable them in production as part of this task. No model may
curate or mark its own facts as verified.

Hybrid auto-authorization requires **all** of:

1. A trusted, text customer inbound in the current account and claim.
2. An exact question match after Unicode NFKC, whitespace normalization and
   English-locale lowercase. No fuzzy matching, semantic retrieval or substring
   matching. Punctuation differences require review.
3. An enabled, unexpired admin-verified answer with a source reference.
4. Byte-for-byte equality between the proposed reply and the curated answer.
5. No conservative risk-marker veto in either question or answer.

Known negotiation/discount, refund/dispute/complaint, uncertainty and requests
for a person are vetoed for automatic authorization. The veto includes English,
Spanish, Portuguese and Korean markers; it is deliberately conservative and is
**not** a universal language/intent classifier. The exact human-curated allowlist
is the authority. Administrators must only register genuinely routine questions
and verified answers; do not register exceptions under euphemisms. Unknown
requests, missing facts, media and proposed text changes stay drafts requiring
human approval or an explicit handoff. A caller-supplied risk/confidence label
cannot authorize a send.

An auto-authorized outbox entry records `authorization_basis=verified_answer`
and its knowledge ID, with no forged human approval. Otherwise the existing
exact-draft human approval is required. The server rechecks policy revision and
knowledge content/expiry at dispatch, including immediately before the bounded
provider call. Knowledge edits and mode/enabled changes bump policy revision,
invalidating previously prepared unsent entries. Disabled/expired knowledge
never silently falls back to automatic approval. The existing one-entry per
inbound rule still applies: stale drafts need human handling, not a new-key
retry. Queue/recovery and richer draft workflows belong to Issue #5.

All Issue #3 eligibility, ownership, session and provider guards still apply.
An authorized provider call cannot be recalled after it starts. Human takeover
or pause may wait for its bounded attempt, and provider delivery may arrive
later; only a successful human-control response confirms the control changed.
Unknown attempts still require human receipt reconciliation and are never resent.

## Validation boundaries

Real PostgreSQL tests use synthetic accounts and an injected fake provider.
MCP tests use a loopback HTTP fixture and actual stdio SDK protocol. They prove
local authorization/transaction contracts, not real Meta delivery, a working
human UI, local-model quality, a durable worker or operational readiness.
