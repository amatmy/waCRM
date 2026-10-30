import { beforeEach, expect, it, vi } from 'vitest';
const mocks = vi.hoisted(() => ({
  auth: vi.fn(),
  send: vi.fn(),
  resolve: vi.fn(),
}));
vi.mock('@/lib/auth/api-context', () => ({ requireApiKey: mocks.auth }));
vi.mock('@/lib/whatsapp/send-message', () => ({
  sendMessageToConversation: mocks.send,
}));
vi.mock('@/lib/whatsapp/resolve-conversation', () => ({
  resolveConversationByPhone: mocks.resolve,
}));
import { POST } from './route';
beforeEach(() => {
  vi.resetAllMocks();
  mocks.auth.mockResolvedValue({
    accountId: 'account',
    scopes: ['messages:send'],
  });
});
it('denies even legacy send-capable machine keys before creating contacts or calling the provider', async () => {
  const response = await POST(
    new Request('https://crm.test/api/v1/messages', {
      method: 'POST',
      body: JSON.stringify({ to: '+15551234567', text: 'bypass' }),
    })
  );
  expect(response.status).toBe(403);
  expect(mocks.resolve).not.toHaveBeenCalled();
  expect(mocks.send).not.toHaveBeenCalled();
});
it('does not turn an authentication error into a send', async () => {
  const { unauthorized } = await import('@/lib/api/v1/respond');
  mocks.auth.mockRejectedValue(unauthorized());
  expect(
    (
      await POST(
        new Request('https://crm.test/api/v1/messages', { method: 'POST' })
      )
    ).status
  ).toBe(401);
  expect(mocks.send).not.toHaveBeenCalled();
});
