import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  perform: vi.fn(),
  outcome: vi.fn(),
  context: vi.fn(),
}));
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: h.auth }));
vi.mock('@/lib/copilot/db', () => ({ copilotPool: () => ({}) }));
vi.mock('@/lib/copilot/crm', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/copilot/crm')>();
  return {
    ...actual,
    CopilotCrmService: class {
      perform = h.perform;
      outcome = h.outcome;
      context = h.context;
    },
  };
});
import { POST } from './route';
const id = '00000000-0000-4000-8000-000000000001';
const input = {
  action: 'note',
  conversation_id: id,
  session_id: id,
  inbound_id: id,
  ownership_revision: '1',
  idempotency_key: 'fixture-key',
  payload: { note: 'Synthetic note' },
};
const req = (body: unknown) =>
  new Request('https://crm.test/api/v1/copilot/crm', {
    method: 'POST',
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  h.auth.mockResolvedValue({
    accountId: 'trusted-account',
    keyId: 'trusted-key',
  });
  h.perform.mockResolvedValue({ id, result: { id: 'persisted-note' } });
});
it('uses the authenticated identity and separate CRM scope and returns stored outcomes', async () => {
  const response = await POST(req(input));
  expect(h.auth).toHaveBeenCalledWith(expect.any(Request), 'copilot:crm');
  expect(h.perform).toHaveBeenCalledWith(
    { accountId: 'trusted-account', keyId: 'trusted-key' },
    input
  );
  expect(await response.json()).toEqual({
    data: { id, result: { id: 'persisted-note' } },
  });
  expect(response.headers.get('cache-control')).toBe('no-store');
});
it.each([
  { ...input, accountId: 'attacker' },
  { ...input, action: 'broadcast' },
  { ...input, session_id: 'bad' },
  { ...input, payload: { note: 'x', user_id: id } },
  { ...input, action: 'deal', payload: { deal_id: id, value: 999 } },
  { ...input, action: 'deal', payload: { deal_id: id, stage_id: 'bad' } },
  { ...input, action: 'status', payload: { status: 'deleted' } },
])('rejects unsupported or forged fields before mutation: %j', async (body) => {
  expect((await POST(req(body))).status).toBe(400);
  expect(h.perform).not.toHaveBeenCalled();
});
it('denies missing scopes and forwards server conflicts without claiming success', async () => {
  const { forbidden, ApiError } = await import('@/lib/api/v1/respond');
  h.auth.mockRejectedValueOnce(forbidden('Denied'));
  expect((await POST(req(input))).status).toBe(403);
  expect(h.perform).not.toHaveBeenCalled();
  h.perform.mockRejectedValue(
    new ApiError('bad_request', 'Human took over', 409)
  );
  expect((await POST(req(input))).status).toBe(409);
});
it('reads a persisted outcome without requiring live mutation authority', async () => {
  h.outcome.mockResolvedValue({ id, result: { status: 'closed' } });
  expect((await POST(req({ action: 'outcome', action_id: id }))).status).toBe(
    200
  );
  expect(h.outcome).toHaveBeenCalledWith(
    { accountId: 'trusted-account', keyId: 'trusted-key' },
    id
  );
  expect(h.perform).not.toHaveBeenCalled();
});
