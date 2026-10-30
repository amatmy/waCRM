/** One bounded cycle, shared with the app. No human activation, listener or scheduler.
 * @param {import('../../src/lib/copilot/worker').WorkClient} client
 * @param {string} sessionId
 * @param {(context:import('../../src/lib/copilot/worker').InboundContext,signal:AbortSignal)=>Promise<import('../../src/lib/copilot/worker').Proposal>} propose
 * @param {number} maxProcessingMs
 */
export async function runWorkCycle(
  client,
  sessionId,
  propose,
  maxProcessingMs = 20000
) {
  await client.reconcile();
  const claimed = await client.claim(sessionId);
  if (!claimed) return { state: 'idle' };
  if (claimed.state !== 'leased' || !('lease_token' in claimed))
    return { state: claimed.state, work_id: claimed.id };
  const job = Object.freeze({ ...claimed });
  const controller = new AbortController();
  let timer;
  try {
    const knowledge = client.knowledge
      ? await client.knowledge(job.id, job.lease_token)
      : undefined;
    const context = Object.freeze({
      conversation_id: job.conversation_id,
      inbound_id: job.source_id,
      content_type: job.message.content_type,
      text: job.message.content_text,
      ...(knowledge ? { knowledge: Object.freeze(knowledge) } : {}),
    });
    const budget = Math.max(
      1,
      Math.min(
        20000,
        maxProcessingMs,
        new Date(job.lease_until).getTime() - Date.now() - 250
      )
    );
    const proposal = await Promise.race([
      propose(context, controller.signal),
      new Promise((_, reject) => {
        timer = setTimeout(() => {
          controller.abort();
          reject(new Error('Work processor exceeded its lease budget'));
        }, budget);
      }),
    ]);
    if (timer) clearTimeout(timer);
    const authority = {
      conversation_id: job.conversation_id,
      session_id: job.session_id,
      ownership_revision: job.ownership_revision,
      inbound_id: job.source_id,
      work_token: job.lease_token,
      idempotency_key: `work:${job.id}`,
    };
    if (
      proposal &&
      typeof proposal === 'object' &&
      'kind' in proposal &&
      proposal.kind === 'handoff'
    ) {
      if (!client.handoff) throw new Error('Guarded handoff unavailable');
      if (
        typeof proposal.summary !== 'string' ||
        !proposal.summary.trim() ||
        proposal.summary.length > 2000
      )
        throw new Error('Invalid handoff proposal');
      const result = await client.handoff({
        ...authority,
        summary: proposal.summary,
      });
      return { state: 'awaiting_human', work_id: job.id, action_id: result.id };
    }
    const text =
      typeof proposal === 'string'
        ? proposal
        : proposal &&
            typeof proposal === 'object' &&
            'kind' in proposal &&
            proposal.kind === 'reply'
          ? proposal.text
          : undefined;
    if (typeof text !== 'string' || !text.trim() || text.length > 4096)
      throw new Error('Invalid reply proposal');
    const prepared = await client.prepare({ ...authority, text });
    if (
      prepared.state === 'approved' &&
      prepared.authorization_basis === 'verified_answer'
    )
      await client.dispatch(prepared.id);
    const result = await client.settle(job.id, job.lease_token);
    return { state: result.state, work_id: job.id, outbox_id: prepared.id };
  } catch (error) {
    controller.abort();
    await client.release(job.id, job.lease_token).catch(() => {});
    throw error;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
