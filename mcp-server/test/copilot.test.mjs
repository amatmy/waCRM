// Protocol tests use synthetic CRM data and never call Meta or an AI provider.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { spawnSync } from 'node:child_process';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const operator = '00000000-0000-4000-8000-000000000001';
const config = {
  WACRM_BASE_URL: 'http://127.0.0.1:1',
  WACRM_API_KEY: 'synthetic-read-only-key',
  WACRM_COPILOT_MODE: 'true',
  WACRM_OPERATOR_ID: operator,
  WACRM_ENABLE_WRITES: 'false',
  WACRM_ENABLE_BROADCASTS: 'false',
};

test('legacy MCP tool discovery remains compatible; the server enforces send policy', async (t) => {
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    stderr: 'pipe',
    env: {
      ...process.env,
      ...config,
      WACRM_COPILOT_MODE: 'false',
      WACRM_ENABLE_WRITES: 'true',
    },
  });
  const client = new Client({
    name: 'legacy-compatibility-test',
    version: '1.0.0',
  });
  await client.connect(transport);
  t.after(() => client.close());
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes('send_message'));
  assert.ok(!names.includes('get_copilot_session'));
  assert.ok(!names.includes('send_broadcast'));
});

for (const [name, overrides, expected] of [
  [
    'broadcast bypass',
    { WACRM_ENABLE_BROADCASTS: 'true' },
    /Copilot broadcasts are disabled/,
  ],
  ['missing operator', { WACRM_OPERATOR_ID: '' }, /requires WACRM_OPERATOR_ID/],
]) {
  test(`copilot startup rejects ${name}`, () => {
    const result = spawnSync(process.execPath, ['dist/index.js'], {
      env: { ...process.env, ...config, ...overrides },
      encoding: 'utf8',
      timeout: 10000,
    });
    assert.equal(result.status, 1);
    assert.match(result.stderr, expected);
    assert.equal(result.stdout, '');
  });
}

test('MCP initialize, tool list and CRM reads work over stdio without inference', async (t) => {
  const requests = [];
  let state = 'active';
  let denied = false;
  const http = createServer((req, res) => {
    requests.push({
      method: req.method,
      url: req.url,
      auth: req.headers.authorization,
    });
    res.setHeader('Content-Type', 'application/json');
    if (denied) {
      res.writeHead(403).end(
        JSON.stringify({
          error: { code: 'forbidden', message: 'Missing scope' },
        })
      );
    } else if (req.url.startsWith('/api/v1/copilot/session')) {
      res.end(JSON.stringify({ data: { state, operator_id: operator } }));
    } else if (req.url === '/api/v1/me') {
      res.end(
        JSON.stringify({
          data: {
            account: { id: 'synthetic-account' },
            key: { scopes: ['conversations:read'] },
          },
        })
      );
    } else {
      res.end(
        JSON.stringify({
          data: [{ id: 'synthetic-record' }],
          meta: { next_cursor: 'synthetic-cursor' },
        })
      );
    }
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => http.close(resolve)));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    env: {
      ...process.env,
      ...config,
      WACRM_BASE_URL: `http://127.0.0.1:${http.address().port}`,
    },
    stderr: 'pipe',
  });
  const client = new Client({ name: 'copilot-fixture-test', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  assert.ok(names.includes('get_copilot_session'));
  for (const forbidden of [
    'send_message',
    'create_contact',
    'update_contact',
    'send_broadcast',
    'start_shift',
    'start_session',
  ]) {
    assert.ok(!names.includes(forbidden), forbidden);
  }
  const parse = (result) => JSON.parse(result.content[0].text);
  assert.equal(
    parse(await client.callTool({ name: 'whoami', arguments: {} })).data.account
      .id,
    'synthetic-account'
  );
  const conversations = parse(
    await client.callTool({
      name: 'list_conversations',
      arguments: { limit: 2, cursor: 'next' },
    })
  );
  assert.equal(conversations.next_cursor, 'synthetic-cursor');
  await client.callTool({
    name: 'list_messages',
    arguments: { conversation_id: 'synthetic-record', limit: 2 },
  });
  for (state of ['active', 'paused', 'expired', 'inactive']) {
    assert.equal(
      parse(
        await client.callTool({ name: 'get_copilot_session', arguments: {} })
      ).data.state,
      state
    );
  }
  const sessionRequests = requests.filter((req) =>
    req.url.startsWith('/api/v1/copilot/session')
  );
  assert.equal(sessionRequests.length, 4);
  assert.ok(
    sessionRequests.every(
      (req) =>
        new URL(req.url, 'http://fixture').searchParams.get('operator_id') ===
        operator
    )
  );
  assert.ok(
    requests.every(
      (req) =>
        req.method === 'GET' && req.auth === `Bearer ${config.WACRM_API_KEY}`
    )
  );
  denied = true;
  const result = await client.callTool({
    name: 'get_copilot_session',
    arguments: {},
  });
  assert.equal(result.isError, true);
  assert.match(result.content[0].text, /forbidden/);
  const before = requests.length;
  const blocked = await client.callTool({
    name: 'send_message',
    arguments: { to: '+000', text: 'must not send' },
  });
  assert.equal(blocked.isError, true);
  assert.equal(requests.length, before);
});

test('guarded copilot writes expose no raw send, approval or activation tool', async (t) => {
  const actions = [];
  const http = createServer(async (req, res) => {
    let body = '';
    for await (const chunk of req) body += chunk;
    actions.push({ path: req.url, method: req.method, body: JSON.parse(body) });
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ data: { id: operator, state: 'draft' } }));
  });
  await new Promise((resolve) => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise((resolve) => http.close(resolve)));
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: ['dist/index.js'],
    stderr: 'pipe',
    env: {
      ...process.env,
      ...config,
      WACRM_ENABLE_WRITES: 'true',
      WACRM_BASE_URL: `http://127.0.0.1:${http.address().port}`,
    },
  });
  const client = new Client({ name: 'guarded-copilot', version: '1.0.0' });
  await client.connect(transport);
  t.after(() => client.close());
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of [
    'claim_conversation',
    'prepare_authorized_reply',
    'get_reply_outcome',
    'send_authorized_reply',
    'handoff_to_human',
  ])
    assert.ok(names.includes(name));
  for (const name of [
    'send_message',
    'send_broadcast',
    'create_contact',
    'update_contact',
    'approve_reply',
    'start_session',
    'takeover_conversation',
  ])
    assert.ok(!names.includes(name));
  await client.callTool({
    name: 'claim_conversation',
    arguments: { conversation_id: operator, session_id: operator },
  });
  await client.callTool({
    name: 'prepare_authorized_reply',
    arguments: {
      conversation_id: operator,
      session_id: operator,
      ownership_revision: '1',
      inbound_id: operator,
      idempotency_key: 'synthetic-key',
      text: 'Synthetic draft',
    },
  });
  await client.callTool({
    name: 'get_reply_outcome',
    arguments: { outbox_id: operator },
  });
  await client.callTool({
    name: 'send_authorized_reply',
    arguments: { outbox_id: operator },
  });
  await client.callTool({
    name: 'handoff_to_human',
    arguments: {
      conversation_id: operator,
      ownership_revision: '1',
      summary: 'Synthetic handoff',
    },
  });
  assert.deepEqual(
    actions.map((a) => a.body.action),
    ['claim', 'prepare', 'inspect', 'dispatch', 'handoff']
  );
  assert.ok(
    actions.every(
      (a) =>
        a.method === 'POST' &&
        a.path === '/api/v1/copilot/actions' &&
        !('operator_id' in a.body)
    )
  );
});
