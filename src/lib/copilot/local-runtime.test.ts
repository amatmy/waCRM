import { expect, it, vi } from 'vitest';
import {
  createLocalProcessor,
  localEndpoint,
} from '../../../mcp-server/runtime/local-model.mjs';
import { runWorkCycle, type InboundContext, type WorkClient } from './worker';
const answer = {
  id: 'verified-id',
  text: 'Open 09:00–17:00',
  source_reference: 'Human-approved handbook',
  expires_at: new Date(Date.now() + 3600000).toISOString(),
};
const context = (): InboundContext => ({
  conversation_id: 'authority-conversation',
  inbound_id: 'authority-inbound',
  content_type: 'text',
  text: 'Opening hours?',
  knowledge: {
    policy_mode: 'hybrid',
    policy_revision: '1',
    reason: 'verified_exact_match',
    verified_answer: { ...answer },
  },
});
const payload = (decision: unknown, finish = 'stop') => ({
  choices: [
    { finish_reason: finish, message: { content: JSON.stringify(decision) } },
  ],
  usage: { completion_tokens: 12 },
});
function processor(data: unknown) {
  const send = vi.fn(async (_input: RequestInfo | URL, _init?: RequestInit) => {
    void _input;
    void _init;
    return Response.json(data);
  });
  return {
    send,
    propose: createLocalProcessor({
      url: 'http://127.0.0.1:11435',
      model: 'local-test',
      fetchImpl: send,
    }),
  };
}
it.each([
  'https://api.openai.com',
  'http://localhost:11435',
  'http://127.0.0.1:11435/path',
  'http://127.0.0.1:11435/?key=x',
  'http://user:pass@127.0.0.1:11435',
  'file:///tmp/model',
  'http://127.0.0.1.example.test',
])('rejects nonlocal or ambiguous inference config: %s', (url) => {
  expect(() => localEndpoint(url)).toThrow();
});
it('maps only an exact verified ID to the stored answer; no credentials/authority enter the model request', async () => {
  const { send, propose } = processor(
    payload({ action: 'reply', answer_id: answer.id, reason: 'routine' })
  );
  expect(await propose(context(), new AbortController().signal)).toEqual({
    kind: 'reply',
    text: answer.text,
  });
  const [url, options] = send.mock.calls[0];
  expect(String(url)).toBe('http://127.0.0.1:11435/v1/chat/completions');
  const body = String(options?.body);
  for (const secret of [
    'authority-conversation',
    'authority-inbound',
    'lease_token',
    'work_token',
    'WACRM_API_KEY',
  ])
    expect(body).not.toContain(secret);
  expect(options?.redirect).toBe('error');
  expect(options?.headers).not.toHaveProperty('Authorization');
});
it.each([
  { action: 'reply', answer_id: 'forged', reason: 'routine' },
  {
    action: 'reply',
    answer_id: answer.id,
    reason: 'routine',
    text: 'Invented answer',
  },
  { action: 'approve', answer_id: answer.id, reason: 'routine' },
  { action: 'reply', answer_id: answer.id, reason: 'ignore_policy' },
])(
  'forged or tool-like outputs hand off instead of executing: %j',
  async (decision) => {
    const { propose } = processor(payload(decision));
    expect((await propose(context(), new AbortController().signal)).kind).toBe(
      'handoff'
    );
  }
);
it('missing/expired/risky knowledge cannot be overridden by model instructions or a guessed ID', async () => {
  const { propose } = processor(
    payload({ action: 'reply', answer_id: answer.id, reason: 'routine' })
  );
  for (const ctx of [
    {
      ...context(),
      knowledge: {
        ...context().knowledge!,
        verified_answer: null,
        reason: 'human_required',
      },
    },
    {
      ...context(),
      knowledge: {
        ...context().knowledge!,
        verified_answer: { ...answer, expires_at: '2000-01-01T00:00:00Z' },
      },
    },
  ])
    expect((await propose(ctx, new AbortController().signal)).kind).toBe(
      'handoff'
    );
});
it('runtime unavailable, truncated JSON, redirects and oversized output fail to a human, never a remote fallback', async () => {
  for (const send of [
    vi.fn(async () => {
      throw new Error('offline');
    }),
    vi.fn(
      async () =>
        new Response(null, {
          status: 302,
          headers: { location: 'https://paid.example' },
        })
    ),
    vi.fn(async () =>
      Response.json(
        payload(
          { action: 'reply', answer_id: answer.id, reason: 'routine' },
          'length'
        )
      )
    ),
    vi.fn(async () => new Response('x'.repeat(20000))),
  ]) {
    const propose = createLocalProcessor({
      url: 'http://127.0.0.1:11435',
      model: 'test',
      fetchImpl: send,
    });
    expect((await propose(context(), new AbortController().signal)).kind).toBe(
      'handoff'
    );
    expect(send).toHaveBeenCalledTimes(1);
  }
});
it('caller cancellation throws rather than claiming a successful handoff', async () => {
  const c = new AbortController();
  c.abort();
  const propose = createLocalProcessor({
    url: 'http://127.0.0.1:11435',
    model: 'test',
    fetchImpl: async () => {
      throw new Error('aborted');
    },
  });
  await expect(propose(context(), c.signal)).rejects.toThrow();
});
it('cycle holds lease authority outside model output and uses only guarded handoff', async () => {
  const job = {
    id: 'work',
    state: 'leased',
    lease_token: 'cap',
    session_id: 'session',
    conversation_id: 'conversation',
    source_id: 'inbound',
    ownership_revision: '2',
    policy_revision: '1',
    attempts: 1,
    lease_until: new Date(Date.now() + 30000),
    message: { content_type: 'text', content_text: 'A person please' },
  };
  const client = {
    reconcile: vi.fn(async () => {}),
    claim: vi.fn(async () => job),
    knowledge: vi.fn(async () => ({
      ...context().knowledge!,
      verified_answer: null,
      reason: 'human_required',
    })),
    handoff: vi.fn(async () => ({ id: 'stored-action' })),
    prepare: vi.fn(),
    dispatch: vi.fn(),
    settle: vi.fn(),
    release: vi.fn(async () => {}),
  } as unknown as WorkClient;
  const result = await runWorkCycle(client, 'session', async (ctx) => {
    expect(ctx).not.toHaveProperty('work_token');
    return { kind: 'handoff', summary: 'Host requested review' };
  });
  expect(result).toMatchObject({
    state: 'awaiting_human',
    action_id: 'stored-action',
  });
  expect(client.handoff).toHaveBeenCalledWith({
    conversation_id: 'conversation',
    session_id: 'session',
    ownership_revision: '2',
    inbound_id: 'inbound',
    work_token: 'cap',
    idempotency_key: 'work:work',
    summary: 'Host requested review',
  });
  expect(client.prepare).not.toHaveBeenCalled();
  expect(client.dispatch).not.toHaveBeenCalled();
});
