import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';

/** Credential-bearing host adapter. Model code never receives this object. */
export class RuntimeClient {
  constructor(client) {
    this.client = client;
    this.leases = new Map();
  }
  async call(name, args = {}) {
    const result = await this.client.callTool(
      { name, arguments: args },
      undefined,
      { timeout: 15000 }
    );
    if (result.isError) throw new Error(`Guarded CRM tool failed: ${name}`);
    const text = result.content.find((c) => c.type === 'text')?.text;
    if (typeof text !== 'string' || text.length > 131072)
      throw new Error('Invalid CRM tool response');
    const value = JSON.parse(text);
    if (!value || !Object.hasOwn(value, 'data'))
      throw new Error('Invalid CRM envelope');
    return value.data;
  }
  session() {
    return this.call('get_copilot_session');
  }
  reconcile() {
    return this.call('reconcile_inbound_work');
  }
  async claim(sessionId) {
    const job = await this.call('claim_next_inbound_work', {
      session_id: sessionId,
    });
    if (job?.state === 'leased' && job.lease_token)
      this.leases.set(job.id, job.lease_token);
    return job;
  }
  claimedToken(workId) {
    return this.leases.get(workId);
  }
  knowledge(workId, token) {
    return this.call('get_verified_reply_context', {
      work_id: workId,
      work_token: token,
    });
  }
  renew(workId, token) {
    return this.call('renew_inbound_work', {
      work_id: workId,
      work_token: token,
    });
  }
  prepare(input) {
    return this.call('prepare_authorized_reply', input);
  }
  dispatch(outboxId) {
    return this.call('send_authorized_reply', { outbox_id: outboxId });
  }
  settle(workId, token) {
    return this.call('settle_inbound_work', {
      work_id: workId,
      work_token: token,
    });
  }
  release(workId, token) {
    return this.call('release_inbound_work', {
      work_id: workId,
      work_token: token,
    });
  }
  handoff(input) {
    return this.call('handoff_to_human', input);
  }
  close() {
    return this.client.close();
  }
}
/** Starts only the fixed fork MCP process. This never starts/renews a human session. */
export async function connectRuntime({ baseUrl, apiKey, operatorId }) {
  const origin = new URL(baseUrl);
  if (
    !['https:', 'http:'].includes(origin.protocol) ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash ||
    origin.pathname !== '/'
  )
    throw new Error('CRM origin required');
  if (
    origin.protocol === 'http:' &&
    !['127.0.0.1', '[::1]'].includes(origin.hostname)
  )
    throw new Error('Remote CRM requires HTTPS');
  if (!apiKey || !/^[0-9a-f-]{36}$/i.test(operatorId))
    throw new Error('Explicit CRM credentials/operator required');
  const client = new Client({ name: 'wacrm-local-runtime', version: '0.1.0' });
  const transport = new StdioClientTransport({
    command: process.execPath,
    args: [fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    stderr: 'pipe',
    env: {
      PATH: process.env.PATH ?? '',
      WACRM_BASE_URL: origin.origin,
      WACRM_API_KEY: apiKey,
      WACRM_OPERATOR_ID: operatorId,
      WACRM_COPILOT_MODE: 'true',
      WACRM_ENABLE_WRITES: 'true',
      WACRM_ENABLE_BROADCASTS: 'false',
    },
  });
  try {
    await client.connect(transport);
    const names = (await client.listTools()).tools.map((t) => t.name);
    for (const name of [
      'claim_next_inbound_work',
      'get_verified_reply_context',
      'prepare_authorized_reply',
      'send_authorized_reply',
      'handoff_to_human',
    ])
      if (!names.includes(name))
        throw new Error('Required guarded MCP tool missing');
    return new RuntimeClient(client);
  } catch (error) {
    await client.close().catch(() => {});
    throw error;
  }
}
