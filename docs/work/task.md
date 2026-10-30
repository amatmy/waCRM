# Next proposed work — Issue #15 actual ChatGPT acceptance

Repository `amatmy/waCRM`; source of truth https://github.com/amatmy/waCRM/issues/15
and roadmap #9. This is a handoff, not authorization to begin another task.
Read `AGENTS.md`, `docs/chatgpt-remote-mcp.md`, `docs/work/issue-15-results.md`
and the current Issue #15/PR comments before proceeding.

Issue #15's implementation branch is based on `feat/issue-5-durable-inbound`;
check the live PR and exact dependency heads before choosing a new branch. PRs
#10–#13 are dependencies; #14's local inference is rejected. Do not infer merge,
production readiness or ChatGPT acceptance from passing fixture tests.

The next separate task is to review the OAuth resource server, choose/configure
an external OAuth 2.1 provider that meets the documented discovery, claims,
short-lived JWT and key rotation contract, establish an approved HTTPS host and
verify the user's actual ChatGPT plan/client read and write capabilities. Real
connector linking, deployment, credentials and provider authorization require
appropriate user authorization; no approval is implied by this brief. Preserve
all existing CRM account, human-session, takeover, policy, lease and outbox guards.
Never use a local model or paid inference API; do not send real WhatsApp messages
or merge without explicit authorization. Issue #7 UI remains a later separate
task and must target interactive ChatGPT MCP rather than a local model.

Record actual evidence, failures, tests, security findings and next action in
GitHub Issues/PRs under the `AGENTS.md` Work policy, then stop at the scope of the
newly authorized task.
