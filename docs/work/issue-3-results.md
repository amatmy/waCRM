# Issue #3 execution and results — 2026-10-29

[PR #11](https://github.com/amatmy/waCRM/pull/11) is stacked on **unmerged PR #10**
at foundation `51073f0`. Its base is `feat/active-session-foundation`, not main.
Main's execution brief at `d5b8ac7` is included without merging either branch.
The user confirmed GPT-6 High was selected. No inference API was invoked.

## Implemented

- Account/admin-controlled dedicated-key binding; current membership/scopes/key
  and session liveness checked again at dispatch. Durable binding restricts legacy writes even after a scope edit.
- Conversation ownership/session generation and revision; explicit human
  takeover/release and AI-to-human handoff. Native assignment, manual sends and
  customer-context edits also invalidate authority. Handoff summaries/history
  remain intact, including through the native resume endpoint.
- Disabled-by-default human-approval policy and immutable outbox records.
  Unique key/idempotency and conversation/inbound constraints prevent changing
  keys to create duplicate attempts. A committed dispatch latch survives failure.
- Database locks serialize final authorization/provider submission with human
  session/ownership changes. The provider gets one bounded request, no redirect,
  phone-variant or application retry. Lost database connections abort the attempt.
- Unknown/crashed attempts are quarantined; human reconciliation requires a
  receipt already stored by the signature-verified webhook and records attribution.
- Verified-inbound markers prevent imported/human-created records establishing
  reply eligibility. Duplicate webhook inserts preserve the existing pointer;
  another tenant's matching opaque ID cannot suppress a new inbound.
- Raw machine sends/broadcasts and native unguarded AI dispatch are disabled.
  Five guarded tools extend the existing MCP. Broader CRM actions, queue/runtime
  and UI work remain in their existing issues.

## Verification and failures resolved

Commands run in a fresh recovered checkout:

| Command / check                                                                                                                                            | Result                                                                                                                          |
| ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `npm run typecheck`                                                                                                                                        | Passed                                                                                                                          |
| `npm test -- --maxWorkers=2`                                                                                                                               | 1,704 tests passed; 28 database cases separately skipped without their explicit test URL                                        |
| `npm run lint`                                                                                                                                             | 0 errors, 40 inherited warnings; new copilot source separately linted                                                           |
| `npm run build` with dummy Supabase/Meta values                                                                                                            | Passed; no deployment                                                                                                           |
| MCP `npm ci`, `npm run typecheck`, `npm test`                                                                                                              | Passed, five SDK/stdio/fixture tests                                                                                            |
| `supabase db reset --local --no-seed`                                                                                                                      | Complete migration history replay passed on an isolated Supabase database                                                       |
| `supabase db query --local --file supabase/ci/verify-schema.sql`                                                                                           | Passed                                                                                                                          |
| `supabase db query --local --file supabase/ci/copilot-sessions.sql`                                                                                        | Passed                                                                                                                          |
| `COPILOT_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test -- src/lib/copilot/service.integration.test.ts --maxWorkers=1` | 28 tests passed against real PostgreSQL with a synthetic provider                                                               |
| `supabase db advisors --local --type security --fail-on error`                                                                                             | No errors; five inherited warnings (four upstream mutable function search paths and `vector` in public); no new copilot finding |

Database tests include takeover/pause before and during submission, lease expiry
after waiting for locks, replaced sessions, revoked key/scope/binding/role,
cross-account denial and isolation, changed policy/latest inbound, edited context,
closed WhatsApp window, immutable idempotency, concurrent dispatch, provider
rejection/unknown outcome, crashed latches, actual dispatch-connection termination,
receipt-required reconciliation, native human takeover/assignment, RLS write
denial, unforgeable inbound verification and duplicate webhook handling.

The original local Git pack/dependency files became corrupted during testing.
All 34 modified source files were copied with verified hashes to a fresh clone;
interrupted runs are not evidence. The fresh checkout passed the recorded checks.
The first database test run exposed an incorrect test conflict target: upstream's
index is composite/partial. The fixture now uses `ON CONFLICT DO NOTHING` and the
full database suite passes. A tenant-isolation regression also verifies the
duplicate-message trigger checks the conversation, not unrelated tenant data.

GitHub Issues and PR checks own the final tested commit, counts and CI links.
See the PR and Issue #3 for final verification after these changes; do not infer
current checks from an earlier green or failed run.

## Material boundaries / handoff

This is synthetic/local/CI evidence, not live WhatsApp/model acceptance. No real
message was sent, real CRM account connected, paid AI API called, production AI
enabled, merge performed or deployment made.

An already-submitted network request cannot be recalled. A winning takeover/pause
prevents submission; an in-flight provider attempt serializes before confirmed
takeover/pause. A failed/timed-out control request is not confirmation. Meta can
deliver an already-submitted message later. The exact contract is in
[copilot-dispatch.md](../copilot-dispatch.md).

The conservative first policy permits one immutable draft/attempt per inbound;
it does not support draft replacement or resetting an unknown attempt. Human
manual reply remains available. Reconciliation relies on the human matching the
correct stored provider receipt; receipt presence alone does not prove content
correlation. Expired/missing receipts leave an unknown outcome quarantined.
Background reconciliation, resumable work queues, automatic routine policy,
local inference, UI and live-provider acceptance remain #4–#8.

Next action: review #11 and its #10 dependency; no automatic merge, deployment
or advancement to another implementation issue is authorized by this task.
