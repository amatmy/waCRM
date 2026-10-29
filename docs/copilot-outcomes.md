# Initial implementation outcomes — 2026-10-29

Tracking: [roadmap #9](https://github.com/amatmy/waCRM/issues/9), audit #1,
human-session foundation #2. Work is proposed on `feat/active-session-foundation`.
Issues remain open until the corresponding implementation is accepted/merged.

## Delivered

- Created `amatmy/waCRM` as a public fork, retaining upstream history and MIT license.
- Created five milestones, eight initial implementation issues, and a pinned roadmap issue.
- Implemented durable human-controlled start, heartbeat and pause; 90-second database-clock lease;
  explicit restart after pause/expiry; session generations reject stale tab commands.
- Added a human cookie-authenticated endpoint and a read-only API-key endpoint scoped to the key's account.
- Extended the existing stdio MCP with an opt-in read-only copilot profile and session inspection tool.
- Added API, real PostgreSQL/RLS, MCP protocol and compatibility tests to CI; documented architecture,
  audit evidence, setup and the remaining gates.

## Local verification

| Check                        | Result and boundary                                                                                                                                                                                                                                                     |
| ---------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Application tests            | 158 files, 1,694 tests passed; fixtures/mocks, no real provider calls                                                                                                                                                                                                   |
| New session route tests      | 13 passed, included in the application total                                                                                                                                                                                                                            |
| MCP protocol/compatibility   | 5 tests passed, SDK client ↔ stdio server ↔ synthetic local HTTP CRM                                                                                                                                                                                                    |
| App + MCP type checks        | Passed                                                                                                                                                                                                                                                                  |
| Lint                         | 0 errors, 40 warnings in inherited app files; new routes separately linted clean                                                                                                                                                                                        |
| Production build             | Passed with dummy Supabase/Meta environment values; no deployment                                                                                                                                                                                                       |
| New migration + SQL behavior | Passed on isolated local PostgreSQL 17 with minimal synthetic account/auth schema and upstream membership/bootstrap helpers                                                                                                                                             |
| SQL behaviors exercised      | start/heartbeat/pause, expired/paused rejection, restart generation, stale pause, direct-mutation denial, different-account and same-account operator isolation, account move, role downgrade, service-role activation denial, anonymous access, missing human identity |
| Security advisors            | CLI reported no issues on that isolated minimal database; not an audit of a real Supabase instance                                                                                                                                                                      |
| Full Supabase replay         | Local image download stalled before database startup; full replay is required in the Migrations CI workflow                                                                                                                                                             |

The full application test suite initially caught that the new ephemeral lease
table was absent from the account-joining test's non-domain-data list. It is now
classified with existing presence tables; a presence lease should not prevent
a user joining a team. The rerun passed.

## Still required

No real WhatsApp message was sent; no existing CRM/account was connected or
modified. No model was selected, downloaded, invoked or benchmarked. No paid AI
API was called. No ChatGPT/Dot connection, automatic wakeup, handoff/reply flow,
UI controls, queue recovery, production credentials or hosted acceptance is
established. No merge or deployment occurred.

MCP copilot mode intentionally exposes no writes. Native legacy MCP writes and
upstream AI providers still exist for compatibility and are outside this copilot
flow. Use a read-only API key and leave native AI provider settings unconfigured.
Issue #3 must establish server-side guarded credentials and atomic send/takeover
semantics before replies are enabled. Issue #6 owns actual local inference, and
issue #8 owns real-message acceptance. These limits are not solved by a connected
chat session or by the passing local fixture tests.
