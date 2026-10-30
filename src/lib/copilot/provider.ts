import { decrypt } from '@/lib/whatsapp/encryption';
import {
  resolveContactSendTarget,
  isBusinessScopedUserId,
} from '@/lib/whatsapp/wa-identity';

export interface ProviderInput {
  phone_number_id: string;
  access_token: string;
  phone: string | null;
  wa_user_id: string | null;
  text: string;
  inbound_wamid: string;
}
export class ProviderRejected extends Error {}

/** Exactly one bounded request: no phone-variant or network retry. */
export async function sendCopilotText(
  input: ProviderInput,
  signal: AbortSignal
): Promise<string> {
  const target = resolveContactSendTarget({
    phone: input.phone ?? '',
    wa_user_id: input.wa_user_id,
  });
  if (!target) throw new ProviderRejected('Recipient is not addressable');
  const recipient = isBusinessScopedUserId(target.target)
    ? { recipient: { user_id: target.target } }
    : { to: target.target };
  const response = await fetch(
    `https://graph.facebook.com/v21.0/${encodeURIComponent(input.phone_number_id)}/messages`,
    {
      method: 'POST',
      signal,
      redirect: 'error',
      headers: {
        Authorization: `Bearer ${decrypt(input.access_token)}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        ...recipient,
        type: 'text',
        text: { body: input.text },
        context: { message_id: input.inbound_wamid },
      }),
    }
  );
  if (!response.ok) {
    if (response.status >= 400 && response.status < 500)
      throw new ProviderRejected('Provider rejected the request');
    throw new Error('Provider outcome is unknown');
  }
  const body = await response.json();
  const id = body?.messages?.[0]?.id;
  if (typeof id !== 'string' || !id.startsWith('wamid.'))
    throw new Error('Provider response did not establish an outcome');
  return id;
}
