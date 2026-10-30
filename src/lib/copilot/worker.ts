import type { WorkLease } from './work';
import type { Outbox, ReplyInput } from './service';

export interface WorkClient {
  reconcile(): Promise<unknown>;
  claim(
    sessionId: string
  ): Promise<
    WorkLease | { id: string; state: string; outcome: unknown } | null
  >;
  prepare(input: ReplyInput): Promise<Outbox>;
  dispatch(outboxId: string): Promise<Outbox>;
  settle(workId: string, token: string): Promise<{ state: string }>;
  release(workId: string, token: string): Promise<unknown>;
}
export type InboundContext = Readonly<{
  conversation_id: string;
  inbound_id: string;
  content_type: string;
  text: string | null;
}>;

/** One bounded, callable cycle. No scheduler/listener/model/provider integration.
 * The host supplies a trusted processor (#6); customer content is only data.
 * Authority is captured separately and cannot be supplied/changed by its proposal.
 */
export async function runWorkCycle(
  client: WorkClient,
  sessionId: string,
  propose: (context: InboundContext, signal: AbortSignal) => Promise<string>,
  maxProcessingMs = 20000
) {
  await client.reconcile();
  const claimed = await client.claim(sessionId);
  if (!claimed) return { state: 'idle' };
  if (claimed.state !== 'leased' || !('lease_token' in claimed))
    return { state: claimed.state, work_id: claimed.id };
  const job = Object.freeze({ ...claimed });
  const context = Object.freeze({
    conversation_id: job.conversation_id,
    inbound_id: job.source_id,
    content_type: job.message.content_type,
    text: job.message.content_text,
  });
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const budget = Math.max(
      1,
      Math.min(
        20000,
        maxProcessingMs,
        new Date(job.lease_until).getTime() - Date.now() - 250
      )
    );
    const text = await Promise.race([
      propose(context, controller.signal),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Work processor exceeded its lease budget'));
        }, budget);
      }),
    ]);
    if (typeof text !== 'string' || !text.trim() || text.length > 4096)
      throw new Error('Invalid reply proposal');
    const prepared = await client.prepare({
      conversation_id: job.conversation_id,
      session_id: job.session_id,
      ownership_revision: job.ownership_revision,
      inbound_id: job.source_id,
      work_token: job.lease_token,
      idempotency_key: `work:${job.id}`,
      text,
    });
    if (
      prepared.state === 'approved' &&
      prepared.authorization_basis === 'verified_answer'
    )
      await client.dispatch(prepared.id);
    const result = await client.settle(job.id, job.lease_token);
    return { state: result.state, work_id: job.id, outbox_id: prepared.id };
  } catch (error) {
    controller.abort();
    // Releasing rotates authority. If transport/session already failed, the
    // bounded lease and durable outbox still prevent stale submission/retry.
    await client.release(job.id, job.lease_token).catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
