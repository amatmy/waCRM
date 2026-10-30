import type { PoolClient } from 'pg';
import { ApiError, badRequest, forbidden } from '@/lib/api/v1/respond';
import { transaction } from './db';
import { object, text, uuid, revision, optionalUuid } from './input';
import { CopilotService, type KeyActor, type HumanActor } from './service';
import { normalizeQuestion, requiresHuman } from './policy';

export type CrmInput = {
  work_token?: string;
  action: 'assign' | 'handoff' | 'note' | 'status' | 'deal';
  conversation_id: string;
  session_id: string;
  inbound_id: string;
  ownership_revision: string;
  idempotency_key: string;
  payload: Record<string, string>;
};
const conflict = (message: string) => new ApiError('bad_request', message, 409);
const missing = () => new ApiError('not_found', 'Resource not found', 404);
const fields = (body: Record<string, unknown>, allowed: string[]) => {
  if (Object.keys(body).some((k) => !allowed.includes(k)))
    throw badRequest('Unsupported action field');
};
/** Parse both at the HTTP boundary and at the service boundary. No arbitrary field updates. */
export function crmInput(value: unknown): CrmInput {
  const body = object(value);
  fields(body, [
    'action',
    'conversation_id',
    'session_id',
    'inbound_id',
    'ownership_revision',
    'idempotency_key',
    'payload',
    'work_token',
  ]);
  const action = text(body, 'action', 20) as CrmInput['action'];
  const payload = object(body.payload);
  const clean: Record<string, string> = {};
  switch (action) {
    case 'assign':
      fields(payload, ['operator_id', 'summary']);
      clean.operator_id = uuid(payload, 'operator_id');
      clean.summary = text(payload, 'summary', 2000);
      break;
    case 'handoff':
      fields(payload, ['summary']);
      clean.summary = text(payload, 'summary', 2000);
      break;
    case 'note':
      fields(payload, ['note']);
      clean.note = text(payload, 'note', 4000);
      break;
    case 'status':
      fields(payload, ['status']);
      clean.status = text(payload, 'status', 10);
      if (!['open', 'pending', 'closed'].includes(clean.status))
        throw badRequest('Invalid status');
      break;
    case 'deal':
      // No monetary terms, currency, deletion, reassignment, or pipeline moves.
      fields(payload, ['deal_id', 'title', 'stage_id', 'status']);
      clean.deal_id = uuid(payload, 'deal_id');
      if (payload.title !== undefined)
        clean.title = text(payload, 'title', 200);
      if (payload.stage_id !== undefined)
        clean.stage_id = uuid(payload, 'stage_id');
      if (payload.status !== undefined) {
        clean.status = text(payload, 'status', 10);
        if (!['open', 'won', 'lost'].includes(clean.status))
          throw badRequest('Invalid deal status');
      }
      if (Object.keys(clean).length < 2)
        throw badRequest('Deal change required');
      break;
    default:
      throw badRequest('Unknown CRM action');
  }
  const idempotency_key = text(body, 'idempotency_key', 128);
  if (idempotency_key.length < 8) throw badRequest('Invalid idempotency key');
  return {
    action,
    ...(body.work_token === undefined
      ? {}
      : { work_token: optionalUuid(body, 'work_token') }),
    conversation_id: uuid(body, 'conversation_id'),
    session_id: uuid(body, 'session_id'),
    inbound_id: uuid(body, 'inbound_id'),
    ownership_revision: revision(body),
    idempotency_key,
    payload: clean,
  };
}

export class CopilotCrmService extends CopilotService {
  private async crmKey(c: PoolClient, actor: KeyActor) {
    const operator = await this.key(c, actor);
    if (
      !(
        await c.query(
          "SELECT 1 FROM api_keys WHERE id=$1 AND 'copilot:crm'=ANY(scopes)",
          [actor.keyId]
        )
      ).rows.length
    )
      throw forbidden('copilot:crm scope required');
    return operator;
  }
  private async live(
    c: PoolClient,
    actor: KeyActor,
    sessionId: string,
    operator: string
  ) {
    if (
      !(
        await c.query(
          `SELECT 1 FROM copilot_sessions s JOIN api_keys k ON k.id=$3
      WHERE s.account_id=$1 AND s.operator_id=$2 AND s.session_id=$4 AND s.state='active'
      AND s.expires_at>clock_timestamp() AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())`,
          [actor.accountId, operator, actor.keyId, sessionId]
        )
      ).rows.length
    )
      throw conflict('Human session or key expired while waiting');
  }
  private async contact(c: PoolClient, actor: KeyActor, contactId: string) {
    if (
      !(
        await c.query(
          'SELECT id FROM contacts WHERE id=$1 AND account_id=$2 FOR SHARE',
          [contactId, actor.accountId]
        )
      ).rows.length
    )
      throw missing();
  }
  async context(
    actor: KeyActor,
    conversationId: string,
    sessionId: string,
    ownershipRevision: string,
    workToken?: string
  ) {
    return transaction(this.pool, async (c) => {
      await this.crmKey(c, actor);
      const { conv } = await this.guard(
        c,
        actor,
        { conversation_id: conversationId, session_id: sessionId },
        ownershipRevision,
        undefined,
        workToken
      );
      await this.contact(c, actor, conv.contact_id);
      const operators = (
        await c.query(
          `SELECT user_id,full_name,account_role FROM profiles
        WHERE account_id=$1 AND account_role IN ('owner','admin','agent') ORDER BY user_id`,
          [actor.accountId]
        )
      ).rows;
      const deals = (
        await c.query(
          `SELECT id,title,pipeline_id,stage_id,status FROM deals
        WHERE account_id=$1 AND conversation_id=$2 AND contact_id=$3 ORDER BY id`,
          [actor.accountId, conversationId, conv.contact_id]
        )
      ).rows;
      const stages = (
        await c.query(
          `SELECT s.id,s.pipeline_id,s.name FROM pipeline_stages s JOIN pipelines p ON p.id=s.pipeline_id
        WHERE p.account_id=$1 AND p.id=ANY($2::uuid[]) ORDER BY s.position,s.id`,
          [actor.accountId, deals.map((d) => d.pipeline_id)]
        )
      ).rows;
      return { operators, deals, stages };
    });
  }
  async outcome(actor: KeyActor, id: string) {
    return transaction(this.pool, async (c) => {
      await this.crmKey(c, actor);
      const row = (
        await c.query(
          'SELECT * FROM copilot_actions WHERE id=$1 AND account_id=$2 AND key_id=$3',
          [id, actor.accountId, actor.keyId]
        )
      ).rows[0];
      if (!row) throw missing();
      return row;
    });
  }
  async perform(actor: KeyActor, value: CrmInput) {
    const input = crmInput(value);
    return transaction(this.pool, async (c) => {
      await this.crmKey(c, actor);
      // Serialize identical retries before any mutation, including handoff which
      // revokes its own claim. Hash collisions only serialize unrelated actions.
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `${actor.keyId}:${input.idempotency_key}`,
      ]);
      const previous = (
        await c.query(
          'SELECT * FROM copilot_actions WHERE account_id=$1 AND key_id=$2 AND idempotency_key=$3',
          [actor.accountId, actor.keyId, input.idempotency_key]
        )
      ).rows[0];
      if (previous) {
        await this.crmKey(c, actor);
        // jsonb equality is independent of object field order.
        if (
          !(
            await c.query('SELECT $1::jsonb = $2::jsonb AS same', [
              previous.request,
              JSON.stringify(input),
            ])
          ).rows[0].same
        )
          throw conflict('Idempotency key payload changed');
        return previous; // Read-only replay works after pause/takeover; never reruns.
      }
      const { conv, operator, workId } = await this.guard(
        c,
        actor,
        input,
        input.ownership_revision,
        input.inbound_id,
        input.work_token
      );
      await this.contact(c, actor, conv.contact_id);
      const p = input.payload;
      let result: unknown;
      if (input.action === 'assign') {
        await this.human(c, {
          accountId: actor.accountId,
          userId: p.operator_id,
        });
      }
      if (input.action === 'deal') {
        const deal = (
          await c.query(
            `SELECT d.* FROM deals d JOIN pipelines p ON p.id=d.pipeline_id AND p.account_id=d.account_id
          WHERE d.id=$1 AND d.account_id=$2 AND d.conversation_id=$3 AND d.contact_id=$4 FOR UPDATE OF d FOR SHARE OF p`,
            [p.deal_id, actor.accountId, input.conversation_id, conv.contact_id]
          )
        ).rows[0];
        if (!deal) throw missing();
        if (
          p.stage_id &&
          !(
            await c.query(
              'SELECT id FROM pipeline_stages WHERE id=$1 AND pipeline_id=$2 FOR SHARE',
              [p.stage_id, deal.pipeline_id]
            )
          ).rows.length
        )
          throw badRequest('Stage must belong to the current deal pipeline');
        await this.live(c, actor, input.session_id, operator);
        result = (
          await c.query(
            `UPDATE deals SET title=coalesce($3,title),stage_id=coalesce($4::uuid,stage_id),status=coalesce($5,status)
          WHERE id=$1 AND account_id=$2 RETURNING id,title,pipeline_id,stage_id,status`,
            [
              p.deal_id,
              actor.accountId,
              p.title ?? null,
              p.stage_id ?? null,
              p.status ?? null,
            ]
          )
        ).rows[0];
      } else {
        await this.live(c, actor, input.session_id, operator);
        if (input.action === 'note') {
          result = (
            await c.query(
              `INSERT INTO contact_notes(account_id,contact_id,user_id,note_text) VALUES($1,$2,$3,$4)
            RETURNING id,contact_id,user_id,note_text,created_at`,
              [actor.accountId, conv.contact_id, operator, p.note]
            )
          ).rows[0];
        } else if (input.action === 'status') {
          result = (
            await c.query(
              `UPDATE conversations SET status=$3 WHERE id=$1 AND account_id=$2
            RETURNING id,status,copilot_revision,ai_autoreply_disabled`,
              [input.conversation_id, actor.accountId, p.status]
            )
          ).rows[0];
        } else {
          result = (
            await c.query(
              `UPDATE conversations SET copilot_key_id=NULL,copilot_session_id=NULL,copilot_revision=copilot_revision+1,
            assigned_agent_id=$3,ai_autoreply_disabled=true,ai_handoff_summary=$4 WHERE id=$1 AND account_id=$2
            RETURNING id,assigned_agent_id,ai_handoff_summary,copilot_revision,ai_autoreply_disabled`,
              [
                input.conversation_id,
                actor.accountId,
                p.operator_id ?? operator,
                p.summary,
              ]
            )
          ).rows[0];
        }
      }
      const outcome = (
        await c.query(
          `INSERT INTO copilot_actions(account_id,key_id,operator_id,conversation_id,session_id,ownership_revision,action,idempotency_key,request,result)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) RETURNING *`,
          [
            actor.accountId,
            actor.keyId,
            operator,
            input.conversation_id,
            input.session_id,
            input.ownership_revision,
            input.action,
            input.idempotency_key,
            JSON.stringify(input),
            JSON.stringify(result),
          ]
        )
      ).rows[0];
      await this.live(c, actor, input.session_id, operator);
      await this.workClock(c, actor, workId, input.work_token);
      return outcome;
    });
  }
  async verifyBusinessAnswer(actor: HumanActor, value: unknown) {
    const body = object(value);
    fields(body, [
      'question',
      'answer',
      'source_reference',
      'expires_at',
      'enabled',
    ]);
    const question = normalizeQuestion(text(body, 'question'));
    const answer = text(body, 'answer');
    const source = text(body, 'source_reference', 2000);
    const expires = text(body, 'expires_at', 50);
    const enabled = body.enabled === undefined ? true : body.enabled;
    if (
      typeof enabled !== 'boolean' ||
      !Number.isFinite(Date.parse(expires)) ||
      Date.parse(expires) <= Date.now()
    )
      throw badRequest('Valid future expiry and enabled boolean required');
    if (requiresHuman(question) || requiresHuman(answer))
      throw badRequest('Sensitive requests require human approval or handoff');
    return transaction(this.pool, async (c) => {
      await this.human(c, actor, true);
      // Same policy lock order as reply authorization; every content edit invalidates unsent approvals.
      await c.query(
        `INSERT INTO copilot_policies(account_id) VALUES($1) ON CONFLICT DO NOTHING`,
        [actor.accountId]
      );
      await c.query(
        'UPDATE copilot_policies SET revision=revision+1 WHERE account_id=$1',
        [actor.accountId]
      );
      return (
        await c.query(
          `INSERT INTO copilot_answers(account_id,query_normalized,answer_text,source_reference,verified_by,expires_at,enabled)
        VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(account_id,query_normalized) DO UPDATE SET answer_text=$3,source_reference=$4,
        verified_by=$5,expires_at=$6,enabled=$7,updated_at=clock_timestamp() RETURNING *`,
          [
            actor.accountId,
            question,
            answer,
            source,
            actor.userId,
            expires,
            enabled,
          ]
        )
      ).rows[0];
    });
  }
}
