# Issue #4 implementation and review evidence

Scope: https://github.com/amatmy/waCRM/issues/4. Roadmap #9 is authoritative.
PR: https://github.com/amatmy/waCRM/pull/12 (draft, open, unmerged).
Branch: `feat/issue-4-controlled-crm`, based on unmerged PR #11 head
`ea9057373c18745a8368c64ce61213ef4c15a5a5`, itself based on unmerged PR #10 head
`51073f036860c04d5ddd19a2be81348407ed0350`. No merges were performed.

## Dependency review

COMMENT reviews and validation notes are recorded on PRs #10 and #11. Neither
is merge approval. Their existing app/migration CI checks at the exact reviewed
heads passed. Fresh detached-checkout validation also passed:

- PR #10: 1,694 application tests and 5 actual stdio MCP protocol tests.
- PR #11: 1,704 application tests and 5 stdio MCP tests. Its 28 original real
  Postgres/fake-provider cases passed on a clean database replayed only through
  its own migrations. Two additional detached-checkout reproductions confirmed
  unsafe baseline behavior, bringing that diagnostic run to 30 passing cases:
  native close/reopen left an old approval dispatchable, and expiry during a
  contact-row lock wait did not prevent synthetic-provider submission.

Issue #4 fixes both findings. Native status/contact/account changes revoke the
claim/revision and cancel unsent work. Leaving open pauses AI; contact/account
changes clear the latest-inbound pointer. Dispatch repeats session/key/window
and policy eligibility after contact/config locks, immediately before provider
submission. Rejection regressions cover both reproduced gaps. The two diagnostic
reproduction tests were not pushed to the dependency branch.

## Implementation

- Dedicated `copilot:crm` scope, live account/operator/key guards, strict payloads
  and explicit same-account contact, assignment target, pipeline and deal checks.
- Native internal notes, human assignment/handoff, conversation status, and
  limited linked deal updates. No monetary, ownership or bulk deal mutations.
- Transactional action results and idempotent concurrent/replayed calls; account
  SELECT RLS and explicit denial of direct writes to new control/audit tables.
- Hybrid answers require human-admin curation with source/expiry, exact inbound
  and answer matching, conservative risk veto, policy revision invalidation and
  final dispatch rechecks. Disabled by default. No model safety verdict or paid
  inference integration.
- MCP context/action/outcome tools; no approval/activation/policy/broadcast tool.
- Old unaudited handoff endpoint retired with 400 migration guidance. Clients
  must supply session/revision/latest inbound/idempotency and have the new scope.
- Team-join data guard now protects curated business knowledge and action data.
- Next task brief is Issue #5; it has **not** been started.

See `docs/copilot-crm.md` for the endpoint and policy contracts and limits.

## Validation results (synthetic/local)

| Command/check                                                                                                                                                                                      | Result                                                                                                                                                      |
| -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm ci`; `npm ci --prefix mcp-server`                                                                                                                                                             | Lockfiles install successfully; no dependency manifests/lockfiles changed from PR #11. Audit findings below remain.                                         |
| `npm test`                                                                                                                                                                                         | **1,729 passed**, 67 database cases skipped in the ordinary suite (165 passing test files, 2 skipped).                                                      |
| `COPILOT_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test -- src/lib/copilot/service.integration.test.ts src/lib/copilot/crm.integration.test.ts --maxWorkers=1` | **67 passed** against real isolated Postgres with an injected fake provider (28 dispatch + 39 CRM/hybrid cases). All ordinary-suite skips are covered here. |
| `npm test --prefix mcp-server`                                                                                                                                                                     | **5 passed** using real MCP SDK/stdio and loopback HTTP fixtures, including action payloads and forbidden-tool discovery.                                   |
| `npm run typecheck`                                                                                                                                                                                | Passed.                                                                                                                                                     |
| `npm run lint`                                                                                                                                                                                     | Passed with 0 errors and 40 inherited warnings.                                                                                                             |
| `npm run build` with CI dummy Supabase/Meta/encryption values                                                                                                                                      | Passed; existing middleware/Edge deprecation notices remain.                                                                                                |
| `supabase db reset --local --no-seed`                                                                                                                                                              | Clean full migration replay passed, including the new CRM/hybrid migration.                                                                                 |
| `psql ... -v ON_ERROR_STOP=1 -f supabase/ci/verify-schema.sql -f supabase/ci/copilot-sessions.sql -f supabase/ci/copilot-crm.sql`                                                                  | All schema, session/access and new table-privilege assertions passed.                                                                                       |
| `supabase db lint --local --level warning`                                                                                                                                                         | No schema errors; one inherited unused-variable warning in `public.transfer_account_ownership`.                                                             |
| `git diff --check`                                                                                                                                                                                 | Passed.                                                                                                                                                     |

Final-head CI run URLs/status and the exact reviewed head are recorded on PR #12
and Issues #4/#9. The workflow runs full application/MCP/type/lint/build checks
and a separate clean database replay with both integration suites.

The first CI application run caught two duplicate fields in test fixtures;
these were removed. The first full local suite caught missing team-join data
guards for the new tables; the actual membership RPC was extended, and a real
DB regression proves curated answers survive a rejected destructive join.
These checks were rerun successfully after the fixes.

The original Documents checkout encountered macOS `dataless` file reads and
checks were interrupted rather than counted as passing. Validation resumed in a
fresh nonsynced temporary checkout of the pushed branch. No user changes were
removed and the original checkout was preserved. Durable source and evidence
are in GitHub, not the temporary test directory.

## Dependency audit and release limits

`npm audit --json` reports **13 inherited application advisories**: 1 critical,
5 high, 6 moderate, 1 low. Next.js 16.3.8 is flagged, including
[GHSA-2464-fhr4-w9xw](https://github.com/advisories/GHSA-2464-fhr4-w9xw) and
[GHSA-673q-mjm6-r5xr](https://github.com/advisories/GHSA-673q-mjm6-r5xr).
`npm audit --prefix mcp-server --json` reports **7 inherited MCP advisories**:
2 high and 5 moderate. These are scanner findings, not a claim that a particular
exploit was reproduced. No dependency upgrades or forced audit fixes were made
outside Issue #4. Review/remediation remains a release blocker in Issues #1/#9.

The hybrid allowlist depends on truthful human verification and appropriately
short expiries; it is not general semantic business reasoning. The multilingual
risk veto is conservative, not a universal intent detector. One immutable outbox
entry per inbound remains; policy/context changes require human handling rather
than unsafe new-key retries. Existing bounded provider-call/unknown-outcome
limitations remain. No queue worker (#5), local inference (#6), complete human
UI (#7), or real provider acceptance (#8) is claimed.

No paid inference, real Meta/WhatsApp messages, production policy activation,
deployment or merge. Synthetic/local evidence does not establish live readiness.
