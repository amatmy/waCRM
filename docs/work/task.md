# Work Task — Issue #3: Guard AI replies, ownership, and human handoff

## Source of truth
- Repository: `amatmy/waCRM`
- Issue: https://github.com/amatmy/waCRM/issues/3
- Roadmap: https://github.com/amatmy/waCRM/issues/9
- Foundation PR: https://github.com/amatmy/waCRM/pull/10
- GitHub Issues/PRs are authoritative for scope, decisions, blockers, test evidence, and handoff.
- Read `AGENTS.md`, relevant architecture docs, migrations, existing API and MCP server code before making changes. Follow repository conventions.

## Objective
Implement server-enforced, atomic AI conversation ownership and reply authorization so a copilot can safely act only while a human operator is actively working, and immediately yields when that person takes over. The AI has **no independent scheduled shifts**. No paid AI inference API.

## Before coding
1. Check live state of PR #10 and Issues #1–#9, and determine which foundation commits are on `main`. Do not assume PR #10 was merged; do **not** merge it without explicit user approval. If #3 depends on unmerged #10, base an isolated branch on the correct foundation and document the dependency.
2. Audit current `assigned_agent_id`, `ai_autoreply_disabled`, `ai_handoff_summary`, existing auth/RLS and message send paths. Identify all possible bypass routes.
3. Create a reviewable branch for #3 and comment the implementation plan and dependencies on Issue #3.

## Required implementation
- Add atomic conversation claim/takeover/handoff with ownership revision and account-scoped authorization. Human takeover must revoke AI reply authority even for in-flight work.
- Guard every AI outbound dispatch at the **server**, including legacy/raw API paths: check human-active session lease, owner revision, newest inbound message consistency, account/user role, configured policy, and WhatsApp eligibility. An MCP-only guard is insufficient.
- Establish transactional outbox and idempotency keys for AI send attempts. Reconcile indeterminate provider outcomes rather than blindly retrying.
- Preserve conversation history, human assignments and handoff summaries; handoff is explicit. Human session pause/expiry must stop AI sends while leaving work intact.
- Keep AI broadcast disabled and prevent copilot credentials from bypassing guarded send.
- Implement authenticated API/MCP surfaces only as needed for this issue; defer broader CRM actions to #4, queue/recovery to #5, local inference to #6, and UI controls to #7.

## Acceptance tests
- Human takeover before dispatch prevents AI send; takeover racing an in-flight send is safe and deterministic.
- Session pause/expiry and stale/replaced session prevent AI send.
- Cross-account and revoked-role access denied; raw-send path cannot bypass controls.
- Duplicate requests and ambiguous provider results do not cause duplicate outbound customer messages.
- Stale conversation context or changed latest inbound prevents AI send.
- SQL/RLS, route, MCP compatibility, typecheck, lint and production build pass as relevant. Clearly distinguish fixtures and synthetic test evidence from real WhatsApp acceptance.

## Safety and execution boundaries
- Do not send real WhatsApp messages or contact third parties.
- Do not deploy, merge a PR, enable production AI autoreply, or incur paid AI/API fees without explicit user authorization.
- Use test fixtures and isolated infrastructure only. Do not claim live acceptance based on mocks.
- Keep changes focused and reviewable; preserve upstream MIT attribution and history.

## Completion / handoff
- Open a PR linking Issue #3; include changed contracts, migrations, tests, limitations, and exact commands/results.
- Update Issue #3 and roadmap #9 with verified progress, outstanding blockers, and next step. Keep PR #10 dependency explicit.
- Stop after completing the authorized #3 scope. Do not automatically advance to other issues.
