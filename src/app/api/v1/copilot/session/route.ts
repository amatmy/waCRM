import { requireApiKey } from '@/lib/auth/api-context';
import { badRequest, ok, toApiErrorResponse } from '@/lib/api/v1/respond';

/** Read-only capability; the key's account is never supplied by the caller. */
export async function GET(request: Request) {
  try {
    const ctx = await requireApiKey(request, 'conversations:read');
    const operatorId = new URL(request.url).searchParams.get('operator_id');
    if (
      !operatorId ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        operatorId
      )
    ) {
      throw badRequest('operator_id must be a UUID');
    }
    const { data, error } = await ctx.supabase.rpc('get_copilot_session', {
      p_account_id: ctx.accountId,
      p_operator_id: operatorId,
    });
    if (error) throw error;
    const response = ok(data);
    response.headers.set('Cache-Control', 'no-store');
    return response;
  } catch (error) {
    return toApiErrorResponse(error);
  }
}
