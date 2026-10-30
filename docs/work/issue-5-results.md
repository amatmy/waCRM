# Issue #5 — durable inbound work and recovery results

Source of truth: https://github.com/amatmy/waCRM/issues/5 and roadmap #9.
Branch `feat/issue-5-durable-inbound` is based on PR #12 head
`d0b2873b72059cfeaeda7df2afb213b27ebf1c64`; #12 depends on unmerged #11/#10.
All were open/unmerged when implementation began. No merge/deployment occurred.

## Implementation

- Atomic trusted-message queue journal and provider/source deduplication, independent
  of human presence; bounded account-scoped REST reconciliation for missed storage
  notifications, including backdated/late rows and changed-source tombstones.
- Signed-ingress completion gates claims until awaited native processing ends;
  consumed/native replies cannot create another queued AI response. Incomplete
  ingress remains pending/not ready for human review.
- Conversation-serialized SKIP LOCKED claims, 30-second leases capped by human
  expiry, fresh capabilities/revisions on restart, renew/release/checkpoint and
  retained attempts. No generic reply/CRM path can omit a queued work fence.
- Existing outbox outcomes govern recovery. Unknown attempts are never retried;
  stale immutable drafts require human handling. Human-only explicit queue
  resolution records an attestation while preserving outbox quarantine/history.
- REST/MCP work operations and capability propagation, plus a bounded callable
  cycle using an injected processor. No model, runtime adapter or daemon started.
- Next task brief updated for #6, which has not been executed.

Contract and exact boundaries: `docs/copilot-work.md`.

## Local validation

| Check                                                                                                                                                                                                                                       | Result                                                                                                                                |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                                                                                                                                                                                                  | 1,752 application cases passed; 108 DB cases skipped here and run below.                                                              |
| `COPILOT_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test -- src/lib/copilot/service.integration.test.ts src/lib/copilot/crm.integration.test.ts src/lib/copilot/work.integration.test.ts --maxWorkers=1` | 108 passed: 28 dispatch, 40 CRM, 40 inbound/recovery cases. Real isolated Postgres and fake provider only.                            |
| `npm test --prefix mcp-server`                                                                                                                                                                                                              | 6 passed, actual SDK/stdio with loopback HTTP fixtures; work tools, capability transport and permission failures covered.             |
| `npm run typecheck`; `npm run lint`                                                                                                                                                                                                         | Passed; 0 lint errors, 40 inherited warnings.                                                                                         |
| `npm run build` with CI dummy public Supabase/encryption/Meta values                                                                                                                                                                        | Passed after using a direct lockfile dependency installation.                                                                         |
| `supabase db reset --local --no-seed`                                                                                                                                                                                                       | Entire migration history replayed successfully, including `20261080082818_copilot_inbound_work.sql`.                                  |
| `psql ... -v ON_ERROR_STOP=1 -f supabase/ci/verify-schema.sql -f supabase/ci/copilot-sessions.sql -f supabase/ci/copilot-crm.sql -f supabase/ci/copilot-work.sql`                                                                           | Schema, session, CRM and new work/trigger access assertions passed.                                                                   |
| `supabase db lint --local --level warning`                                                                                                                                                                                                  | No errors; one inherited unused-variable warning in transfer_account_ownership.                                                       |
| `supabase db advisors --local --type security --level warn --fail-on error`                                                                                                                                                                 | No errors/new copilot findings; 5 inherited warnings: four public functions with mutable search paths and vector extension in public. |
| `supabase migration list --local`; `git diff --check`                                                                                                                                                                                       | Migration history aligned; whitespace check passed.                                                                                   |

The new recovery tests cover atomic rollback, duplicates/tenant independence,
paused arrivals, bounded missing/backdated repair, simultaneous workers, restart/
lease renewal, stale callback/CRM bypass prevention, role/key/policy revocation,
human takeover/release, superseded/deleted sources, immutable drafts, actual/
ambiguous/delayed synthetic provider outcomes, final database-write expiry and
explicit human-only resolution. Worker unit tests exercise frozen authority,
proposal timeout/ignored cancellation and lost transport response without retry.

An initial TypeScript check caught a queue method name colliding with inherited
human receipt reconciliation; the queue method was renamed `reconcileInbound`.
The first build rejected the temporary worktree's shared node_modules link;
installing directly with `npm ci` resolved it without build/config changes.
Adding readiness intentionally introduced a second ingestion RPC; two existing
unread-bump tests initially counted all RPCs and were updated to assert the
unread operation specifically. New tests verify completion ordering, native
consumption, failure handling and service-only access. All checks were rerun.
Final CI run links, exact tested head and PR state are recorded in Issue #5/#9
and the implementation PR. GitHub is authoritative for current delivery status.

## Limits and release blockers

No inference (#6), complete human UI (#7), real WhatsApp/runtime acceptance (#8),
paid AI API, deployment or merge. No resident worker or schedule was configured;
the provided cycle still needs a separately implemented local runtime/adapter.
Existing Meta ingress can lose an envelope before CRM storage; post-storage
reconciliation cannot reconstruct that missing payload. Human task-resolution
attestation is not delivery confirmation or provider-outcome reconciliation.
One immutable outbox per inbound remains intentionally conservative. Verified
historical rows without the new ingress-completion marker require human review;
this avoids assuming interrupted native processing finished. Legacy native sender
transport uncertainty is not converted into a copilot outbox guarantee.

Fresh lockfile audits retain 13 inherited application advisories (1 critical,
5 high, 6 moderate, 1 low) and 7 MCP advisories (2 high, 5 moderate). Dependency
manifests/lockfiles were unchanged. These and the inherited DB warnings remain
release blockers tracked in #1/#9; no unrelated upgrades were mixed into #5.
Local/synthetic checks do not establish production, model-quality or Meta delivery
acceptance. All work stops at Issue #5.
