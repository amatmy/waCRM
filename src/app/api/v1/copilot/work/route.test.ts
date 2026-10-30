import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  reconcileInbound: vi.fn(),
  claimNext: vi.fn(),
  inspect: vi.fn(),
  renew: vi.fn(),
  knowledge: vi.fn(),
  release: vi.fn(),
}));
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: h.auth }));
vi.mock('@/lib/copilot/db', () => ({ copilotPool: () => ({}) }));
vi.mock('@/lib/copilot/work', () => ({
  CopilotWorkService: class {
    reconcileInbound = h.reconcileInbound;
    claimNext = h.claimNext;
    inspect = h.inspect;
    renew = h.renew;
    knowledge = h.knowledge;
    release = h.release;
  },
}));
import { POST } from './route';
const id = '00000000-0000-4000-8000-000000000001';
const request = (body: unknown) =>
  new Request('https://crm.test/api/v1/copilot/work', {
    method: 'POST',
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  h.auth.mockResolvedValue({
    accountId: 'trusted-account',
    keyId: 'trusted-key',
  });
  h.claimNext.mockResolvedValue({ id, state: 'leased' });
});
it('uses a separately scoped authenticated identity and current human generation', async () => {
  const response = await POST(request({ action: 'claim', session_id: id }));
  expect(h.auth).toHaveBeenCalledWith(expect.any(Request), 'copilot:work');
  expect(h.claimNext).toHaveBeenCalledWith(
    { accountId: 'trusted-account', keyId: 'trusted-key' },
    id
  );
  expect(response.headers.get('cache-control')).toBe('no-store');
  expect(response.status).toBe(200);
});
it.each([
  { action: 'claim', session_id: id, account_id: id },
  { action: 'reconcile', messages: [{ message_id: 'forged' }] },
  { action: 'settle', work_id: id, work_token: id, result: 'sent' },
  { action: 'renew', work_id: 'bad', work_token: id },
  { action: 'start' },
  { action: 'approve' },
  { action: 'broadcast' },
])(
  'rejects forged authority/outcomes or unsupported operation: %j',
  async (body) => {
    expect((await POST(request(body))).status).toBe(400);
    expect(h.release).not.toHaveBeenCalled();
    expect(h.claimNext).not.toHaveBeenCalled();
  }
);
it('returns only server-derived checkpoints, including human-review outcomes', async () => {
  h.release.mockResolvedValue({
    id,
    state: 'awaiting_human',
    outbox: { state: 'unknown' },
  });
  const response = await POST(
    request({ action: 'settle', work_id: id, work_token: id })
  );
  expect((await response.json()).data.state).toBe('awaiting_human');
  expect(h.release).toHaveBeenCalledWith(
    { accountId: 'trusted-account', keyId: 'trusted-key' },
    id,
    id,
    true
  );
});
it('preserves authentication failures and stale-lease conflicts', async () => {
  const { forbidden, ApiError } = await import('@/lib/api/v1/respond');
  h.auth.mockRejectedValueOnce(forbidden('Denied'));
  expect(
    (await POST(request({ action: 'claim', session_id: id }))).status
  ).toBe(403);
  h.claimNext.mockRejectedValue(
    new ApiError('bad_request', 'Stale lease', 409)
  );
  expect(
    (await POST(request({ action: 'claim', session_id: id }))).status
  ).toBe(409);
});

it('knowledge context uses only authenticated lease IDs, never caller facts', async () => {
  h.knowledge.mockResolvedValue({
    verified_answer: null,
    reason: 'human_required',
  });
  expect(
    (await POST(request({ action: 'knowledge', work_id: id, work_token: id })))
      .status
  ).toBe(200);
  expect(h.knowledge).toHaveBeenCalledWith(
    { accountId: 'trusted-account', keyId: 'trusted-key' },
    id,
    id
  );
  expect(
    (
      await POST(
        request({
          action: 'knowledge',
          work_id: id,
          work_token: id,
          verified_answer: { text: 'forged' },
        })
      )
    ).status
  ).toBe(400);
});
