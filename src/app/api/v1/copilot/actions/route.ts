import { requireApiKey } from '@/lib/auth/api-context';
import { badRequest, ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { copilotPool } from '@/lib/copilot/db';
import { CopilotService } from '@/lib/copilot/service';
import { object, uuid, text, revision } from '@/lib/copilot/input';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const actor = await requireApiKey(request, 'copilot:act');
    const body = object(await request.json().catch(() => null));
    const service = new CopilotService(copilotPool());
    let data: unknown;
    switch (body.action) {
      case 'claim':
        data = await service.claim(
          actor,
          uuid(body, 'conversation_id'),
          uuid(body, 'session_id')
        );
        break;
      case 'prepare':
        data = await service.prepare(actor, {
          conversation_id: uuid(body, 'conversation_id'),
          session_id: uuid(body, 'session_id'),
          ownership_revision: revision(body),
          inbound_id: uuid(body, 'inbound_id'),
          idempotency_key: text(body, 'idempotency_key', 128),
          text: text(body, 'text'),
        });
        break;
      case 'inspect':
        data = await service.get(actor, uuid(body, 'outbox_id'));
        break;
      case 'dispatch':
        data = await service.dispatch(actor, uuid(body, 'outbox_id'));
        break;
      case 'handoff':
        throw badRequest(
          'Use /api/v1/copilot/crm with session, revision and idempotency key for audited handoff'
        );
      default:
        throw badRequest('Unknown copilot action');
    }
    const response = ok(data);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
