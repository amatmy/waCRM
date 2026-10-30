import { expect, it, vi } from 'vitest';
const calls = vi.hoisted(() => ({
  model: vi.fn(),
  send: vi.fn(),
  config: vi.fn(),
}));
vi.mock('./generate', () => ({ generateReply: calls.model }));
vi.mock('./config', () => ({ loadAiConfig: calls.config }));
vi.mock('@/lib/flows/meta-send', () => ({ engineSendText: calls.send }));
import { dispatchInboundToAiReply } from './auto-reply';
it('legacy inbound AI dispatch cannot load paid inference or bypass the guarded outbox', async () => {
  await dispatchInboundToAiReply({
    accountId: 'account',
    conversationId: 'conversation',
    contactId: 'contact',
    configOwnerUserId: 'human',
  });
  expect(calls.config).not.toHaveBeenCalled();
  expect(calls.model).not.toHaveBeenCalled();
  expect(calls.send).not.toHaveBeenCalled();
});
