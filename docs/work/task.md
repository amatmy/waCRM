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
