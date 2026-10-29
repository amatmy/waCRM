import { NextResponse } from 'next/server';
import { requireRole, toErrorResponse } from '@/lib/auth/account';
import {
  checkRateLimit,
  rateLimitResponse,
  RATE_LIMITS,
} from '@/lib/rate-limit';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Human cookie authentication only. Never expose activation as an MCP tool. */
export async function POST(request: Request) {
  try {
    const { supabase, userId } = await requireRole('agent');
    // Require the same-origin browser header, including for clients that
    // would otherwise omit Origin. This is a human dashboard operation.
    if (request.headers.get('origin') !== new URL(request.url).origin) {
      return NextResponse.json(
        { error: 'Same-origin request required' },
        { status: 403 }
      );
    }
    const limit = checkRateLimit(
      `copilot-session:${userId}`,
      RATE_LIMITS.adminAction
    );
    if (!limit.success) return rateLimitResponse(limit);
    const body = await request.json().catch(() => null);
    if (
      !body ||
      !['start', 'heartbeat', 'pause'].includes(body.action) ||
      (body.action !== 'start' &&
        (typeof body.session_id !== 'string' || !UUID.test(body.session_id)))
    ) {
      return NextResponse.json(
        { error: 'Invalid session action or session_id' },
        { status: 400 }
      );
    }
    const { data, error } = await supabase.rpc('transition_copilot_session', {
      p_action: body.action,
      p_session_id: body.action === 'start' ? null : body.session_id,
    });
    if (error?.code === 'P0001') {
      return NextResponse.json(
        { error: 'Session changed or expired; start explicitly' },
        { status: 409 }
      );
    }
    if (error?.code === '42501') {
      return NextResponse.json(
        { error: 'Operator membership required' },
        { status: 403 }
      );
    }
    if (error) throw error;
    return NextResponse.json(
      { data },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}

export async function GET() {
  try {
    const { supabase, accountId, userId } = await requireRole('agent');
    const { data, error } = await supabase.rpc('get_copilot_session', {
      p_account_id: accountId,
      p_operator_id: userId,
    });
    if (error) throw error;
    return NextResponse.json(
      { data },
      { headers: { 'Cache-Control': 'no-store' } }
    );
  } catch (error) {
    return toErrorResponse(error);
  }
}
