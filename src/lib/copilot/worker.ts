import type { WorkLease } from './work';
import type { Outbox, ReplyInput } from './service';

export interface WorkClient {
  reconcile(): Promise<unknown>;
  claim(
    sessionId: string
  ): Promise<
    WorkLease | { id: string; state: string; outcome: unknown } | null
  >;
  knowledge?(workId: string, token: string): Promise<VerifiedContext>;
  handoff?(input: HandoffInput): Promise<{ id: string }>;
  prepare(input: ReplyInput): Promise<Outbox>;
  dispatch(outboxId: string): Promise<Outbox>;
  settle(workId: string, token: string): Promise<{ state: string }>;
  release(workId: string, token: string): Promise<unknown>;
}
export interface VerifiedContext {
  policy_mode: string;
  policy_revision: string;
  verified_answer: {
    id: string;
    text: string;
    source_reference: string;
    expires_at: string;
  } | null;
  reason: string;
}
export type HandoffInput = Omit<ReplyInput, 'text'> & { summary: string };
export type Proposal =
  | string
  | { kind: 'reply'; text: string }
  | { kind: 'handoff'; summary: string };
export type InboundContext = Readonly<{
  conversation_id: string;
  inbound_id: string;
  content_type: string;
  text: string | null;
  knowledge?: VerifiedContext;
}>;

export { runWorkCycle } from '../../../mcp-server/runtime/cycle.mjs';
