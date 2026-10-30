import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  ApiError,
  badRequest,
  forbidden,
  ok,
  toApiErrorResponse,
} from '@/lib/api/v1/respond';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';
import { copilotPool } from '@/lib/copilot/db';
import { CopilotCrmService } from '@/lib/copilot/crm';
import { CopilotService } from '@/lib/copilot/service';
import { object, uuid, text } from '@/lib/copilot/input';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const actor = await requireRole('agent');
    if (request.headers.get('origin') !== new URL(request.url).origin)
      throw forbidden('Same-origin human request required');
    const limit = checkRateLimit(
      `copilot-control:${actor.userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);
    const body = object(await request.json().catch(() => null));
    const service = new CopilotService(copilotPool());
    let data: unknown;
    switch (body.action) {
      case 'policy':
        if (typeof body.enabled !== 'boolean')
          throw badRequest('enabled must be boolean');
        if (
          body.mode !== undefined &&
          body.mode !== 'human_approval' &&
          body.mode !== 'hybrid'
        )
          throw badRequest('Invalid policy mode');
        data =
          body.mode === undefined
            ? await service.setPolicy(actor, body.enabled)
            : await service.setPolicy(actor, body.enabled, body.mode);
        break;
      case 'verify_answer':
        data = await new CopilotCrmService(copilotPool()).verifyBusinessAnswer(
          actor,
          body.answer
        );
        break;
      case 'bind':
        data = await service.bindKey(
          actor,
          uuid(body, 'key_id'),
          body.operator_id === undefined
            ? actor.userId
            : uuid(body, 'operator_id')
        );
        break;
      case 'approve':
        data = await service.approve(actor, uuid(body, 'outbox_id'));
        break;
      case 'takeover':
        data = await service.takeover(actor, uuid(body, 'conversation_id'));
        break;
      case 'release':
        data = await service.takeover(
          actor,
          uuid(body, 'conversation_id'),
          true
        );
        break;
      case 'reconcile':
        data = await service.reconcile(
          actor,
          uuid(body, 'outbox_id'),
          text(body, 'provider_message_id', 200)
        );
        break;
      default:
        throw badRequest('Unknown human control action');
    }
    const response = ok(data);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) {
    return error instanceof ApiError
      ? toApiErrorResponse(error)
      : toErrorResponse(error);
  }
}
