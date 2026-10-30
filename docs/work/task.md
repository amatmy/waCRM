# Work Task — Issue #15: ChatGPT ↔ waCRM remote MCP (NO local AI)

## Authoritative correction
The user explicitly wants **ChatGPT through their existing subscription, connected to waCRM over MCP**. Do not implement or depend on Qwen, llama.cpp, Ollama, any local model, or paid AI inference APIs. Issue #15 supersedes the local-inference direction of #6/PR #14; do not merge #14 as the intended solution.

Source of truth: https://github.com/amatmy/waCRM/issues/15 and roadmap https://github.com/amatmy/waCRM/issues/9. Read AGENTS.md and existing MCP, CRM and security documentation. Record decisions, blockers, acceptance and results in GitHub Issues/PRs.

## Before work
- Inspect PRs #10–#14 and actual current heads/merge status. #10→#11→#12→#13 form the safety/CRM/queue stack. PR #14 contains the rejected local-inference approach.
- Work on a separate reviewable branch based on the appropriate **non-local-inference** dependency head (normally PR #13 if still unmerged). Do not merge/deploy any PR without approval.
- Review ChatGPT's currently supported custom MCP app/connector transport, authentication, write tool permissions and plan limitations using official documentation; do not assume consumer ChatGPT can perform writes or run continuously.

## Implementation
1. Provide an authenticated, remote HTTPS MCP interface that ChatGPT can connect to, with supported transport and tool schemas. No open unauthenticated write endpoints.
2. Expose safe read tools for contacts, inbox, conversation messages, assignments and CRM context; expose guarded write tools for replies, notes, status, deals, assignment and handoff only if the selected ChatGPT client supports them.
3. Preserve all server-side guards: tenant/account/operator authorization, active human session, ownership/revision, latest inbound, idempotency/outbox, WhatsApp eligibility, verified business knowledge and human takeover. Disable broadcast and raw-send bypass.
4. Make the setup practical: documented public HTTPS URL, authentication/configuration, and connection instructions for ChatGPT. Do not use localhost as the end-user MCP endpoint.
5. Demonstrate MCP protocol reads/writes with isolated fixtures and, if authorized and technically supported, verify actual ChatGPT connection. Explicitly distinguish MCP fixture success from actual ChatGPT acceptance.
6. Do not claim ChatGPT is an always-on webhook listener. For human-active operation, document what can be done interactively and which autonomous capabilities are not supported without an independently callable runtime.
7. Remove or isolate local-model integration from the product plan. Update roadmap and next-task brief; align Issue #7 UI work with ChatGPT MCP, not Qwen.

## Tests and boundaries
Run relevant app/MCP tests, typecheck, lint, build, SQL/RLS and migration checks; document commands, counts, CI, failures and security advisories. No paid AI API, no local model, no real WhatsApp sends, no production deployment or merges. No contact with third parties. Keep upstream attribution/history. Do not claim live acceptance from synthetic tests.

## Deliverable
Open a reviewable PR referencing #15; update #15 and #9 with exact verified results, supported/unsupported ChatGPT capabilities, blockers and next action. STOP after #15.

## Mandatory documentation and reporting gate

This task is **not complete** until Work documents actual work and results in GitHub. Follow the standing policy in `AGENTS.md`:
- Update Issue #15 and roadmap #9 with implementation decisions, changed components, exact tests/commands and pass/fail/skip counts, CI URLs, failures/fixes, security findings, unresolved limitations, and the next action.
- Create or update `docs/work/issue-15-results.md` with reproducible detailed evidence (or explicitly document a blocker if no implementation was possible), and link it in the PR and issue.
- Update `docs/work/task.md` with the next handoff **without assuming it is authorized to run**.
- In Work's final response provide GitHub links, results, blockers and one specific next action. Do not mark Issue #15 complete or say acceptance passed without verifiable evidence.

## Resume directive after partial Issue #15 Work run (2026-10-30)

Work already completed an **audit only** and recorded the findings at https://github.com/amatmy/waCRM/issues/15#issuecomment-6520386942. Do not repeat that audit as the sole deliverable and do not stop merely because OAuth or account permissions require further confirmation. Execute the feasible implementation and testing on this run.

- The prior `feat/issue-15-chatgpt-mcp` branch was **local only and not pushed to GitHub**. Start from the actual updated remote `feat/issue-5-durable-inbound` head (or reconcile any existing local work); create and PUSH a reviewable Issue #15 branch. Verify ancestry and exclude PR #14's local-inference code. Never overwrite useful uncommitted work.
- The existing MCP server uses **stdio and a configured waCRM API key**. Build a ChatGPT-compatible **remote Streamable HTTP MCP transport** (subject to current official support), separating MCP client OAuth authorization from the server-side waCRM credential. ChatGPT must not be expected to supply a user-entered waCRM API key. Implement/test appropriate OAuth resource and authorization-server discovery, audience/issuer/scope/expiry checks, account isolation, and secret handling, or use a maintained supported authentication framework. Do not invent a weak shared-token workaround. Document any strictly external setup needed to finish actual OAuth enrollment.
- Build and test the remote MCP `initialize`, discovery and allowed read tools using an MCP SDK client over HTTP. Connect guarded write tools only when server authorization is sound; deny unsafe legacy send/broadcast tools. Use isolated local fixtures, real-local Postgres if needed, and no real WhatsApp contacts.
- Prove HTTP authentication denies missing, expired, wrong-audience, wrong-tenant and insufficient-scope credentials; prove authorized reads and any guarded write paths in tests. Validate concurrency/authorization and make a documented remote HTTPS deployment configuration without actually deploying.
- The local protocol test is **not** ChatGPT product acceptance. If real ChatGPT connector linking cannot be tested without the account/hosted endpoint, document that precise unresolved acceptance gate while still submitting the tested transport implementation in a PR.
- Mandatory evidence: add `docs/work/issue-15-results.md` with exact commands, passing/failing/skipped test counts, CI URLs, changed components, fixes, limitations, and one next action. Update Issue #15 and roadmap #9. Do not mark complete if live ChatGPT compatibility cannot be verified.

Do not wait for approval for routine non-production coding/testing in the authorized scope. Do not deploy, merge, send real WhatsApp messages, use paid AI inference, or start any local AI model. STOP after the bounded Issue #15 work and documentation are pushed.
