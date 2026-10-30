import { expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({ patch: vi.fn() }));
vi.mock('@/lib/auth/account', () => ({
  requireRole: async () => ({
    accountId: 'account',
    userId: 'human',
    supabase: {
      from: () => {
        const builder = {
          select: () => builder,
          eq: () => builder,
          maybeSingle: async () => ({
            data: { id: 'conversation' },
            error: null,
          }),
          update: (patch: unknown) => {
            h.patch(patch);
            return builder;
          },
          then: (resolve: (v: unknown) => void) => resolve({ error: null }),
        };
        return builder;
      },
    },
  }),
  toErrorResponse: () => Response.json({}, { status: 500 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  RATE_LIMITS: { send: {} },
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
import { POST } from './route';
it('native explicit resume preserves the existing handoff summary while releasing assignment', async () => {
  const response = await POST(
    new Request('https://crm.test/api/ai/autoreply/conversation', {
      method: 'POST',
      body: JSON.stringify({ paused: false }),
    }),
    { params: Promise.resolve({ conversationId: 'conversation' }) }
  );
  expect(response.status).toBe(200);
  expect(h.patch).toHaveBeenCalledWith(
    expect.objectContaining({
      assigned_agent_id: null,
      ai_autoreply_disabled: false,
    })
  );
  expect(h.patch.mock.calls[0][0]).not.toHaveProperty('ai_handoff_summary');
});
