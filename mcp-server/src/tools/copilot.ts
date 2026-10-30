import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WacrmClient } from '../client.js';
import { handle, jsonResult } from './shared.js';

export function registerCopilotTools(server: McpServer, client: WacrmClient) {
  const conversation_id = z.string().uuid();
  const session_id = z.string().uuid();
  const ownership_revision = z.string().regex(/^\d+$/);
  const outbox_id = z.string().uuid();
  const annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  };
  server.registerTool(
    'claim_conversation',
    {
      description:
        'Claim a conversation during your bound human operator session; returns revision and newest inbound ID.',
      inputSchema: { conversation_id, session_id },
      annotations,
    },
    handle(async (args) =>
      jsonResult(await client.copilotAction({ action: 'claim', ...args }))
    )
  );
  server.registerTool(
    'prepare_authorized_reply',
    {
      description:
        'Store an immutable reply draft. The human must approve this exact outbox entry before dispatch. Does not send.',
      inputSchema: {
        conversation_id,
        session_id,
        ownership_revision,
        inbound_id: z.string().uuid(),
        idempotency_key: z.string().min(8).max(128),
        text: z.string().min(1).max(4096),
      },
      annotations,
    },
    handle(async (args) =>
      jsonResult(await client.copilotAction({ action: 'prepare', ...args }))
    )
  );
  server.registerTool(
    'get_reply_outcome',
    {
      description:
        'Inspect a persisted reply outcome. Unknown/dispatching outcomes must be reconciled by the human; never retry with a new key.',
      inputSchema: { outbox_id },
      annotations: { ...annotations, readOnlyHint: true },
    },
    handle(async (args) =>
      jsonResult(await client.copilotAction({ action: 'inspect', ...args }))
    )
  );
  server.registerTool(
    'send_authorized_reply',
    {
      description:
        'Dispatch a human-approved outbox entry once. Server rechecks session, ownership, inbound context, policy and WhatsApp eligibility. An unknown outcome must not be resent.',
      inputSchema: { outbox_id },
      annotations: { ...annotations, destructiveHint: true },
    },
    handle(async (args) =>
      jsonResult(await client.copilotAction({ action: 'dispatch', ...args }))
    )
  );
  server.registerTool(
    'handoff_to_human',
    {
      description:
        'Explicitly relinquish a claim to the bound human with a summary. Cancels unsent work and disables further AI replies.',
      inputSchema: {
        conversation_id,
        ownership_revision,
        summary: z.string().min(1).max(2000),
      },
      annotations,
    },
    handle(async (args) =>
      jsonResult(await client.copilotAction({ action: 'handoff', ...args }))
    )
  );
}
