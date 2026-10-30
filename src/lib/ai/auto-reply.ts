/** Legacy native auto-reply is intentionally disabled. It has no human-session,
 * ownership or outbox contract and uses provider inference. #3 replaces its
 * dispatch authority; inference belongs to #6. Webhook ingestion still succeeds. */
export interface DispatchArgs {
  accountId: string;
  conversationId: string;
  contactId: string;
  configOwnerUserId: string;
  inboundMessageId?: string;
}
export async function dispatchInboundToAiReply(
  args: DispatchArgs
): Promise<void> {
  // Retain the callable contract for ingestion; do not load a model or send.
  void args;
}
