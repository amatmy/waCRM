import { afterEach, beforeEach, expect, it, vi } from 'vitest';
vi.mock('@/lib/whatsapp/encryption', () => ({
  decrypt: (value: string) => value,
}));
import { sendCopilotText, ProviderRejected } from './provider';
const fetchMock = vi.fn();
const input = {
  phone_number_id: 'synthetic-id',
  access_token: 'synthetic-token',
  phone: '+15551234567',
  wa_user_id: null,
  text: 'Synthetic text',
  inbound_wamid: 'wamid.inbound',
};
beforeEach(() => {
  vi.resetAllMocks();
  vi.stubGlobal('fetch', fetchMock);
});
afterEach(() => vi.unstubAllGlobals());
it('uses one request, the exact approved text/context and abort signal; refuses redirects', async () => {
  fetchMock.mockResolvedValue(
    Response.json({ messages: [{ id: 'wamid.accepted' }] })
  );
  const signal = new AbortController().signal;
  expect(await sendCopilotText(input, signal)).toBe('wamid.accepted');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  const [url, options] = fetchMock.mock.calls[0];
  expect(url).toBe('https://graph.facebook.com/v21.0/synthetic-id/messages');
  expect(options.signal).toBe(signal);
  expect(options.redirect).toBe('error');
  expect(JSON.parse(options.body)).toMatchObject({
    text: { body: input.text },
    context: { message_id: input.inbound_wamid },
  });
});
it.each([400, 401, 403, 429])(
  'treats provider %s as a definite terminal rejection with no retry',
  async (status) => {
    fetchMock.mockResolvedValue(new Response('{}', { status }));
    await expect(
      sendCopilotText(input, new AbortController().signal)
    ).rejects.toBeInstanceOf(ProviderRejected);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }
);
it.each([500, 502, 503])(
  'does not retry an ambiguous provider %s response',
  async (status) => {
    fetchMock.mockResolvedValue(new Response('{}', { status }));
    await expect(
      sendCopilotText(input, new AbortController().signal)
    ).rejects.toThrow('unknown');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  }
);
it('does not retry a network timeout or malformed success', async () => {
  fetchMock.mockRejectedValueOnce(new Error('synthetic timeout'));
  await expect(
    sendCopilotText(input, new AbortController().signal)
  ).rejects.toThrow('timeout');
  expect(fetchMock).toHaveBeenCalledTimes(1);
  fetchMock.mockResolvedValueOnce(Response.json({ messages: [] }));
  await expect(
    sendCopilotText(input, new AbortController().signal)
  ).rejects.toThrow('did not establish');
  expect(fetchMock).toHaveBeenCalledTimes(2);
});
it('refuses an unaddressable recipient before making any request', async () => {
  await expect(
    sendCopilotText({ ...input, phone: null }, new AbortController().signal)
  ).rejects.toBeInstanceOf(ProviderRejected);
  expect(fetchMock).not.toHaveBeenCalled();
});
