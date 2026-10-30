import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { RuntimeClient, connectRuntime } from '../runtime/client.mjs';
import { WacrmClient } from '../dist/client.js';

test('host adapter invokes only fixed guarded tools and keeps its claimed capability', async () => {
  const calls = [];
  const client = new RuntimeClient({
    callTool: async ({ name, arguments: args }, _schema, options) => {
      calls.push({ name, args, options });
      return {
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              data:
                name === 'claim_next_inbound_work'
                  ? { id: 'work', state: 'leased', lease_token: 'host-only' }
                  : { state: 'completed' },
            }),
          },
        ],
      };
    },
  });
  await client.claim('human-session');
  assert.equal(client.claimedToken('work'), 'host-only');
  await client.knowledge('work', 'host-only');
  await client.renew('work', 'host-only');
  await client.prepare({ text: 'stored-answer' });
  await client.dispatch('outbox');
  await client.settle('work', 'host-only');
  await client.release('work', 'host-only');
  await client.handoff({ summary: 'review' });
  assert.deepEqual(
    calls.map((c) => c.name),
    [
      'claim_next_inbound_work',
      'get_verified_reply_context',
      'renew_inbound_work',
      'prepare_authorized_reply',
      'send_authorized_reply',
      'settle_inbound_work',
      'release_inbound_work',
      'handoff_to_human',
    ]
  );
  assert.ok(calls.every((c) => c.options.timeout === 15000));
});
test('tool errors and malformed envelopes never claim successful CRM outcomes', async () => {
  for (const result of [
    { isError: true, content: [] },
    { content: [{ type: 'text', text: '{}' }] },
    { content: [{ type: 'text', text: 'x'.repeat(140000) }] },
  ]) {
    const client = new RuntimeClient({ callTool: async () => result });
    await assert.rejects(client.dispatch('outbox'));
  }
});
test('runtime rejects ambiguous/insecure CRM origins before starting a subprocess', async () => {
  for (const baseUrl of [
    'http://example.com',
    'https://user:secret@example.com',
    'https://example.com/path',
    'https://example.com?token=secret',
  ])
    await assert.rejects(
      connectRuntime({
        baseUrl,
        apiKey: 'synthetic',
        operatorId: '00000000-0000-4000-8000-000000000001',
      })
    );
});
test('credential-bearing REST requests refuse redirects to other endpoints', async (t) => {
  let redirected = 0;
  const target = createServer((_req, res) => {
    redirected++;
    res.end('{}');
  });
  target.listen(0, '127.0.0.1');
  await once(target, 'listening');
  const source = createServer((_req, res) => {
    res.writeHead(307, {
      Location: `http://127.0.0.1:${target.address().port}`,
    });
    res.end();
  });
  source.listen(0, '127.0.0.1');
  await once(source, 'listening');
  t.after(async () => {
    for (const server of [source, target]) {
      server.closeAllConnections();
      await new Promise((resolve) => server.close(resolve));
    }
  });
  const client = new WacrmClient({
    baseUrl: `http://127.0.0.1:${source.address().port}`,
    apiKey: 'synthetic-key',
  });
  await assert.rejects(client.copilotWork({ action: 'reconcile' }));
  assert.equal(redirected, 0);
});
