import { beforeEach, describe, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({ rpc: vi.fn(), requireRole: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: mocks.requireRole,
  toErrorResponse: () =>
    Response.json({ error: 'auth failure' }, { status: 401 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  RATE_LIMITS: { adminAction: {} },
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
import { GET, POST } from './route';
const id = '00000000-0000-4000-8000-000000000001';
const request = (body: unknown, origin = 'https://crm.test') =>
  new Request('https://crm.test/api/copilot/session', {
    method: 'POST',
    headers: { Origin: origin, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  mocks.requireRole.mockResolvedValue({
    supabase: { rpc: mocks.rpc },
    userId: id,
    accountId: 'account',
  });
  mocks.rpc.mockResolvedValue({ data: { state: 'active' }, error: null });
});
describe('human session API', () => {
  it('uses authenticated human identity and does not accept caller supplied identity or expiry', async () => {
    const result = await POST(
      request({
        action: 'start',
        operator_id: 'attacker',
        account_id: 'other',
        expires_at: '2099',
      })
    );
    expect(result.status).toBe(200);
    expect(mocks.requireRole).toHaveBeenCalledWith('agent');
    expect(mocks.rpc).toHaveBeenCalledWith('transition_copilot_session', {
      p_action: 'start',
      p_session_id: null,
    });
    expect(result.headers.get('cache-control')).toBe('no-store');
  });
  it.each(['heartbeat', 'pause'])(
    'requires the current session ID for %s',
    async (action) => {
      expect((await POST(request({ action }))).status).toBe(400);
      expect(mocks.rpc).not.toHaveBeenCalled();
      expect((await POST(request({ action, session_id: id }))).status).toBe(
        200
      );
      expect(mocks.rpc).toHaveBeenCalledWith('transition_copilot_session', {
        p_action: action,
        p_session_id: id,
      });
    }
  );
  it.each(['https://attacker.test', 'null', ''])(
    'rejects invalid/missing origin %s',
    async (origin) => {
      expect((await POST(request({ action: 'start' }, origin))).status).toBe(
        403
      );
      expect(mocks.rpc).not.toHaveBeenCalled();
    }
  );
  it('rejects unauthenticated callers before touching storage', async () => {
    mocks.requireRole.mockRejectedValue(new Error('unauthorized'));
    expect((await POST(request({ action: 'start' }))).status).toBe(401);
    expect(mocks.rpc).not.toHaveBeenCalled();
  });
  it('maps stale/expired sessions to conflict and concurrent role revocation to forbidden', async () => {
    mocks.rpc.mockResolvedValueOnce({ error: { code: 'P0001' } });
    expect(
      (await POST(request({ action: 'heartbeat', session_id: id }))).status
    ).toBe(409);
    mocks.rpc.mockResolvedValueOnce({ error: { code: '42501' } });
    expect((await POST(request({ action: 'start' }))).status).toBe(403);
  });
  it('reads only the authenticated operator/account, without caching', async () => {
    const result = await GET();
    expect(mocks.rpc).toHaveBeenCalledWith('get_copilot_session', {
      p_account_id: 'account',
      p_operator_id: id,
    });
    expect(result.headers.get('cache-control')).toBe('no-store');
  });
});
