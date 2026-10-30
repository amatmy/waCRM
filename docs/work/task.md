# Next Work Task — Issue #5: Durable inbound queue and active-session recovery

## Source of truth and authorization

Repository: `amatmy/waCRM`. Read `AGENTS.md`, roadmap
https://github.com/amatmy/waCRM/issues/9, Issue #5
https://github.com/amatmy/waCRM/issues/5, and their current comments before work.
This brief is a handoff, **not authorization to begin #5**. The Issue #4 run
stops after review, implementation, testing, PR publication and GitHub reporting.
GitHub Issues/PRs own decisions, delivery status and blockers.

## Dependencies to verify before coding

- PR #10: https://github.com/amatmy/waCRM/pull/10 — human sessions, head
  `51073f036860c04d5ddd19a2be81348407ed0350` at the Issue #4 review.
- PR #11: https://github.com/amatmy/waCRM/pull/11 — guarded replies/outbox, head
  `ea9057373c18745a8368c64ce61213ef4c15a5a5` at the Issue #4 review; based on #10.
- PR #12: https://github.com/amatmy/waCRM/pull/12 — Issue #4 branch
  `feat/issue-4-controlled-crm`, based on #11. Consult this PR and
  `docs/work/issue-4-results.md` for exact tested head and CI evidence.
- All remain unmerged unless GitHub now proves otherwise. Do not infer merge
  from green checks or merge any dependency without explicit user approval.
  Create an isolated branch from the correct dependency head and document the
  base on Issue #5. Preserve upstream MIT attribution/history.

The Issue #4 dependency audit reports 13 inherited application advisories
(including critical Next.js) and 7 MCP advisories. They remain release blockers
tracked with the audit evidence in Issues #1/#4/#9; no dependency upgrades were
performed during #4. Do not treat green tests as security or deployment approval.

Read `docs/copilot.md`, `docs/copilot-dispatch.md`, `docs/copilot-crm.md`, the
actual ingress/webhook and event-delivery code, and all copilot migrations/tests.
Issue #4 fences status/contact/account edits and rechecks dispatch eligibility
after contact/config lock waits; retain these fixes when rebasing the stack.

## Authorized scope when the user starts #5

Persist inbound work in the CRM database, deduplicate provider message IDs,
claim work with bounded worker leases, preserve pending work during pause, and
recover after crashes/restarts. Existing upstream outbound webhook deliveries
are best-effort single attempts: reconcile account-scoped REST reads so missed
notifications do not lose inbound work. A ChatGPT session is not a webhook
listener. No independent scheduled AI shifts or 24/7 requirement.

Every processing/dispatch step must enforce the current human session,
operator/key membership, conversation ownership revision and current inbound.
Paused arrivals remain pending. Never replay stale results into a human-owned
conversation or claim work through a replaced human session. Keep the existing
outbox and action log as authoritative outcomes; queue leases must not become a
second send-authorization system. Preserve audit history and handoff summaries.

Unknown/dispatching provider attempts must be reconciled, never blindly retried
or recreated under a fresh key. One outbox entry per inbound currently prevents
replacement drafts after policy/context changes. Define a reviewable human-only
resolution contract if needed; do not silently remove the duplicate-send fence.
Reply authorization is either exact human approval or the server-verified,
unexpired exact-match business answer in explicit hybrid mode. Policy/rule edits
invalidate old unsent authorizations. AI cannot curate business knowledge.

## Acceptance and evidence

Test restarts, missed/duplicate events, lease expiry, two concurrent workers,
arrivals during pause, explicit resume/new generation, delayed model/provider
results, takeover/role/key revocation, and tenant isolation. All processing must
be safe with synthetic messages and an injected fake provider. Run relevant
route/MCP tests, complete application tests, typecheck, lint, production build,
a clean full migration replay, SQL/RLS checks and real local Postgres races.
Record exact commands, counts, failures/fixes and CI run URLs in Issue #5 and
roadmap #9; update affected dependency issues with results and limitations.

## Boundaries and completion

No paid AI APIs, real WhatsApp messages, deployment or merge. Do not implement
local inference (#6), UI (#7), or real provider acceptance (#8) as part of #5.
Only disposable local infrastructure may be mutated; preserve unrelated local
containers/data. Open and attach a reviewable PR with explicit dependencies,
update this file for the next task, record outcomes on GitHub, and stop at #5.
