// ============================================================
// Tool registration — decides which tools exist for this process
// based on the write guards. Reads are always on; writes and
// broadcasts are opt-in (see config.ts).
// ============================================================

import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import type { WacrmClient } from '../client.js';
import type { Config } from '../config.js';
import { registerReadTools } from './read.js';
import { registerWriteTools } from './write.js';
import { registerBroadcastTools } from './broadcast.js';
import { handle, jsonResult } from './shared.js';

export function registerTools(
  server: McpServer,
  client: WacrmClient,
  config: Config
): string[] {
  const enabled: string[] = ['read'];
  registerReadTools(server, client);

  if (config.copilotMode) {
    // Also enforce here for callers constructing Config without loadConfig.
    if (config.enableWrites || config.enableBroadcasts || !config.operatorId) {
      throw new Error(
        'Copilot requires an operator and read-only configuration'
      );
    }
    server.registerTool(
      'get_copilot_session',
      {
        description:
          'Read the human operator session. This does not activate assistance or start a listener. Copilot replies are not implemented yet.',
        inputSchema: {},
        annotations: {
          readOnlyHint: true,
          destructiveHint: false,
          openWorldHint: true,
        },
      },
      handle(async () =>
        jsonResult(await client.getCopilotSession(config.operatorId!))
      )
    );
    enabled.push('copilot');
  }

  if (config.enableWrites) {
    registerWriteTools(server, client);
    enabled.push('write');
  }

  if (config.enableBroadcasts) {
    registerBroadcastTools(server, client);
    enabled.push('broadcast');
  }

  return enabled;
}
