import { requireApiKey } from '@/lib/auth/api-context';
import { ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { copilotPool } from '@/lib/copilot/db';
import { CopilotCrmService, crmInput } from '@/lib/copilot/crm';
import { object, uuid, revision } from '@/lib/copilot/input';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const actor = await requireApiKey(request, 'copilot:crm');
    const body = object(await request.json().catch(() => null));
    const service = new CopilotCrmService(copilotPool());
    const data =
      body.action === 'outcome'
        ? await service.outcome(actor, uuid(body, 'action_id'))
        : body.action === 'context'
          ? await service.context(
              actor,
              uuid(body, 'conversation_id'),
              uuid(body, 'session_id'),
              revision(body)
            )
          : await service.perform(actor, crmInput(body));
    const response = ok(data);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
