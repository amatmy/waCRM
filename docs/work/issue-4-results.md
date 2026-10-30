# Issue #4 implementation and review evidence

Scope: https://github.com/amatmy/waCRM/issues/4. Roadmap #9 is authoritative.
Branch: `feat/issue-4-controlled-crm`, based on unmerged PR #11 head
`ea9057373c18745a8368c64ce61213ef4c15a5a5`, itself based on unmerged PR #10 head
`51073f036860c04d5ddd19a2be81348407ed0350`. No merges were performed.

## Dependency review

COMMENT reviews recorded on PRs #10 and #11; neither is merge approval.
PR #10 had no new actionable finding in the reviewed session/auth scope.
Both exact heads have successful existing app and migration CI checks.

PR #11 had a status-change authority gap: native close/reopen could preserve an
old claim/approval. The Issue #4 migration revokes authority on status changes,
and also contact/account changes, and pauses AI when leaving open. A real-DB
regression covers native human close/reopen. Dispatch also now repeats all
clock/eligibility checks after waiting for contact/config locks, before provider
submission; a regression covers lease expiry during that wait. Existing bounded
provider-request and indeterminate-outcome limitations remain unchanged.

## Changes

- Dedicated `copilot:crm` scope, live account/operator/key guards, strict payloads.
- Native internal notes, human assignment/handoff, conversation status, and
  limited linked deal updates (no monetary, ownership or bulk mutations).
- Transactional action results and idempotent concurrent/replayed calls; account
  SELECT RLS and explicit denial of direct writes to new control/audit tables.
- Hybrid verified answers: human-admin curation with source/expiry, exact text
  matching and conservative risk veto, policy revision invalidation and final
  dispatch rechecks. Disabled by default; no inference API or model safety claim.
- MCP context/action/outcome tools; no approval/activation/policy/broadcast tool.
- Old unaudited handoff endpoint retired with 400 migration guidance; update
  clients to the audited session/revision/inbound/idempotency contract.
- Next task brief updated for Issue #5, which has not been started.

See `docs/copilot-crm.md` for endpoint, permission and policy details and limits.

## Validation

Local clean full migration replay, verify-schema.sql, copilot-sessions.sql and
copilot-crm.sql passed on the disposable `wacrm` database. Broader application,
real Postgres/synthetic provider, MCP, type/lint/build checks are in progress;
this report will be finalized with exact results and CI links before handoff.

No paid inference, real Meta/WhatsApp messages, production policy activation,
deployment or merge. Synthetic/local evidence is not live product acceptance.
