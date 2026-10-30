// Machine dispatch must use the guarded copilot outbox. A bearer key is
// never sufficient authority for a raw send or broadcast in this fork.
import { requireApiKey } from '@/lib/auth/api-context';
import { fail, toApiErrorResponse } from '@/lib/api/v1/respond';
export async function POST(request: Request) {
  try {
    await requireApiKey(request);
    return fail(
      'forbidden',
      'Raw machine sends and broadcasts are disabled; use the guarded copilot outbox',
      403
    );
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
