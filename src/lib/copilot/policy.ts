import type { PoolClient } from 'pg';

export const normalizeQuestion = (value: string) =>
  value
    .normalize('NFKC')
    .trim()
    .toLocaleLowerCase('en-US')
    .replace(/\s+/gu, ' ');

// A conservative extra veto, not an intent classifier. Exact, human-curated
// allowlisting is the authority; unmatched languages/requests require review.
export const requiresHuman = (value: string) =>
  /refund|reimburse|disput|chargeback|negotiat|descont|discount|complain|uncertain|not sure|human|person|agent|manager|reembolso|devoluci[oó]n|reclam|descuento|negoci|persona|humano|gerente|n[aã]o sei|pessoa|환불|분쟁|할인|상담원|사람/iu.test(
    value
  );

export async function verifiedAnswer(
  c: PoolClient,
  accountId: string,
  inboundId: string,
  reply: string
): Promise<string | null> {
  const inbound = (
    await c.query(
      `SELECT m.content_text FROM messages m JOIN conversations cv ON cv.id=m.conversation_id
     WHERE m.id=$1 AND cv.account_id=$2 AND m.sender_type='customer'
     AND m.content_type='text' AND m.copilot_verified_inbound`,
      [inboundId, accountId]
    )
  ).rows[0]?.content_text;
  if (
    typeof inbound !== 'string' ||
    requiresHuman(inbound) ||
    requiresHuman(reply)
  )
    return null;
  const row = (
    await c.query(
      `SELECT id FROM copilot_answers WHERE account_id=$1 AND query_normalized=$2
     AND answer_text=$3 AND enabled AND expires_at>clock_timestamp() FOR SHARE`,
      [accountId, normalizeQuestion(inbound), reply]
    )
  ).rows[0];
  return row?.id ?? null;
}
