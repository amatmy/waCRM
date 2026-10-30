#!/usr/bin/env node
import { connectRuntime } from './client.mjs';
import { createLocalProcessor } from './local-model.mjs';
import { runWorkCycle } from './cycle.mjs';

// Explicit one-shot invocation only. No session activation, cron, daemon or cloud model.
if (process.argv.length !== 3 || process.argv[2] !== '--once') {
  console.error(
    'Usage: node mcp-server/runtime/cli.mjs --once (requires WACRM_* and LOCAL_LLM_URL; human must already be active)'
  );
  process.exitCode = 2;
} else {
  let client;
  try {
    const sessionId = process.env.WACRM_SESSION_ID;
    if (!sessionId || !/^[0-9a-f-]{36}$/i.test(sessionId))
      throw new Error('Explicit human session generation required');
    // Validate local-only configuration before connecting to CRM.
    const propose = createLocalProcessor({
      url: process.env.LOCAL_LLM_URL ?? '',
      model: process.env.LOCAL_MODEL_ALIAS ?? 'wacrm-qwen3-0.6b-q8',
    });
    client = await connectRuntime({
      baseUrl: process.env.WACRM_BASE_URL ?? '',
      apiKey: process.env.WACRM_API_KEY ?? '',
      operatorId: process.env.WACRM_OPERATOR_ID ?? '',
    });
    const current = await client.session();
    if (current.state !== 'active' || current.session_id !== sessionId)
      throw new Error('Human session paused, expired or replaced');
    let result = await runWorkCycle(client, sessionId, propose);
    // A one-shot host cannot wait for approval/renew a worker lease. Preserve
    // the immutable record and release it for conservative recovery; existing
    // ownership triggers cancel its unsent authority.
    if (result.state === 'leased' && result.work_id) {
      // Inspection intentionally hides capabilities. Keep the claimed token in
      // the credential-bearing adapter instead of recovering it from a read.
      const token = client.claimedToken(result.work_id);
      if (!token) throw new Error('Missing host-held work capability');
      result = {
        ...result,
        ...(await client.release(result.work_id, token)),
        work_id: result.work_id,
      };
    }
    console.log(JSON.stringify(result));
  } catch {
    console.error(
      'Local copilot cycle failed; inspect durable CRM outcomes before retrying. No human session was activated.'
    );
    process.exitCode = 1;
  } finally {
    if (client) await client.close();
  }
}
