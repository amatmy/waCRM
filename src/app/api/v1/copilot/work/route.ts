import { requireApiKey } from '@/lib/auth/api-context';
import { badRequest, ok, toApiErrorResponse } from '@/lib/api/v1/respond';
import { copilotPool } from '@/lib/copilot/db';
import { CopilotWorkService } from '@/lib/copilot/work';
import { object, uuid } from '@/lib/copilot/input';
export const runtime = 'nodejs';
export async function POST(request: Request) {
  try {
    const actor = await requireApiKey(request, 'copilot:work');
    const body = object(await request.json().catch(() => null));
    if (
      Object.keys(body).some(
        (k) => !['action', 'session_id', 'work_id', 'work_token'].includes(k)
      )
    )
      throw badRequest('Unsupported work field');
    const service = new CopilotWorkService(copilotPool());
    let data: unknown;
    switch (body.action) {
      case 'reconcile':
        data = await service.reconcileInbound(actor);
        break;
      case 'claim':
        data = await service.claimNext(actor, uuid(body, 'session_id'));
        break;
      case 'inspect':
        data = await service.inspect(actor, uuid(body, 'work_id'));
        break;
      case 'renew':
        data = await service.renew(
          actor,
          uuid(body, 'work_id'),
          uuid(body, 'work_token')
        );
        break;
      case 'release':
      case 'settle':
        data = await service.release(
          actor,
          uuid(body, 'work_id'),
          uuid(body, 'work_token'),
          body.action === 'settle'
        );
        break;
      default:
        throw badRequest('Unknown work action');
    }
    const response = ok(data);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
