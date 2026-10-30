import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { createRemoteServer, loadRemoteConfig } from '../dist/remote.js';
const operator = '00000000-0000-4000-8000-000000000001';
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const encoder = (x) => Buffer.from(JSON.stringify(x)).toString('base64url');
function jwt(overrides = {}, header = {}) {
  const a = encoder({
      typ: 'at+jwt',
      alg: 'RS256',
      kid: 'fixture-key',
      ...header,
    }),
    b = encoder({
      iss: 'https://identity.example',
      aud: 'https://crm.example/mcp',
      sub: 'operator-subject',
      tenant_id: 'tenant-a',
      scope: 'wacrm.read',
      iat: Math.floor(Date.now() / 1000),
      exp: Math.floor(Date.now() / 1000) + 300,
      ...overrides,
    });
  return `${a}.${b}.${sign('RSA-SHA256', Buffer.from(`${a}.${b}`), keys.privateKey).toString('base64url')}`;
}
async function fixture(
  t,
  enableWrites = false,
  backendAccount = 'crm-account',
  delayMs = 0
) {
  const requests = [];
  const backend = createServer(async (req, res) => {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    if (delayMs) await new Promise((resolve) => setTimeout(resolve, delayMs));
    requests.push({
      path: req.url,
      auth: req.headers.authorization,
      body: Buffer.concat(chunks).toString(),
    });
    res.setHeader('content-type', 'application/json');
    res.end(
      JSON.stringify({
        data:
          req.url === '/api/v1/me'
            ? { account: { id: backendAccount } }
            : { id: operator, state: 'draft' },
      })
    );
  });
  backend.listen(0, '127.0.0.1');
  await once(backend, 'listening');
  const cfg = loadRemoteConfig({
    MCP_RESOURCE_URL: 'https://crm.example/mcp',
    MCP_OAUTH_ISSUER: 'https://identity.example',
    MCP_OAUTH_PUBLIC_KEY: keys.publicKey.export({
      type: 'spki',
      format: 'pem',
    }),
    MCP_OAUTH_KEY_ID: 'fixture-key',
    MCP_OAUTH_SUBJECT: 'operator-subject',
    MCP_OAUTH_TENANT: 'tenant-a',
    WACRM_OPERATOR_ID: operator,
    WACRM_ACCOUNT_ID: 'crm-account',
    WACRM_BASE_URL: `http://127.0.0.1:${backend.address().port}`,
    WACRM_API_KEY: 'synthetic-server-key',
    MCP_ENABLE_WRITES: String(enableWrites),
  });
  const server = createRemoteServer(cfg);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const url = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    for (const s of [server, backend]) {
      s.closeAllConnections();
      await new Promise((resolve) => s.close(resolve));
    }
  });
  return { url, requests };
}
async function connect(url, token) {
  const client = new Client({ name: 'fixture', version: '1' });
  await client.connect(
    new StreamableHTTPClientTransport(new URL(`${url}/mcp`), {
      requestInit: { headers: { Authorization: `Bearer ${token}` } },
    })
  );
  return client;
}
test('OAuth metadata and fail-closed bearer validation', async (t) => {
  const { url, requests } = await fixture(t, true);
  const meta = await (
    await fetch(`${url}/.well-known/oauth-protected-resource/mcp`)
  ).json();
  assert.deepEqual(meta.authorization_servers, ['https://identity.example']);
  assert.equal(meta.resource, 'https://crm.example/mcp');
  for (const token of [
    '',
    jwt({ exp: 1 }),
    jwt({ aud: 'https://wrong.example/mcp' }),
    jwt({ iss: 'https://wrong.example' }),
    jwt({}, { kid: 'wrong-key' }),
    jwt({ tenant_id: 'tenant-b' }),
    jwt({ sub: 'other' }),
    jwt({ scope: 'wacrm.write' }),
    jwt({ exp: Math.floor(Date.now() / 1000) + 3600 }),
    jwt({ iat: Math.floor(Date.now() / 1000) + 100 }),
    jwt({ nbf: Math.floor(Date.now() / 1000) + 60 }),
    jwt({}, { alg: 'none' }),
    jwt({}, { typ: 'JWT' }),
    jwt().slice(0, -5) + 'abcde',
  ]) {
    const response = await fetch(`${url}/mcp`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    });
    assert.equal(response.status, 401);
    assert.match(response.headers.get('www-authenticate'), /resource_metadata/);
  }
  assert.equal(requests.length, 0);
});
test('SDK initialize, read-only discovery and account-scoped synthetic CRM read', async (t) => {
  const { url, requests } = await fixture(t, true);
  const client = await connect(url, jwt());
  t.after(() => client.close());
  const list = (await client.listTools()).tools;
  assert.ok(
    list.every((x) => x._meta?.securitySchemes?.[0]?.type === 'oauth2')
  );
  const names = list.map((x) => x.name);
  assert.ok(names.includes('list_conversations'));
  assert.ok(!names.includes('send_message'));
  assert.ok(!names.includes('send_broadcast'));
  assert.ok(!names.includes('get_broadcast'));
  assert.ok(!names.includes('handoff_to_human'));
  assert.equal(
    (await client.callTool({ name: 'handoff_to_human', arguments: {} }))
      .isError,
    true
  );
  assert.ok(!requests.some((r) => r.path === '/api/v1/copilot/crm'));
  const result = await client.callTool({
    name: 'list_conversations',
    arguments: {},
  });
  assert.notEqual(result.isError, true);
  assert.ok(requests.some((r) => /conversations/.test(r.path)));
  assert.ok(requests.every((r) => r.auth === 'Bearer synthetic-server-key'));
  assert.ok(!JSON.stringify(result).includes('synthetic-server-key'));
});
test('write scope exposes guarded handoff only and forwards server-held key, not model-supplied identity', async (t) => {
  const { url, requests } = await fixture(t, true);
  const client = await connect(url, jwt({ scope: 'wacrm.read wacrm.write' }));
  t.after(() => client.close());
  const names = (await client.listTools()).tools.map((x) => x.name);
  assert.ok(names.includes('handoff_to_human'));
  assert.ok(!names.includes('send_message'));
  assert.ok(!names.includes('send_broadcast'));
  assert.ok(!names.includes('get_broadcast'));
  const result = await client.callTool({
    name: 'handoff_to_human',
    arguments: {
      conversation_id: operator,
      session_id: operator,
      ownership_revision: '1',
      inbound_id: operator,
      idempotency_key: 'synthetic-id',
      summary: 'Synthetic handoff',
    },
  });
  assert.notEqual(result.isError, true);
  const request = requests.find((r) => r.path === '/api/v1/copilot/crm');
  assert.ok(request);
  assert.equal(JSON.parse(request.body).action, 'handoff');
  assert.equal(request.auth, 'Bearer synthetic-server-key');
});
test('server defaults to read-only even with a write token and isolates concurrent tokens', async (t) => {
  const { url } = await fixture(t, false);
  const [a, b] = await Promise.all([
    connect(url, jwt({ scope: 'wacrm.read wacrm.write' })),
    connect(url, jwt()),
  ]);
  t.after(() => Promise.all([a.close(), b.close()]));
  for (const c of [a, b])
    assert.ok(
      !(await c.listTools()).tools.some((x) => x.name === 'handoff_to_human')
    );
});

test('backend key for a different CRM account cannot be used, even with a valid OAuth token', async (t) => {
  const { url, requests } = await fixture(t, true, 'other-account');
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt()}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(response.status, 403);
  assert.deepEqual(
    requests.map((r) => r.path),
    ['/api/v1/me']
  );
});
test('read-only and write-authorized sessions remain isolated under concurrency', async (t) => {
  const { url } = await fixture(t, true);
  const [a, b] = await Promise.all([
    connect(url, jwt({ scope: 'wacrm.read wacrm.write' })),
    connect(url, jwt()),
  ]);
  t.after(() => Promise.all([a.close(), b.close()]));
  const [write, read] = await Promise.all([a.listTools(), b.listTools()]);
  assert.ok(write.tools.some((x) => x.name === 'handoff_to_human'));
  assert.ok(!read.tools.some((x) => x.name === 'handoff_to_human'));
});

test('escaped newline public PEM is accepted and private PEM is rejected', () => {
  const env = {
    MCP_RESOURCE_URL: 'https://crm.example/mcp',
    MCP_OAUTH_ISSUER: 'https://identity.example',
    MCP_OAUTH_PUBLIC_KEY: keys.publicKey
      .export({ type: 'spki', format: 'pem' })
      .replaceAll(String.fromCharCode(10), String.fromCharCode(92) + 'n'),
    MCP_OAUTH_KEY_ID: 'fixture-key',
    MCP_OAUTH_SUBJECT: 'operator-subject',
    MCP_OAUTH_TENANT: 'tenant-a',
    WACRM_OPERATOR_ID: operator,
    WACRM_ACCOUNT_ID: 'crm-account',
    WACRM_BASE_URL: 'https://crm.example',
    WACRM_API_KEY: 'synthetic',
  };
  assert.ok(loadRemoteConfig(env).publicKey);
  assert.throws(() =>
    loadRemoteConfig({
      ...env,
      MCP_OAUTH_PUBLIC_KEY: keys.privateKey.export({
        type: 'pkcs8',
        format: 'pem',
      }),
    })
  );
});

test('CRM client refuses credential-bearing redirects and redacts a reflected key in errors', async (t) => {
  const { WacrmClient } = await import('../dist/client.js');
  let hits = 0;
  const target = createServer((_req, res) => {
    hits++;
    res.end('{}');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const source = createServer((req, res) => {
    if (req.url === '/api/v1/me') {
      res.writeHead(307, {
        Location: `http://127.0.0.1:${target.address().port}`,
      });
      res.end();
    } else {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          error: { code: 'forbidden', message: 'reflected synthetic-secret' },
        })
      );
    }
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  t.after(async () => {
    for (const s of [source, target]) {
      s.closeAllConnections();
      await new Promise((resolve) => s.close(resolve));
    }
  });
  const client = new WacrmClient({
    baseUrl: `http://127.0.0.1:${source.address().port}`,
    apiKey: 'synthetic-secret',
  });
  await assert.rejects(client.me());
  assert.equal(hits, 0);
  await assert.rejects(
    client.listConversations({}),
    (e) =>
      !e.message.includes('synthetic-secret') &&
      e.message.includes('[redacted]')
  );
});

test('wire tool descriptors carry OAuth security schemes and validated JSON schemas', async (t) => {
  const { url } = await fixture(t, true);
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${jwt({ scope: 'wacrm.read wacrm.write' })}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': '2025-06-18',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(response.status, 200);
  const payload = await response.json();
  const handoff = payload.result.tools.find(
    (x) => x.name === 'handoff_to_human'
  );
  const read = payload.result.tools.find(
    (x) => x.name === 'list_conversations'
  );
  assert.deepEqual(handoff.securitySchemes, [
    { type: 'oauth2', scopes: ['wacrm.read', 'wacrm.write'] },
  ]);
  assert.deepEqual(read.securitySchemes, [
    { type: 'oauth2', scopes: ['wacrm.read'] },
  ]);
  assert.equal(handoff.inputSchema.type, 'object');
  assert.ok(handoff.inputSchema.required.includes('session_id'));
});

test('token expiring during CRM identity lookup receives an OAuth challenge and cannot invoke a tool', async (t) => {
  const { url, requests } = await fixture(t, true, 'crm-account', 2200);
  const token = jwt({ exp: Math.floor(Date.now() / 1000) + 2 });
  const response = await fetch(`${url}/mcp`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
    },
    body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' }),
  });
  assert.equal(response.status, 401);
  assert.match(response.headers.get('www-authenticate'), /resource_metadata/);
  assert.deepEqual(
    requests.map((x) => x.path),
    ['/api/v1/me']
  );
});
