# Callable local copilot runtime — Issue #6

This host runs **one explicitly invoked work cycle** during an already active
human session. It does not listen for webhooks, schedule shifts, start a daemon,
activate a human session or keep one alive. UI presence/heartbeat is Issue #7;
real WhatsApp acceptance is Issue #8. Existing native AI auto-replies stay disabled.

## Authority and data flow

Canonical stored inbound → MCP claim → server-verified exact answer context →
local model decision → guarded MCP prepare/dispatch **or** audited human handoff.
`mcp-server/runtime/cycle.mjs` is shared with `src/lib/copilot/worker.ts` so the
CLI and application tests exercise the same queue protocol.

The credential-bearing host spawns only this fork's fixed MCP executable with
the copilot profile, writes enabled and broadcasts disabled. It holds API keys,
operator/session identities, work capabilities and revision generations outside
the model prompt. Model input contains bounded customer text and, when eligible,
one human-curated exact answer plus its source reference. Both customer and
source text are untrusted data. There is no tool execution, remote URL retrieval,
curation, free-form answer generation, credential access or cloud fallback in the
model boundary.

New `POST /api/v1/copilot/work` action `knowledge` takes `work_id` and
`work_token`; MCP tool `get_verified_reply_context` exposes it. It requires the
same current account/key/operator/session/ownership/inbound/worker generation
and read scopes as a claim. It returns only an enabled, unexpired, exact normalized
question match in the key's account, its human source reference, current policy
mode/revision and a reason. Risky/nontext/unmatched requests receive no candidate.
The read is not approval and cannot curate knowledge.

The model may return only a constrained JSON decision (`reply`/`handoff`, the
candidate ID or `none`, and an enumerated reason). The host strictly validates
this object and maps a valid routine selection to the **stored answer text**.
Generated text, identities, tools and permissions are never used as arguments.
Missing/expired/risky knowledge, invalid output or unavailable inference yield a
fixed human-review summary. Existing server checks revalidate policy, verified
knowledge, permissions, takeover, current inbound and leases at prepare/dispatch.
A tiny model's confidence or prompt compliance grants no authority.

The processing budget is at most 20 seconds, bounded by the claimed 30-second
worker lease minus a safety margin and capped by human expiry. Cancellation or a
late result cannot reach prepare; server fences reject delayed requests after
pause/restart/takeover/revocation. An inference timeout releases work back to the
durable queue and returns failure, not a successful handoff. A shorter deadline
may be selected by callers of `runWorkCycle`; no lease resurrection occurs.

Audited handoff/assignment now checkpoints `awaiting_human` and closes the active
attempt in the same transaction as assignment and reply cancellation. After a
lost response, inspect durable outcomes; do not invent success or retry a provider
attempt. A human may explicitly resolve queue work using the existing resolution
contract; this is not proof of delivery.

If policy/knowledge changes during inference, prepare may conservatively produce
an unapproved immutable draft. The generic callable cycle returns `leased` while
waiting for human approval. The **one-shot CLI releases** that draft to
`awaiting_human` because it cannot maintain the lease while waiting. Existing ownership triggers
cancel the unsent draft while retaining its immutable record. Recovery
requires a human; this does not create, approve or replace a second outbox entry.

## Pinned evaluation profile

`mcp-server/runtime/runtime-manifest.json` records artifact versions, URLs,
licenses, SHA-256 values and resource limits. No binary or model is in the repo.
On the evaluated Apple M3 (8 GiB RAM, 8 logical CPUs), the selected profile is:

- [llama.cpp b12001](https://github.com/ggml-org/llama.cpp/releases/tag/b12001),
  official macOS arm64 portable archive, [MIT](https://github.com/ggml-org/llama.cpp/blob/b12001/LICENSE).
- [Qwen/Qwen3-0.6B-GGUF](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/tree/23749fefcc72300e3a2ad315e1317431b06b590a),
  official Q8_0 artifact, 639,446,688 bytes,
  [Apache-2.0](https://huggingface.co/Qwen/Qwen3-0.6B-GGUF/blob/23749fefcc72300e3a2ad315e1317431b06b590a/LICENSE).
- CPU only, 2 generation/batch threads, one parallel slot, context 1,024 tokens,
  at most 128 generated tokens, temperature 0, seed 7, thinking disabled.

Licenses were read and hashes checked against the publisher's release/model
metadata before execution. Keep the respective notices with redistributed
artifacts. This is a bounded decision model evaluation, not a general business
assistant quality claim. The host was already under substantial memory/swap and
disk pressure; larger models or throughput targets need a separate evaluation.

## Explicit invocation

Download the exact official artifacts for your platform **outside the repository**;
verify their hashes against the manifest and inspect the license/available disk
and memory first. This implementation does not silently install or start a model.
Other platforms need their own runtime artifact verification and hardware evidence.
The executable's actual `--help` was checked for the flags below; the
[server API](https://github.com/ggml-org/llama.cpp/blob/b12001/tools/server/README.md)
supports the local OpenAI-compatible chat endpoint and constrained JSON output.
That wire format does not call OpenAI or require an OpenAI API key.

Example for the evaluated profile (replace paths; start manually):

```sh
env -i PATH=/usr/bin:/bin /absolute/path/llama-server \
  --model /absolute/path/Qwen3-0.6B-Q8_0.gguf --offline \
  --host 127.0.0.1 --port 11435 --alias wacrm-qwen3-0.6b-q8 \
  --ctx-size 1024 --parallel 1 --threads 2 --threads-batch 2 \
  --gpu-layers 0 --no-op-offload --no-ui --reasoning off \
  --cors-origins http://127.0.0.1:11435 --no-cors-credentials --poll 0
```

`--offline`, a local file and a clean environment avoid remote weight loading or
inherited server credentials. Keep the server bound to numeric loopback, with no
UI/MCP proxy/tool runner configured. Browser origins are restricted and CORS
credentials disabled in the tested invocation; this is a single-host evaluation,
not a multi-user inference authentication design. No resident service was installed in #6.
The profile must be stopped manually after use. The adapter requires a root
`http://127.0.0.1:<port>` or `http://[::1]:<port>` inference origin, refuses
redirects, sends no Authorization header, bounds the response and honors abort.

Build the existing fork MCP server first:

```sh
npm ci --prefix mcp-server
npm run build --prefix mcp-server
```

Set server-only `WACRM_BASE_URL`, `WACRM_API_KEY`, `WACRM_OPERATOR_ID`,
`WACRM_SESSION_ID`, `LOCAL_LLM_URL=http://127.0.0.1:11435` and optionally
`LOCAL_MODEL_ALIAS=wacrm-qwen3-0.6b-q8` through your secret-handling environment.
Do not paste real credentials into source, command history, prompts or reports.
The CRM origin requires HTTPS except for numeric loopback test servers. REST
requests refuse redirects and time out after 10 seconds; MCP calls time out after 15. Unknown outcomes still require inspection, not blind retries.

An eligible human must have explicitly started that exact session generation,
bound the scoped key and enabled the policy. Required scopes are `copilot:act`,
`copilot:crm`, `copilot:work`, `messages:read` and `conversations:read`.
These are prerequisites, not actions performed by the worker.

```sh
node mcp-server/runtime/cli.mjs --once
# or, from the repository root:
npm run runtime:once --prefix mcp-server
```

The CLI reads the current human generation before processing and emits one JSON
outcome. No work returns `idle`; reply completion is based on stored outbox
state; handoff is based on a persisted CRM action. Failure returns nonzero with a
credential-free message. Do not run these commands with live provider credentials
as part of Issue #6. The evaluation uses injected provider transport only.

## Reproducing bounded acceptance

`runtime.integration.test.ts` uses real loopback HTTP, the actual MCP SDK/stdio
subprocess, route handlers, canonical Postgres services and fake WhatsApp transport.
Its API-key authentication plumbing is an explicit SQL-backed fixture shim;
hosted auth/JWT routing, a deployed Next server, raw webhook receipt and Meta
transport are **not** covered by this harness. Existing route/auth/unit tests and
Postgres permission/race suites run separately.

Default tests inject deterministic local-model responses. The opt-in hardware
case calls an already running local model and records synthetic-only decisions,
tokens and latency:

```sh
COPILOT_TEST_DATABASE_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
LOCAL_LLM_URL=http://127.0.0.1:11435 \
LOCAL_EVALUATION_OUTPUT=/absolute/path/evaluation.json \
npm test -- src/lib/copilot/runtime.integration.test.ts --maxWorkers=1 --testTimeout=30000
```

Use a disposable local DB with all migrations applied, never a hosted database.
Build MCP before this suite. It covers routine replies, unknown/risky/injected
content, failures, documented CLI invocation, pause/restart, concurrent subprocess
workers, delayed results, takeover/key/role/policy/knowledge revocation and
foreign/stale knowledge capabilities. Existing queue tests additionally cover
expiry, restart generations, unknown provider attempts and ingress ordering.
CI runs deterministic tests with no model download or paid service. See
`docs/work/issue-6-results.md` and the evaluation JSON for actual hardware results
and their limits. No UI (#7), live acceptance (#8), deployment or merge is implied.
