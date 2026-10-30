import { expect, it, vi } from 'vitest';
vi.mock('@/lib/auth/api-context', () => ({
  requireApiKey: vi.fn(async () => ({ scopes: ['broadcasts:send'] })),
}));
import { POST } from './route';
it('blocks raw machine broadcasts even when the legacy scope is present', async () => {
  expect(
    (
      await POST(
        new Request('https://crm.test/api/v1/broadcasts', {
          method: 'POST',
          body: '{"recipients":[{"to":"+15551234567"}]}',
        })
      )
    ).status
  ).toBe(403);
});
