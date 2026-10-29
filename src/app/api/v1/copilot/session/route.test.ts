import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), requireApiKey: vi.fn() }));
vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: mocks.requireApiKey,
}));
import { GET } from './route';
const id = '00000000-0000-4000-8000-000000000001';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireApiKey.mockResolvedValue({
    accountId: 'key-account',
    supabase: { rpc: mocks.rpc },
  });
  mocks.rpc.mockResolvedValue({ data: { state: 'inactive' } });
});
describe('read-only copilot session API', () => {
  it('takes the account from the key and enforces conversations:read', async () => {
    const request = new Request(
      `https://crm.test/api/v1/copilot/session?operator_id=${id}&account_id=other`
    );
    const result = await GET(request);
    expect(mocks.requireApiKey).toHaveBeenCalledWith(
      request,
      'conversations:read'
    );
    expect(mocks.rpc).toHaveBeenCalledWith('get_copilot_session', {
      p_account_id: 'key-account',
      p_operator_id: id,
    });
    expect(result.headers.get('cache-control')).toBe('no-store');
    expect(await result.json()).toEqual({ data: { state: 'inactive' } });
  });
  it.each(['', '?operator_id=invalid'])(
    'rejects invalid operator IDs %s',
    async (query) => {
      const result = await GET(
        new Request(`https://crm.test/api/v1/copilot/session${query}`)
      );
      expect(result.status).toBe(400);
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  );
  it('does not query on scope or authentication failure', async () => {
    const { forbidden } = await import('@/lib/api/v1/respond');
    mocks.requireApiKey.mockRejectedValue(
      forbidden('Missing conversations:read')
    );
    expect(
      (
        await GET(
          new Request(
            `https://crm.test/api/v1/copilot/session?operator_id=${id}`
          )
        )
      ).status
    ).toBe(403);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
});
