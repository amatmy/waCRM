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
        'Store an immutable reply. Only an exact server-verified routine business answer may be approved automatically in hybrid mode; all other drafts need human approval. Does not send.',
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
        'Dispatch a server-authorized outbox entry once. Server rechecks session, ownership, inbound context, policy and WhatsApp eligibility. An unknown outcome must not be resent.',
      inputSchema: { outbox_id },
      annotations: { ...annotations, destructiveHint: true },
    },
    handle(async (args) =>
      jsonResult(await client.copilotAction({ action: 'dispatch', ...args }))
    )
  );
  const common = {
    conversation_id,
    session_id,
    ownership_revision,
    inbound_id: z.string().uuid(),
    idempotency_key: z.string().min(8).max(128),
  };
  server.registerTool(
    'get_crm_context',
    {
      description:
        'Read eligible account operators, linked deals and their stages for a current claim. Requires copilot:crm.',
      inputSchema: { conversation_id, session_id, ownership_revision },
      annotations: { ...annotations, readOnlyHint: true },
    },
    handle(async (args) =>
      jsonResult(await client.copilotCrm({ action: 'context', ...args }))
    )
  );
  server.registerTool(
    'get_crm_action_outcome',
    {
      description:
        'Read a persisted account/key-scoped CRM action outcome. A replay never repeats a mutation.',
      inputSchema: { action_id: z.string().uuid() },
      annotations: { ...annotations, readOnlyHint: true },
    },
    handle(async (args) =>
      jsonResult(await client.copilotCrm({ action: 'outcome', ...args }))
    )
  );
  server.registerTool(
    'handoff_to_human',
    {
      description:
        'Yield a current claim to the bound human with a summary; pauses AI and cancels unsent replies. Requires active session and copilot:crm.',
      inputSchema: { ...common, summary: z.string().min(1).max(2000) },
      annotations,
    },
    handle(async ({ summary, ...args }) =>
      jsonResult(
        await client.copilotCrm({
          action: 'handoff',
          ...args,
          payload: { summary },
        })
      )
    )
  );
  server.registerTool(
    'assign_conversation',
    {
      description:
        'Hand off to an eligible human in this account. Cannot override existing human ownership. Pauses AI and cancels unsent replies.',
      inputSchema: {
        ...common,
        operator_id: z.string().uuid(),
        summary: z.string().min(1).max(2000),
      },
      annotations,
    },
    handle(async ({ operator_id, summary, ...args }) =>
      jsonResult(
        await client.copilotCrm({
          action: 'assign',
          ...args,
          payload: { operator_id, summary },
        })
      )
    )
  );
  server.registerTool(
    'add_internal_note',
    {
      description:
        'Add a native internal contact note attributed to the bound operator. No customer message. Requires current claim and active session.',
      inputSchema: { ...common, note: z.string().min(1).max(4000) },
      annotations,
    },
    handle(async ({ note, ...args }) =>
      jsonResult(
        await client.copilotCrm({ action: 'note', ...args, payload: { note } })
      )
    )
  );
  server.registerTool(
    'set_conversation_status',
    {
      description:
        'Set current conversation open/pending/closed. Leaving open cancels unsent replies and pauses AI; cannot reopen human-owned work.',
      inputSchema: { ...common, status: z.enum(['open', 'pending', 'closed']) },
      annotations,
    },
    handle(async ({ status, ...args }) =>
      jsonResult(
        await client.copilotCrm({
          action: 'status',
          ...args,
          payload: { status },
        })
      )
    )
  );
  server.registerTool(
    'update_linked_deal',
    {
      description:
        'Update title, stage within current pipeline, or status on a deal linked to this conversation/contact. No monetary changes, creation, deletion or reassignment.',
      inputSchema: {
        ...common,
        deal_id: z.string().uuid(),
        title: z.string().min(1).max(200).optional(),
        stage_id: z.string().uuid().optional(),
        status: z.enum(['open', 'won', 'lost']).optional(),
      },
      annotations,
    },
    handle(async ({ deal_id, title, stage_id, status, ...args }) =>
      jsonResult(
        await client.copilotCrm({
          action: 'deal',
          ...args,
          payload: { deal_id, title, stage_id, status },
        })
      )
    )
  );
}
