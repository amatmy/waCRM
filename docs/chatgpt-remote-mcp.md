# ChatGPT remote MCP (Issue #15)

This is a single-operator, single-CRM-account Streamable HTTP MCP resource server.
ChatGPT uses the user's existing subscription interactively; there is no local
model, paid inference API, webhook listener or scheduled shift in this integration.
The service is not deployed by this PR. PRs #10–#13 remain unmerged dependencies.

## Boundary and authorization

`mcp-server/src/remote-entry.ts` starts the service on `127.0.0.1` only. Put a
trusted TLS reverse proxy on the same host in front of it and publish an HTTPS
`/mcp` URL. Only expose `/mcp` and
`/.well-known/oauth-protected-resource/mcp`; never expose the local port directly.
The public URL and OAuth issuer must be explicit HTTPS URLs; no forwarded header
is trusted to determine them. Server-held waCRM credentials are not sent to
ChatGPT. The service does not act as an OAuth authorization server: configure an
independent OAuth 2.1 provider with discovery, PKCE and ChatGPT client registration
(CIMD or DCR as supported). The resource metadata points ChatGPT at that issuer.

Each HTTP request verifies an OAuth access JWT with the configured pinned RSA
public key (at least 2048 bits) and `kid`; only `typ=at+jwt`, `alg=RS256`, exact
issuer, resource audience, subject and signed `tenant_id` are accepted. `iat`,
`exp`, optional `nbf`, and a maximum 15-minute lifetime are enforced. A trusted
provider must issue those claims, protect the tenant claim from user editing,
and use the configured resource URL as audience. The access token needs
`wacrm.read`; `wacrm.write` plus explicit `MCP_ENABLE_WRITES=true` exposes guarded
write tools. Request both scopes during enrollment when write access is intended;
read-only tokens cannot discover those tools, so a scope upgrade may require
reconnecting and refreshing the tool list. All checks run again for each HTTP call, including after the account
identity lookup. OAuth metadata is attached to individual tool descriptors.

The service is deliberately restricted to one configured OAuth subject, tenant,
waCRM account and operator. On every authorized request it checks `/api/v1/me`
using the server-held waCRM API key and rejects a mismatched or revoked account.
The CRM still enforces key scopes, active human session, binding/role, ownership,
latest inbound, work lease, takeover, policy, outbox/idempotency and eligibility.
The OAuth token grants no independent authority to bypass those checks. Server
writes default off; there is no legacy raw send, approval, session activation or
broadcast tool in the copilot profile. A queued handoff preserves its durable
human-review state and closes the attempt atomically.

The public key is pinned at startup: arrange supervised rotation and restart.
JWT revocation or membership changes at the identity provider are not checked
online between issuance and expiry; short expiry bounds but does not eliminate
that window. The CRM key is checked on every request. This prototype does not
provide multi-user credential brokering, automatic JWKS rotation or a complete
identity-provider implementation. No deployment/security review is implied.

## Configuration and future HTTPS setup

Provide these values through a server-side secret manager, not source control,
chat prompts or command history. Values shown are names, not working credentials:

- `MCP_RESOURCE_URL`: e.g. `https://mcp.example.com/mcp`.
- `MCP_OAUTH_ISSUER`: exact HTTPS issuer URL, with an OAuth discovery document.
- `MCP_OAUTH_PUBLIC_KEY`: issuer's PEM **public** signing key; actual newlines or
  escaped `\n` are accepted; never supply the private key.
- `MCP_OAUTH_KEY_ID`: exact JWT `kid` for that pinned public key.
- `MCP_OAUTH_SUBJECT`, `MCP_OAUTH_TENANT`: authorized issuer subject and signed
  tenant claim for the single configured user. These values must be managed by
  the identity provider, not supplied as MCP tool arguments.
- `WACRM_BASE_URL`, `WACRM_ACCOUNT_ID`, `WACRM_OPERATOR_ID`, `WACRM_API_KEY`:
  the CRM origin, account, bound operator UUID and server-only scoped CRM key.
  Remote CRM origins require HTTPS; numeric loopback HTTP is for test fixtures.
- `MCP_ENABLE_WRITES`: default off; set `true` only after the OAuth provider,
  account plan and guarded tools have been reviewed and tested. A write-scoped
  token is also required. `MCP_PORT` defaults to 3001 on loopback.

Build with `npm ci --prefix mcp-server` and `npm run build --prefix mcp-server`;
run explicitly with `npm run start:remote --prefix mcp-server`. A representative
reverse-proxy configuration, to be reviewed for the actual host/certificate:

```nginx
server {
  listen 443 ssl;
  server_name mcp.example.com;
  ssl_certificate /path/to/fullchain.pem;
  ssl_certificate_key /path/to/private-key.pem;
  location = /mcp {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
    proxy_set_header Authorization $http_authorization;
    client_max_body_size 128k;
  }
  location = /.well-known/oauth-protected-resource/mcp {
    proxy_pass http://127.0.0.1:3001;
    proxy_set_header Host $host;
  }
  location / { return 404; }
}
```

This example is not a deployment. Before exposing it, configure certificate,
provider discovery/client registration, PKCE, audience, claims, scopes, token
lifetimes, reverse-proxy rate limits and a secret manager. Validate per-user
permissions and complete security review. A short-lived signed JWT does not by
itself prove that a subject remains authorized at the provider after issuance.

When independently authorized to connect, use the actual public HTTPS `/mcp` URL
in ChatGPT's custom app/connector setup and complete OAuth linking. Test reads
first, then guarded writes only where that ChatGPT client and plan permit them.
Consult [OpenAI authentication documentation](https://developers.openai.com/plugins/build/auth)
and [custom MCP setup](https://developers.openai.com/api/docs/guides/custom-mcp-server).
Plan availability varies; the user's plan and actual tool invocation have not
been verified. Interactive chat is not a continuous webhook consumer.

## Test scope

`npm test --prefix mcp-server` uses the actual MCP SDK client over loopback HTTP,
synthetic RSA tokens and an injected HTTP CRM fixture. It verifies initialization,
metadata, scoped discovery, reads, guarded handoff forwarding, account/tenant and
scope isolation, invalid tokens and concurrent sessions. The fixture is not a
real OAuth provider, hosted ChatGPT connector, production reverse proxy, real
WhatsApp or deployed CRM. Existing isolated Postgres suites independently test
the server-side guarded actions and races. Details: `docs/work/issue-15-results.md`.
