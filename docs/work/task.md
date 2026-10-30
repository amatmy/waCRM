# Next Work Task — Issue #6: Callable local inference during human activity

Repository: `amatmy/waCRM`. Read `AGENTS.md`, roadmap
https://github.com/amatmy/waCRM/issues/9, Issue #6
https://github.com/amatmy/waCRM/issues/6 and current comments before starting.
This is the next separately initiated task. The Issue #5 run stops at its PR,
validation and GitHub reporting; it does not start #6. GitHub Issues/PRs own scope,
decisions, blockers and verified outcomes.

## Verify dependencies first

PRs #10 (sessions), #11 (guarded replies), #12 (controlled CRM/hybrid) and the
Issue #5 PR on `feat/issue-5-durable-inbound` form a review stack. Base of #5 is
PR #12 head `d0b2873b72059cfeaeda7df2afb213b27ebf1c64` at implementation start.
Read the live PR state and exact heads; all were unmerged during #5. Do not infer
merge from green checks, and do not merge/deploy without separate user approval.
Use an isolated branch based on the correct dependency head and document it on #6.
Preserve upstream MIT attribution/history.

Read `docs/copilot.md`, `docs/copilot-dispatch.md`, `docs/copilot-crm.md`,
`docs/copilot-work.md`, `docs/work/issue-5-results.md`, migrations and tests.
The inherited dependency audit still flags critical Next.js and other app/MCP
advisories; the five inherited local DB security warnings also remain. These are
release blockers tracked in #1/#9, not permission for unrelated upgrades during #6.

## Objective when the user starts #6

Evaluate a locally hosted model/runtime on the actual available hardware. Verify
license, supported invocation, resource use and latency using primary sources
and actual local tests. No paid inference APIs, browser automation of consumer
chat, or assumption that ChatGPT/Dot is a continuous webhook listener. Interactive
MCP clients remain interactive until an invoked runtime and writes are proven.
Do not install/download an arbitrary large model without checking hardware,
license and the task's resource constraints first.

Implement the local processor and REST/MCP adapter for the existing callable
`runWorkCycle`/work protocol, keeping credentials and lease capabilities outside
model-generated authority. Prove stored inbound → local decision → server-guarded
reply or human handoff during an explicitly active human session. Use bounded,
callable cycles while the human is working, with explicit lease renewal if needed;
no scheduled AI shifts or requirement for 24/7 execution. Do not auto-start or
renew a human session from a worker/model. UI heartbeat/presence remains #7.

Treat customer messages and retrieved documents as untrusted data. Use verified
business sources and preserve the exact server-authorized hybrid policy; the model
cannot mark its own knowledge verified, approve replies, substitute identities or
override permissions. Negotiation/refund/dispute/uncertainty and requests for a
person require human approval/handoff. Never add raw-send/broadcast bypasses.

## Recovery and safety contracts to retain

- Queue claims mint token/revision generations and cap worker leases by human
  expiry. Supply the current `work_token` to all queued reply/CRM/context actions;
  delayed/cancelled model results must fail after expiry/restart/takeover/new inbound.
- The trusted ingestion-completion marker gates all AI processing after native
  flow/automation handling. Incomplete historical/interrupted ingress requires
  explicit human review; do not guess readiness or replay native effects.
- Canonical DB storage and bounded REST reconciliation own pending work; best-effort
  fan-out is only a wake-up hint. Raw envelopes lost before CRM storage remain an
  upstream ingress limitation, not something REST can reconstruct.
- The outbox/action log remain authoritative. Never retry/recreate unknown or
  dispatching provider attempts. An already-submitted request cannot be recalled.
- One immutable outbox per inbound remains. Recovery of stale drafts goes to a
  human; no automatic replacement/reapproval. Human `resolve_work` records an
  explicit task-resolution attestation, not delivery or provider reconciliation.
- `runWorkCycle` provides a bounded injected-processor seam, not an already running
  local model/worker host. A host waiting for approval must renew a still-live
  lease while the human remains active, otherwise use the conservative human path.

## Tests and delivery

Use stored synthetic messages and fake WhatsApp transport only. Test local model
availability/failure/timeout, prompt injection and unknown knowledge, active/pause/
restart, two workers, delayed results, key/role revocation, tenant isolation and
human takeover. Distinguish actual local-model evidence from injected/mocked tests.
Run full application/MCP tests, types/lint/build, clean migrations, SQL/RLS and
real local Postgres races; record exact commands/counts and CI links in #6/#9 and
all affected dependency issues. No real WhatsApp message, paid API, deployment or
merge. Do not implement the human UI (#7) or live acceptance (#8) as part of #6.
Open and attach a PR, document outcomes and limits, update this brief for the next
task, stop at #6, and preserve unrelated local containers/data.
