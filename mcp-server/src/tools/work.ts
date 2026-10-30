import { z } from 'zod';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WacrmClient } from '../client.js';
import { handle, jsonResult } from './shared.js';
export function registerWorkTools(server: McpServer, client: WacrmClient) {
  const work_id = z.string().uuid(),
    work_token = z.string().uuid();
  const annotations = {
    readOnlyHint: false,
    destructiveHint: false,
    openWorldHint: true,
  };
  server.registerTool(
    'reconcile_inbound_work',
    {
      description:
        'Recover up to 100 missing jobs from trusted canonical CRM storage. Repeat while more_possible. Safe during pause; never grants send or session authority.',
      inputSchema: {},
      annotations,
    },
    handle(async () =>
      jsonResult(await client.copilotWork({ action: 'reconcile' }))
    )
  );
  server.registerTool(
    'claim_next_inbound_work',
    {
      description:
        'Acquire one pending/expired job under your current human session. Returns a new lease capability/revision or an existing outcome needing a human. Never steal human-owned work. Use returned work token for every queued reply/CRM action.',
      inputSchema: { session_id: z.string().uuid() },
      annotations,
    },
    handle(async (args) =>
      jsonResult(await client.copilotWork({ action: 'claim', ...args }))
    )
  );
  server.registerTool(
    'get_inbound_work',
    {
      description:
        'Inspect durable work and its canonical reply outcome, even after pause. Does not reveal another worker generation capability or claim customer-reply success.',
      inputSchema: { work_id },
      annotations: { ...annotations, readOnlyHint: true },
    },
    handle(async (args) =>
      jsonResult(await client.copilotWork({ action: 'inspect', ...args }))
    )
  );
  server.registerTool(
    'get_verified_reply_context',
    {
      description:
        'Read only the unexpired human-verified exact answer for this leased inbound, with source reference and policy. Missing/risky knowledge requires a human. Cannot curate or supply facts.',
      inputSchema: { work_id, work_token },
      annotations: { ...annotations, readOnlyHint: true },
    },
    handle(async (args) =>
      jsonResult(await client.copilotWork({ action: 'knowledge', ...args }))
    )
  );
  for (const [name, action, description] of [
    [
      'renew_inbound_work',
      'renew',
      'Renew a still-live worker lease, capped by the active human session. Expired/replaced leases require a fresh claim.',
    ],
    [
      'release_inbound_work',
      'release',
      'Release unfinished work back to pending. Any existing immutable draft/attempt requires human handling and cannot be retried.',
    ],
    [
      'settle_inbound_work',
      'settle',
      'Checkpoint only the authoritative stored outbox outcome. Drafts await exact human approval; unknown attempts are quarantined. Never accepts a model-supplied success result.',
    ],
  ])
    server.registerTool(
      name,
      { description, inputSchema: { work_id, work_token }, annotations },
      handle(async (args) =>
        jsonResult(await client.copilotWork({ action, ...args }))
      )
    );
}
