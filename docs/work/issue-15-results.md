# Issue #15 — remote ChatGPT MCP implementation and evidence

Issue: https://github.com/amatmy/waCRM/issues/15. Review branch:
`feat/issue-15-chatgpt-mcp`, based on PR #13 head
`bff991acd567dfd0eb0d5adcce1e0e538632806f` on `feat/issue-5-durable-inbound`.
PR #14's local model is excluded and marked superseded. PRs #10–#13 were
open/unmerged at implementation start. The implementation PR, exact tested
commit and final CI links/status are recorded on Issue #15 and roadmap #9.

## Work performed

- Added a loopback-bound MCP Streamable HTTP server, protected-resource metadata,
  HTTP 401 OAuth challenge, per-tool OAuth descriptors and a separate explicit
  `start:remote` entry point. The actual OAuth authorization server is external:
  it must support discovery, ChatGPT client registration, PKCE and the documented
  JWT contract. The resource server does not issue tokens.
- Pinned public-key RS256 verification checks issuer, audience, `at+jwt`, key ID,
  subject, signed tenant, `iat`/`nbf`/`exp`, maximum 15-minute token life and
  scope on each request. The server is configured for one operator, OAuth subject,
  tenant and CRM account. It checks `/api/v1/me` before each MCP operation and
  rejects a key whose CRM account does not match. The waCRM key remains server-side.
- Writes require both server opt-in and `wacrm.write`; default is read-only. Even
  then, only the existing copilot CRM/work tools are registered. No raw send,
  broadcast, human session activation or approval tool is exposed. Existing
  server-side session, permission, account, ownership, handoff, inbound and outbox
  checks remain authoritative. Credential-bearing CRM fetch refuses redirects,
  times out after 10 seconds and redacts a reflected key in error text.
- Retained the provider-independent queued handoff checkpoint from #14 without
  bringing its local inference runtime: handoff/assignment records
  `awaiting_human` and closes/annotates its fenced attempt atomically.
- Added SDK HTTP, token, account, scopes, concurrent-session and synthetic CRM
  fixture tests; added real-Postgres handoff regression. Added HTTPS/OAuth setup
  documentation, updated the proposed next-task brief and corrected roadmap #9.
  No model or inference integration was introduced.

Full configuration, required claims and HTTPS reverse-proxy example:
`docs/chatgpt-remote-mcp.md`. The SDK version's default tool list omits OpenAI's
top-level `securitySchemes`; the remote adapter explicitly includes it and its
`_meta` mirror using the SDK's schema conversion helpers. Raw-wire and SDK tests
cover those descriptors, but future SDK changes require retesting this integration.

## Validation

| Command / check                                                                                                                                                                                                                                                                     | Result                                                                                                                                                                                                                                                                                  |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `npm test --prefix mcp-server`                                                                                                                                                                                                                                                      | 16 passed, 0 failed. Includes actual MCP SDK initialization/discovery over loopback HTTP, OAuth denial cases, read and guarded synthetic handoff forwarding, tenant/account/scope separation, concurrent clients, public-key config, redirect rejection/redaction and raw tool schemas. |
| `npm test`                                                                                                                                                                                                                                                                          | 1,752 application tests passed; 109 Postgres cases skipped here and run separately.                                                                                                                                                                                                     |
| `COPILOT_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres npm test -- src/lib/copilot/service.integration.test.ts src/lib/copilot/crm.integration.test.ts src/lib/copilot/work.integration.test.ts --maxWorkers=1 --testTimeout=30000 --hookTimeout=30000` | 109 passed, including a new handoff checkpoint test, with isolated local Postgres and fake provider.                                                                                                                                                                                    |
| `npm run typecheck`; `npm run lint`                                                                                                                                                                                                                                                 | Passed; 0 lint errors, 40 inherited warnings.                                                                                                                                                                                                                                           |
| `npm run build` with CI dummy Supabase/encryption/Meta environment                                                                                                                                                                                                                  | Passed.                                                                                                                                                                                                                                                                                 |
| `supabase db reset --local --no-seed`                                                                                                                                                                                                                                               | Full migration history replayed on local disposable database. No schema migration in this change.                                                                                                                                                                                       |
| `psql postgresql://postgres:postgres@127.0.0.1:54322/postgres -v ON_ERROR_STOP=1 -f supabase/ci/verify-schema.sql -f supabase/ci/copilot-sessions.sql -f supabase/ci/copilot-crm.sql -f supabase/ci/copilot-work.sql`                                                               | Schema, account/role/session, CRM and work access assertions passed.                                                                                                                                                                                                                    |
| `supabase db lint --local --level warning`                                                                                                                                                                                                                                          | No errors; inherited unused-variable warning in `transfer_account_ownership`.                                                                                                                                                                                                           |
| `supabase db advisors --local --type security --level warn --fail-on error`                                                                                                                                                                                                         | No errors; five inherited warnings (four mutable search paths, public vector extension).                                                                                                                                                                                                |
| `git diff --check`                                                                                                                                                                                                                                                                  | Passed.                                                                                                                                                                                                                                                                                 |

Failures encountered and corrected: a concurrent-scope fixture initially asserted
a misspelled tool name; the SDK returns `isError` rather than rejecting a call to
an unavailable tool; and the Postgres ownership trigger initially recorded an
attempt as `ownership_changed` before the handoff checkpoint could annotate it.
A final expiry-during-identity-lookup test initially failed because its delay fixture omitted a parameter; after correcting the fixture it confirmed that an expired token receives an OAuth challenge. The checkpoint now preserves the trigger's original end timestamp and records
`human_handoff` for the same fenced attempt. Final suites above pass.

## Evidence boundary and next action

The HTTP suite uses generated RSA keys and a synthetic loopback CRM server. It
proves protocol/authorization behavior and fake guarded-action forwarding; the
Postgres suite tests actual CRM guards separately. It is not an end-to-end test
of remote MCP through real Postgres, nor actual ChatGPT OAuth enrollment, client
plan entitlement, public TLS proxy, provider discovery/PKCE/refresh or Meta.
The actual identity-provider discovery document and JWT issuance were not tested.
ChatGPT write access varies by account/workspace policy; the user's plan is unknown.
Issue #15 remains open, pending review and actual connector acceptance.

The independently configured OAuth provider must issue compatible JWTs and
immutable tenant claims. Key rotation is manual; provider-side revocation or role
changes can remain effective until the JWT expires (maximum 15 minutes). This
single-operator resource server is not multi-user credential brokering. Review
security, reverse-proxy rate limits and provider configuration before exposure.
Existing 13 application advisories (including one critical), seven MCP advisories,
five DB security warnings, ingress-before-storage limitations, stale/unknown
outbox quarantine and missing live acceptance remain release blockers. No
unrelated dependency upgrades, paid AI API, local model, real WhatsApp message,
deployment or merge occurred.

Next, after separate authorization: choose an OAuth provider/HTTPS endpoint,
review the implementation and test ChatGPT linking, account entitlement, reads
and permissible guarded writes with isolated synthetic data. `docs/work/task.md`
contains the handoff; #7 UI is a later separately authorized task.
