# Durable inbound work and recovery — Issue #5

Delivery status is in [Issue #5](https://github.com/amatmy/waCRM/issues/5) and
[roadmap #9](https://github.com/amatmy/waCRM/issues/9). This builds on unmerged
PRs #10–#12, preserving the existing session, ownership, outbox and CRM guards.
Issue #6 adds a separately invoked local inference adapter (`docs/copilot-runtime.md`). No resident worker, deployment or real WhatsApp acceptance
is included. The human has no scheduled AI shift or 24/7 obligation.

## Storage and notification boundary

A private AFTER trigger journals every trusted persisted customer message with
an actual `wamid.` identifier into `copilot_work`, in the **same transaction** as
canonical message storage. Rollback leaves neither message nor job. Queueing is
independent of policy enablement and human activity; paused arrivals stay stored.
Human-created customer rows cannot forge the server-controlled verification
marker or ingestion-completion flags. Reaction updates are not messages and create no work.

Unique account/provider-message-ID and source-row constraints deduplicate
replays. The same provider ID in another account is independent. Only the current
canonical inbound with completed ingestion is claimable; newer inbound supersedes older pending/leased
work. Source edits/deletion invalidate unfinished work while retaining its IDs
and attempt history. No customer text is duplicated into the queue journal.

Existing `message.received` fan-out remains best-effort. Workers call the REST
reconciliation operation against canonical CRM storage, then poll/claim stored
work rather than trusting event payloads as authority. Reconciliation inserts up
to 100 missing trusted rows per call. Repeat while `more_possible`; later cycles
catch new commits. It uses account-scoped anti-joins on provider ID **and** source
ID, not a timestamp high-water mark, so late/backdated rows are not skipped and
edited-source tombstones cannot starve recovery. Busy conversations are skipped
instead of blocking human operations. Repeated calls are idempotent.

The signature-verified backend records `copilot_ingress_completed` only after
its awaited native flow/automation phase. A service-role-only RPC finalizes that
record; human JWTs and copilot API keys cannot call it or forge its fields. Work
consumed by native flows/automation replies/interactive handling is terminal with
`outcome.type=native_consumed`, meaning no additional copilot work, not delivery
confirmation. Other native human/bot responses put work in human review to avoid
an extra queued answer. Copilot outbox persistence is identified separately.
Even ordinary claim/reply/CRM APIs reject incomplete or already-handled canonical
ingress, so native-consumed/human-handled work cannot be reopened through a
nonqueue tool.

Reconciliation uses this durable completion marker, never elapsed time or a lost
notification as proof of readiness. Interrupted and pre-migration messages without
that marker remain pending/not ready for explicit human review; native processing
is not automatically replayed. Human resolution may close incomplete-ingress work.
Late finalization cannot overwrite a completed human-resolution record.

This repairs missed **post-storage** notification/queue gaps. The upstream Meta
handler still acknowledges before its `after()` storage pipeline completes.
Native automation transport failures still use their upstream semantics; this
change does not give every legacy sender a transactional outbox. Payloads lost
before any CRM message was committed cannot be reconstructed from
REST; raw webhook-envelope durability and real Meta acceptance are not claimed.

## Worker authority and leases

A dedicated bound key needs `copilot:act`, new `copilot:work`, `messages:read` and
`conversations:read`. Add `copilot:crm` only for CRM actions. Binding remains
admin-only. Existing keys do not acquire the new scope automatically. Copilot
credentials cannot use legacy writes/broadcasts, even if their scopes are edited.

Claim requires the current human generation, current operator role/account/key,
enabled policy, open/unassigned/unpaused conversation, same-account contact,
current verified inbound and a claimable durable row. Conversation row locking
with `SKIP LOCKED` permits concurrent workers on separate conversations and
prevents double claim of one conversation. An ordinary nonqueue AI claim is not
stolen; a human must explicitly release it if abandoned.

Every acquisition mints a new random `lease_token`, advances conversation
ownership revision, and appends `copilot_work_attempts`. The lease lasts at most
30 seconds and is capped by the human session expiry. Renewal requires the
still-live original token; an expired lease cannot be resurrected. Restart or
replacement human generation uses a fresh claim/token/revision. Attempt records
retain acquisition/expiry/end information; no process memory is authoritative.
Inspection deliberately omits replacement lease capabilities.

Queue claims set protected `copilot_work_id`/`copilot_work_token` on the existing
conversation. **All queued reply preparation, exact human approval, dispatch and
CRM paths check work authority inside the server**, including the pre-existing
nonqueue routes. Prepare and CRM tools accept optional `work_token`; it is
mandatory when queue-owned. Outbox entries retain their immutable work token.
A worker cannot omit the token, use a raw send or reacquire through the generic
claim endpoint to bypass its expired generation. Read-only CRM context also
requires the token when queue-owned. Replays of committed idempotent results
remain inspection only, not new mutations.

Processing checks current key/role/session, ownership revision, latest inbound,
policy revision, lease token/state and both lease clocks. Contact/config waits
are followed by final dispatch checks. Reply and CRM writes check clocks again
after their final database writes; expiry rolls back late proposals/actions.
Native takeover, assignment, pause flags, conversation status/contact changes,
and customer edits retain the #3/#4 fences. Human session pause blocks new work
and actions without erasing the journal. Explicit restart/release is required;
queue leases never renew or activate a human session.

A provider request already submitted under valid authority cannot be recalled.
It may complete after worker/human expiry; later recovery consults the durable
outbox rather than resending. The existing bounded request and unknown-outcome
quarantine contract in [copilot-dispatch.md](copilot-dispatch.md) still applies.

## Callable REST and MCP protocol

`POST /api/v1/copilot/work` requires `copilot:work`; the service additionally
checks the bound operator and read scopes. All responses are uncached.

| Action      | Input beyond `action`   | MCP tool                  | Result                                                                                                                                                                                 |
| ----------- | ----------------------- | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `reconcile` | none                    | `reconcile_inbound_work`  | Bounded canonical repair; allowed during pause, with live credentials/role. No processing authority granted.                                                                           |
| `claim`     | `session_id`            | `claim_next_inbound_work` | One lease plus canonical message context, null if none eligible, or an existing terminal/human-review outcome.                                                                         |
| `inspect`   | `work_id`               | `get_inbound_work`        | Durable state and canonical outbox ID/state, without a new worker's secret capability. Allowed after pause.                                                                            |
| `renew`     | `work_id`, `work_token` | `renew_inbound_work`      | Bounded extension; never revives expired/replaced work.                                                                                                                                |
| `release`   | `work_id`, `work_token` | `release_inbound_work`    | Unfinished/no-outbox work returns to pending; existing drafts/attempts require human handling. Clears claim and rotates authority.                                                     |
| `settle`    | `work_id`, `work_token` | `settle_inbound_work`     | Uses only the stored outbox outcome. Draft/approved waits for human approval; sent completes; unknown/failed/cancelled/dispatching requires a human. No caller-supplied success value. |

Work tools are exposed only with copilot mode and explicit write opt-in. Read-only
startup is unchanged. No human resolution, approval, policy, start-session or
broadcast tool exists. MCP transports the capability; it does not authorize it.
Use `work_token` on existing `prepare_authorized_reply`, CRM tools and CRM-context
reads for queue-owned conversations. `send_authorized_reply` uses its outbox's
stored token and rechecks it at the actual provider boundary.

## Recovery and human resolution

Lifecycle: `pending → leased → completed | awaiting_human`; release/expiry without
an outbox permits another generation. Superseded/invalidated work is not processed.
An expired lease with a durable sent result completes from that result. No memory
checkpoint, model confidence or HTTP success alone proves a customer reply.

The original one-outbox-entry-per-inbound fence remains. If a draft/approval is
stale when a new worker/session takes over, recovery cancels/retires its authority
and marks the work `awaiting_human`. It does **not** rebase, replace, automatically
approve or retry the immutable entry. A human can send manually using existing
human controls. Unknown/dispatching attempts retain their original quarantine;
provider receipt reconciliation remains a separate explicit human operation.

A same-origin human agent/admin/owner can record an explicit resolution:

```json
{
  "action": "resolve_work",
  "work_id": "<UUID>",
  "summary": "How the operator handled the pending task"
}
```

Send this to `POST /api/copilot/control`, never the machine endpoint. Only
`awaiting_human` or pending/not-ready ingress work can be resolved. The operation revokes current AI authority,
pauses/assigns the conversation to a human without replacing another human
assignee, and stores `outcome.type=human_resolution`, human ID, summary, time and
outbox snapshot. Identical replays return the same record; history cannot be
rewritten. This is **human attestation of task resolution**, not proof of delivery
and not provider-outcome reconciliation. It never edits/resets/resends an unknown
outbox entry. The next inbound is still subject to human ownership/release.

## Callable cycle and explicit local host

`src/lib/copilot/worker.ts` exports `runWorkCycle(client, sessionId, propose)`.
It reconciles/claims one job and invokes a host-supplied proposal function with
only frozen canonical message context and an AbortSignal. Authority is captured
separately; a proposal cannot change account, conversation, revision or token.
Processing is bounded to at most 20 seconds, shortened by the returned lease.
Timeout/failure aborts and attempts safe release; if connectivity is lost, server
leases and outbox fences remain sufficient for recovery.

Only an exact server-verified hybrid answer can dispatch automatically. Other
drafts wait for exact human approval. A host handling longer processing or human
approval must explicitly renew the still-live work lease while human activity
continues. Without renewal, stale drafts require the conservative human path.
The callable cycle does not launch a daemon, activate a session, select/download
a model, call inference APIs or assume a connected chat is a listener. The Issue #6 one-shot runtime/MCP adapter is documented in
`docs/copilot-runtime.md`; human UI is #7.

## Access and evidence

Both new public tables have account-member SELECT RLS and explicit grants. Direct
anon/authenticated/service-role writes are denied. Internal trigger functions
live in the private schema, have fixed empty search paths and no direct execution
grants. The separate ingress-completion invoker wrapper/private implementation
has explicit service-role-only execution and validates that backend role; no
human identity exists on the signed webhook path. The existing protected server connection performs guarded transactions.
Work metadata has mandatory conversation/parent dependencies; account team-join
domain-data safeguards already cover its canonical conversations.

Verification uses synthetic accounts/messages, a real disposable loopback
Postgres, fake provider, actual MCP stdio/SDK fixtures and an injected synthetic
proposal function. This is not live Meta delivery or local-model quality evidence.
Commands/results and remaining release blockers are in `docs/work/issue-5-results.md`.

Issue #6 extends work with `knowledge` / MCP `get_verified_reply_context`. It takes
`work_id` and `work_token`, enforces the complete active-generation guard, and
returns only current exact verified knowledge and its human source reference. It
does not approve or curate answers. Audited queued handoff/assignment atomically
records `awaiting_human` and closes the attempt.
