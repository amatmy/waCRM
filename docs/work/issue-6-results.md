# Issue #6 — callable local inference results

Source of truth: https://github.com/amatmy/waCRM/issues/6 and roadmap #9.
Review branch: `feat/issue-6-local-runtime`, based on Issue #5 / PR #13 head
`2e2b1fa8ac991a45641dc18a7e9c10b8db3e1f29` on
`feat/issue-5-durable-inbound`. PRs #10–#13 were open/unmerged at start.
The implementation PR and exact tested head/CI links are recorded on #6/#9.
No merge, deployment or Issue #7 implementation occurred.

## Delivered behavior

- An explicit one-shot local host drives the existing fork MCP SDK/stdio server
  and REST work protocol during the exact already active human generation.
  It never starts or renews a human session and installs no background service.
- Shared bounded worker cycle, credential-bearing fixed-tool adapter and local-only
  JSON classifier. The model receives no credentials or lease capabilities and
  can only choose an existing answer ID or request review. Generated text is never
  a reply/tool argument. The exact verified answer is selected outside the model.
- Account/current-generation-fenced verified knowledge read (`knowledge` /
  `get_verified_reply_context`) supplies one exact unexpired human-curated answer
  plus source, with explicit no-knowledge/risky reasons. Final server permissions,
  active-session/takeover/latest-inbound/policy/knowledge/outbox fences remain.
- Audited queued handoff/assignment records awaiting-human state and closes the
  attempt atomically. A one-shot host releases an unapproved immutable draft for
  human recovery; existing triggers cancel its unsent authority and retain history.
- Loopback-only inference without redirects/cloud fallback, bounded JSON output,
  abortable 20-second processing budget capped by the worker/human lease. CRM
  credential-bearing fetches now refuse redirects and time out at 10 seconds;
  MCP host calls time out at 15 seconds. Unknown provider outcomes are never retried.
- Runtime profile, licenses, hashes, invocation, evidence limits and next task
  documented; CI now recognizes the stacked #13 base and runs the real-DB runtime
  adapter suite with deterministic injected inference and fake provider transport.

Full operational contract: `docs/copilot-runtime.md`.

## Actual hardware and model evaluation

Evaluated on Apple M3 arm64, 8 GiB RAM, 8 logical CPUs, macOS 27.0. The machine
already had substantial memory pressure (roughly 9.6 GiB swap used at initial
inspection; 11.5 GiB immediately before final evaluation) and limited free disk
(8.6 GiB initially, about 7.1 GiB after dependencies/artifacts). Unrelated apps and
`private-driver-db-1` were left alone. Runtime/model artifacts were kept outside
source control. No global installation or resident service was created. The task-owned model
process and disposable `supabase_db_wacrm` container were stopped after validation;
the unrelated database container remained running.

Official llama.cpp b12001 portable arm64 binary (MIT) and official
Qwen3-0.6B Q8_0 (Apache-2.0, pinned publisher revision) were downloaded after
checking hardware/disk/license constraints. Both SHA-256 values matched the
publisher metadata before execution. `runtime-manifest.json` includes exact
URLs/revision/hashes; notices were read. The model is 639,446,688 bytes.

CPU-only evaluation: context 1,024, 2 generation/batch threads, 1 slot, no thinking,
128 output tokens maximum, seed 7, temperature 0, offline local file, clean
server environment, numeric loopback, disabled UI and restricted CORS origins.
Observed sampled maximum server RSS was 717,952 KiB (about 701 MiB), and CPU
188.9% (about two cores); these are 0.5-second `ps` samples, not guaranteed peaks.
The final profile took about 39.2 seconds from process start to readiness;
this is separate from per-request latency. Full synthetic
case decisions/usage/timings and final run details are in
`issue-6-model-evaluation.json`.

A successful six-case run proved real local inference → actual MCP/HTTP handlers
→ canonical Postgres → guarded fake-provider reply or persisted handoff. Two
routine verified-answer cases (including a malicious source-reference string)
sent only the stored verified text. Unknown knowledge, refund, a request for a
person and customer prompt injection yielded durable human handoff. No real
WhatsApp transport was invoked. The original successful run's model latency was
484–4,595 ms, with end-to-end case wall time 730–4,903 ms; later warm/cold results
must be read with cache use and pressure in mind. The final isolated run
recorded 581–7,485 ms model latency and 762–7,797 ms case wall time.

The raw model incorrectly chose `reply` with `answer_id=none` on the unknown
question in that run. The deterministic host vetoed it and handed off; do not
claim 100% model instruction compliance or model-only injection resistance.
These are six hand-selected synthetic cases, after prompt calibration, not a
held-out benchmark or general multilingual business-quality acceptance.

A repeat under pressure hit the hard 20-second inference deadline and aborted
rather than sending a delayed result. Therefore this host does **not** demonstrate
a response-time SLA on the current machine. Lease-safe retry/recovery is retained;
no time budget was enlarged to hide that result. Lower load/dedicated hardware
and broader evaluation remain prerequisites for operational use.

## Validation commands and bounded results

| Check                                                                                                                                                                                                                                                                                                                           | Result                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test`                                                                                                                                                                                                                                                                                                                      | 1,769 application cases passed; 128 DB/hardware cases skipped by default and exercised separately as below.                                                                                                                               |
| `COPILOT_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test -- src/lib/copilot/service.integration.test.ts src/lib/copilot/crm.integration.test.ts src/lib/copilot/work.integration.test.ts src/lib/copilot/runtime.integration.test.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000` | 127 passed; 1 actual-model opt-in case skipped. Existing 28 dispatch/40 CRM/40 work cases plus 19 runtime cases; real disposable Postgres and fake transport.                                                                             |
| Same runtime suite with `LOCAL_LLM_URL=http://127.0.0.1:11435` and `LOCAL_EVALUATION_OUTPUT=...`                                                                                                                                                                                                                                | Final isolated hardware case passed (six scenarios; 19 deterministic runtime cases excluded by name and passed separately). An earlier run passed all 18 then-existing runtime cases. Repeat pressure timeout recorded above and in JSON. |
| `npm test --prefix mcp-server`; `npm run typecheck --prefix mcp-server`                                                                                                                                                                                                                                                         | 10 MCP/adapter tests passed; types passed. Actual SDK/stdio and loopback HTTP fixtures; fixed tool mapping, capability transport, errors and redirect refusal.                                                                            |
| `npm run typecheck`; `npm run lint`                                                                                                                                                                                                                                                                                             | Passed; 0 lint errors, 40 inherited warnings.                                                                                                                                                                                             |
| `npm run build` using CI dummy Supabase/encryption/Meta values                                                                                                                                                                                                                                                                  | Passed. No real service credentials or live send.                                                                                                                                                                                         |
| `supabase db reset --local --no-seed`                                                                                                                                                                                                                                                                                           | Complete migration history replay passed. No new migration/schema in #6.                                                                                                                                                                  |
| `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 -f supabase/ci/verify-schema.sql -f supabase/ci/copilot-sessions.sql -f supabase/ci/copilot-crm.sql -f supabase/ci/copilot-work.sql`                                                                                                           | All schema/session/CRM/work and RLS/grant assertions passed.                                                                                                                                                                              |
| `supabase db lint --local --level warning`                                                                                                                                                                                                                                                                                      | No errors; inherited unused-variable warning in `transfer_account_ownership`.                                                                                                                                                             |
| `supabase db advisors --local --type security --level warn --fail-on error`                                                                                                                                                                                                                                                     | No errors/new copilot findings; same five inherited warnings (four mutable function search paths and public vector extension).                                                                                                            |
| `supabase migration list --local`; `git diff --check`                                                                                                                                                                                                                                                                           | History aligned and whitespace check passed.                                                                                                                                                                                              |
| `npm pack --dry-run --json` from `mcp-server`                                                                                                                                                                                                                                                                                   | Runtime modules/manifest are included; no model or runtime binary is packaged. No publication occurred.                                                                                                                                   |

The runtime adapter harness uses real loopback HTTP, actual MCP subprocess and
real route/service/SQL execution. API-key authentication plumbing is an explicit
SQL-backed test shim; fake provider transport is injected at the module boundary.
It is not deployed Next routing, hosted JWT/auth acceptance, raw signed-webhook
receipt, a continuous ingress listener or live Meta delivery. Production auth
contract/route tests and the existing real-DB authority/race suites run separately.

New cases cover availability/invalid/truncated/oversized responses and redirects,
missing/expired knowledge, forged output, caller cancellation, hanging inference,
one-shot invocation/pause/unapproved-draft release without human heartbeat,
unknown/risky content, two actual subprocess workers, delayed model results after
pause/restart/takeover/key/role/policy/knowledge/new-inbound changes, foreign and
stale knowledge capabilities, persisted handoff and exact fake-provider text.

Initial checks caught test-fixture typing errors and clarified that revoked
knowledge produces an unapproved leased draft before explicit release. The new
CLI-release assertion also initially expected `draft`; the existing ownership
trigger correctly produced `cancelled` while retaining the immutable row, and the
test/docs now reflect that behavior. The first hardware prompt over-escalated an
ordinary hours question; clearer classifier instructions fixed that calibration
case without relaxing host/server authorization. Repeat pressure-related timeout
is retained as a performance limit, not suppressed or reported as a safe reply.

## Remaining boundaries and handoff

No paid inference API, real WhatsApp message, human UI (#7), live acceptance (#8),
deployment or merge. No automatic shift schedule or 24/7 requirement. Existing
pre-storage raw-ingress loss and native transport ambiguity remain upstream
limits. One immutable outbox per inbound, unknown-attempt quarantine and explicit
human resolution remain conservative and cannot be bypassed by a local model.

Fresh lockfile audits retain 13 inherited application advisories (1 critical,
5 high, 6 moderate, 1 low) and 7 MCP advisories (2 high, 5 moderate). No dependency
version/lockfile upgrade was mixed in. These, inherited DB findings and missing
live acceptance remain release blockers in #1/#9. Review-stack heads, exact final
CI evidence and PR state are on GitHub. `docs/work/task.md` hands off separately
initiated #7. All work stops after #6.
