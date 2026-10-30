import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  claim: vi.fn(),
  prepare: vi.fn(),
  dispatch: vi.fn(),
  get: vi.fn(),
  handoff: vi.fn(),
}));
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: h.auth }));
vi.mock('@/lib/copilot/db', () => ({ copilotPool: () => ({}) }));
vi.mock('@/lib/copilot/service', () => ({
  CopilotService: class {
    claim = h.claim;
    prepare = h.prepare;
    dispatch = h.dispatch;
    get = h.get;
    handoff = h.handoff;
  },
}));
import { POST } from './route';
const id = '00000000-0000-4000-8000-000000000001';
const req = (body: unknown) =>
  new Request('https://crm.test/api/v1/copilot/actions', {
    method: 'POST',
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  h.auth.mockResolvedValue({ accountId: 'key-account', keyId: 'key-id' });
  h.claim.mockResolvedValue({ revision: '3' });
});
it('uses key identity and copilot scope, ignoring caller account/operator identity', async () => {
  const response = await POST(
    req({
      action: 'claim',
      conversation_id: id,
      session_id: id,
      accountId: 'attacker',
      operator_id: id,
      keyId: 'other',
    })
  );
  expect(h.auth).toHaveBeenCalledWith(expect.any(Request), 'copilot:act');
  expect(h.claim).toHaveBeenCalledWith(
    { accountId: 'key-account', keyId: 'key-id' },
    id,
    id
  );
  expect(response.status).toBe(200);
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it.each(['approve', 'policy', 'takeover', 'start', 'broadcast'])(
  'does not expose human action %s',
  async (action) => {
    expect((await POST(req({ action }))).status).toBe(400);
    expect(h.dispatch).not.toHaveBeenCalled();
  }
);
it('rejects malformed IDs before dispatch and preserves auth failures', async () => {
  expect(
    (await POST(req({ action: 'dispatch', outbox_id: 'bad' }))).status
  ).toBe(400);
  expect(h.dispatch).not.toHaveBeenCalled();
  const { forbidden } = await import('@/lib/api/v1/respond');
  h.auth.mockRejectedValue(forbidden('Denied'));
  expect((await POST(req({ action: 'dispatch', outbox_id: id }))).status).toBe(
    403
  );
  expect(h.dispatch).not.toHaveBeenCalled();
});
it('returns a stored unknown outcome without inventing success or retrying', async () => {
  h.dispatch.mockResolvedValue({ id, state: 'unknown' });
  const response = await POST(req({ action: 'dispatch', outbox_id: id }));
  expect(await response.json()).toEqual({ data: { id, state: 'unknown' } });
  expect(h.dispatch).toHaveBeenCalledTimes(1);
});
