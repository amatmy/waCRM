# Next Work Task — Issue #7: Human inbox controls and immediate takeover

Repository: `amatmy/waCRM`. Read `AGENTS.md`, roadmap
https://github.com/amatmy/waCRM/issues/9, Issue #7
https://github.com/amatmy/waCRM/issues/7 and their current comments first.
This is a **separately initiated** next task. The Issue #6 run stops at its PR,
validation and GitHub reporting; it must not start #7. GitHub Issues/PRs own
scope, decisions, blockers and verified outcomes.

## Verify the review stack

Read live PR state and exact heads for #10 (sessions), #11 (guarded replies),
#12 (CRM/hybrid), #13 (durable inbound), and the Issue #6 PR from
`feat/issue-6-local-runtime`, based on #13 head
`2e2b1fa8ac991a45641dc18a7e9c10b8db3e1f29` at implementation start.
They were open/unmerged during #6. Use an isolated branch from the correct
current dependency head and document that base on #7. Do not infer a merge from
passing checks. Do not merge or deploy without separate explicit user approval.
Preserve upstream MIT attribution/history.

Read `docs/copilot.md`, `docs/copilot-dispatch.md`, `docs/copilot-crm.md`,
`docs/copilot-work.md`, `docs/copilot-runtime.md`, `docs/work/issue-6-results.md`,
the model evaluation JSON, current API routes, migrations and tests.
Read the installed Next.js guides required by `AGENTS.md` before writing code.

## Issue #7 objective only when the user starts it

Implement human-facing Start assistance / Pause, activity-based heartbeat,
current lease status, AI/human conversation state and immediate takeover.
Opening the app, a background tab, an AI worker or a scheduled clock must never
activate/renew a human session. Assistance exists while an explicitly consenting
human is working, with no scheduled shifts or 24/7 requirement.

Use the existing authenticated human control APIs and server guards. Handle
multiple tabs/replacement generations, idle/background states, loss of
connectivity and expired sessions conservatively. Show acknowledged server state;
a pending or failed takeover/pause is not confirmation. Never make a human
heartbeat from the model/worker, infer permission from app presence alone or
expose server keys/work capabilities to browser/model code.

Preserve unfinished work on pause. Distinguish pending work, a live worker lease,
an immutable draft waiting for approval, audited handoff, ambiguous provider
attempt and completed task/delivery. Human queue resolution is an attestation,
not provider reconciliation. Do not retry/recreate unknown or dispatching attempts
or replace stale immutable outboxes automatically. Already-submitted provider
requests cannot be recalled. Do not claim the one-shot local host is an always-on
listener; a UI-triggered runtime integration needs an explicitly scoped design,
server-only credentials and bounded invocation, never consumer-chat automation.

## Contracts to retain

- Exact account/key/operator/session/inbound/ownership/work generations fence
  all reads, replies and CRM actions. Final server checks reject stale results.
- Only exact human-curated unexpired knowledge can auto-authorize hybrid replies;
  missing/risky/uncertain knowledge and requests for a person require human handling.
  Customer and source text remain untrusted. No raw send/broadcast bypasses.
- Local runtime is `llama.cpp` with pinned Qwen3-0.6B Q8_0, loopback-only, offline,
  bounded one-shot cycles. Model decisions contain no generated authority.
  Tiny synthetic hardware evidence is not general model or production acceptance.
- Trusted ingestion completion gates processing after native handling. Incomplete
  historical ingress needs a human; do not replay native effects or invent readiness.
- Canonical storage and bounded reconciliation own work, not wake-up notifications.
  Envelopes lost before CRM storage remain an upstream ingress limitation.
- Audited handoff checkpoints awaiting-human work and closes the attempt atomically.
  One-shot host releases an unapproved draft for conservative human recovery rather
  than claiming it can wait/renew indefinitely.

## Validation and stop rule

Use synthetic stored messages/fake WhatsApp transport and disposable loopback
Postgres only. No paid AI API, real WhatsApp message, deployment, merge or live
acceptance (#8). Do not download a larger model or modify unrelated running apps.
The #6 evaluation had high memory/swap and low disk headroom; portable inference
artifacts are outside source control and no resident service is installed.

Test visible human controls, role/tenant boundaries, explicit consent, pause,
activity/idle/connectivity transitions, multiple tabs/replaced generations,
takeover acknowledgements and preservation of unfinished/unknown work. Run
relevant UI checks plus complete app/MCP/type/lint/build and local database/race/
SQL/RLS checks. CI's database workflow builds MCP and includes the deterministic
runtime adapter suite; actual-model hardware evaluation is separately opt-in.
Record exact commands/counts, tested head, CI links, fixes, residual risks and
review-stack state in #7/#9 and all affected dependency issues. Open and attach a
reviewable PR, document results, update this file for the separately initiated
next task, then **STOP after #7**.

Inherited release blockers remain: application/MCP dependency advisories
(including critical Next.js), five local DB security warnings, existing lint
warnings, and outstanding live acceptance. These are tracked in #1/#9; no unrelated
upgrade or release is implicitly authorized by a successful local test.
