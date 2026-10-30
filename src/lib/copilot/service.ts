import type { Pool, PoolClient } from 'pg';
import { ApiError, badRequest, forbidden } from '@/lib/api/v1/respond';
import { transaction } from './db';
import { verifiedAnswer } from './policy';
import {
  ProviderRejected,
  sendCopilotText,
  type ProviderInput,
} from './provider';

export interface KeyActor {
  accountId: string;
  keyId: string;
}
export interface HumanActor {
  accountId: string;
  userId: string;
}
export interface ReplyInput {
  conversation_id: string;
  session_id: string;
  ownership_revision: string;
  inbound_id: string;
  idempotency_key: string;
  text: string;
  work_token?: string;
}
export interface Outbox {
  id: string;
  account_id: string;
  key_id: string;
  operator_id: string;
  conversation_id: string;
  session_id: string;
  ownership_revision: string;
  inbound_id: string;
  policy_revision: string;
  idempotency_key: string;
  reply_text: string;
  state: string;
  provider_message_id: string | null;
  attempted_at?: Date | string | null;
  authorization_basis?: string;
  knowledge_id?: string | null;
  work_token?: string | null;
}
const conflict = (message: string) => new ApiError('bad_request', message, 409);
const missing = () => new ApiError('not_found', 'Resource not found', 404);

/** Server-only service. Actor identity comes from authenticated routes, never model input. */
export class CopilotService {
  constructor(
    protected pool: Pool,
    private provider = sendCopilotText
  ) {}

  protected async human(c: PoolClient, actor: HumanActor, admin = false) {
    const { rows } = await c.query(
      `SELECT account_role FROM profiles WHERE user_id=$1 AND account_id=$2
      AND account_role = ANY($3::account_role_enum[]) FOR SHARE`,
      [
        actor.userId,
        actor.accountId,
        admin ? ['owner', 'admin'] : ['owner', 'admin', 'agent'],
      ]
    );
    if (!rows.length)
      throw forbidden('Current account role does not allow this action');
  }
  protected async key(c: PoolClient, actor: KeyActor) {
    const binding = await c.query(
      'SELECT operator_id FROM copilot_keys WHERE key_id=$1 AND account_id=$2',
      [actor.keyId, actor.accountId]
    );
    const operator = binding.rows[0]?.operator_id;
    if (!operator)
      throw forbidden('API key is not bound to a human copilot operator');
    await this.human(c, { accountId: actor.accountId, userId: operator });
    const { rows } = await c.query(
      `SELECT k.id FROM api_keys k JOIN copilot_keys b ON b.key_id=k.id
      WHERE k.id=$1 AND k.account_id=$2 AND b.account_id=$2 AND b.operator_id=$3
      AND k.revoked_at IS NULL AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())
      AND 'copilot:act'=ANY(k.scopes) AND k.scopes <@ ARRAY['copilot:act','copilot:crm','copilot:work','contacts:read','conversations:read','messages:read']::text[]
      FOR SHARE OF k,b`,
      [actor.keyId, actor.accountId, operator]
    );
    if (!rows.length)
      throw forbidden('Copilot key is revoked, expired or missing its scope');
    return operator as string;
  }
  protected async active(c: PoolClient, actor: KeyActor, sessionId: string) {
    const operator = await this.key(c, actor);
    const session = await c.query(
      `SELECT session_id FROM copilot_sessions WHERE account_id=$1 AND operator_id=$2
      AND session_id=$3 AND state='active' AND expires_at>clock_timestamp() FOR SHARE`,
      [actor.accountId, operator, sessionId]
    );
    if (!session.rows.length)
      throw conflict('Human session paused, expired or replaced');
    const policy = await c.query(
      'SELECT revision,mode FROM copilot_policies WHERE account_id=$1 AND enabled FOR SHARE',
      [actor.accountId]
    );
    if (!policy.rows.length) throw forbidden('Copilot policy is disabled');
    return {
      operator,
      policyRevision: String(policy.rows[0].revision),
      mode: policy.rows[0].mode as string,
    };
  }
  protected async clock(
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
  protected async workClock(
    c: PoolClient,
    actor: KeyActor,
    workId?: string | null,
    token?: string | null
  ) {
    if (!workId) return;
    if (
      !(
        await c.query(
          `SELECT 1 FROM copilot_work w JOIN api_keys k ON k.id=w.key_id WHERE w.id=$1 AND w.account_id=$2
      AND w.key_id=$3 AND w.lease_token=$4 AND w.lease_until>clock_timestamp()
      AND k.scopes @> ARRAY['copilot:work','messages:read','conversations:read']::text[]`,
          [workId, actor.accountId, actor.keyId, token ?? null]
        )
      ).rows.length
    )
      throw conflict('Worker lease expired, replaced or missing its scopes');
  }
  protected async guard(
    c: PoolClient,
    actor: KeyActor,
    input: Pick<ReplyInput, 'conversation_id' | 'session_id'>,
    revision?: string,
    inboundId?: string,
    workToken?: string | null,
    allocateWork = false
  ) {
    const { operator, policyRevision, mode } = await this.active(
      c,
      actor,
      input.session_id
    );
    const conv = await c.query(
      'SELECT * FROM conversations WHERE id=$1 AND account_id=$2 FOR UPDATE',
      [input.conversation_id, actor.accountId]
    );
    const row = conv.rows[0];
    if (!row) throw missing();
    if (
      revision !== undefined &&
      (row.copilot_key_id !== actor.keyId ||
        row.copilot_session_id !== input.session_id ||
        String(row.copilot_revision) !== revision)
    ) {
      throw conflict('Conversation ownership changed');
    }
    if (
      row.ai_autoreply_disabled ||
      row.status !== 'open' ||
      row.assigned_agent_id
    ) {
      throw conflict(
        'Conversation is paused, closed or assigned to another human'
      );
    }
    if (inboundId && row.copilot_latest_inbound_id !== inboundId)
      throw conflict('Latest inbound context changed');
    // Even ad-hoc APIs must not race the signed ingress's native flow phase.
    if (
      row.copilot_latest_inbound_id &&
      (
        await c.query(
          `SELECT 1 FROM copilot_work WHERE source_id=$1 AND account_id=$2 AND (NOT ready OR state IN ('completed','awaiting_human'))`,
          [row.copilot_latest_inbound_id, actor.accountId]
        )
      ).rows.length
    )
      throw conflict('Inbound processing is incomplete or already handled');
    if (row.copilot_work_id && !allocateWork) {
      if (
        row.copilot_work_token !== workToken ||
        !(
          await c.query(
            `SELECT 1 FROM copilot_work WHERE id=$1 AND account_id=$2
        AND key_id=$3 AND session_id=$4 AND ownership_revision=$5 AND policy_revision=$6
        AND source_id=$7 AND lease_token=$8 AND state='leased' FOR SHARE`,
            [
              row.copilot_work_id,
              actor.accountId,
              actor.keyId,
              input.session_id,
              row.copilot_revision,
              policyRevision,
              row.copilot_latest_inbound_id,
              workToken ?? null,
            ]
          )
        ).rows.length
      )
        throw conflict('Worker generation or conversation context changed');
      await this.workClock(c, actor, row.copilot_work_id, workToken);
    }
    await this.clock(c, actor, input.session_id, operator);
    return {
      operator,
      conv: row,
      policyRevision,
      mode,
      workId: row.copilot_work_id as string | null,
    };
  }

  async setPolicy(
    actor: HumanActor,
    enabled: boolean,
    mode?: 'human_approval' | 'hybrid'
  ) {
    if (mode !== undefined && !['human_approval', 'hybrid'].includes(mode))
      throw badRequest('Invalid policy mode');
    return transaction(this.pool, async (c) => {
      await this.human(c, actor, true);
      return (
        await c.query(
          `INSERT INTO copilot_policies(account_id,enabled,mode) VALUES($1,$2,coalesce($3,'human_approval'))
        ON CONFLICT(account_id) DO UPDATE SET enabled=$2,mode=coalesce($3,copilot_policies.mode), revision=copilot_policies.revision+1 RETURNING *`,
          [actor.accountId, enabled, mode ?? null]
        )
      ).rows[0];
    });
  }
  async bindKey(actor: HumanActor, keyId: string, operatorId = actor.userId) {
    return transaction(this.pool, async (c) => {
      const profiles = await c.query(
        `SELECT user_id,account_role FROM profiles WHERE account_id=$1 AND user_id=ANY($2::uuid[]) ORDER BY user_id FOR SHARE`,
        [actor.accountId, [actor.userId, operatorId]]
      );
      if (
        !profiles.rows.some(
          (p) =>
            p.user_id === actor.userId &&
            ['owner', 'admin'].includes(p.account_role)
        ) ||
        !profiles.rows.some(
          (p) =>
            p.user_id === operatorId &&
            ['owner', 'admin', 'agent'].includes(p.account_role)
        )
      )
        throw forbidden('Admin and operator membership required');
      const key = await c.query(
        `SELECT scopes FROM api_keys WHERE id=$1 AND account_id=$2 AND revoked_at IS NULL FOR SHARE`,
        [keyId, actor.accountId]
      );
      const scopes: string[] = key.rows[0]?.scopes ?? [];
      if (
        !scopes.includes('copilot:act') ||
        scopes.some(
          (s) =>
            ![
              'copilot:act',
              'copilot:crm',
              'copilot:work',
              'contacts:read',
              'conversations:read',
              'messages:read',
            ].includes(s)
        )
      ) {
        throw badRequest(
          'Bind a dedicated key with copilot:act, optional copilot:crm/copilot:work, and read scopes only'
        );
      }
      const result = await c.query(
        `INSERT INTO copilot_keys(key_id,account_id,operator_id) VALUES($1,$2,$3)
        ON CONFLICT(key_id) DO UPDATE SET key_id=excluded.key_id
        WHERE copilot_keys.account_id=$2 AND copilot_keys.operator_id=$3 RETURNING key_id,operator_id`,
        [keyId, actor.accountId, operatorId]
      );
      if (!result.rows.length)
        throw conflict('Key already belongs to a different operator');
      return result.rows[0];
    });
  }
  async claim(actor: KeyActor, conversationId: string, sessionId: string) {
    return transaction(this.pool, async (c) => {
      const { conv } = await this.guard(c, actor, {
        conversation_id: conversationId,
        session_id: sessionId,
      });
      if (conv.copilot_key_id && conv.copilot_key_id !== actor.keyId)
        throw conflict('Conversation already claimed');
      if (
        conv.copilot_key_id === actor.keyId &&
        conv.copilot_session_id === sessionId
      )
        return {
          revision: String(conv.copilot_revision),
          inbound_id: conv.copilot_latest_inbound_id,
        };
      const result = await c.query(
        `UPDATE conversations SET copilot_key_id=$1,copilot_session_id=$2,copilot_revision=copilot_revision+1
        WHERE id=$3 AND account_id=$4 RETURNING copilot_revision,copilot_latest_inbound_id`,
        [actor.keyId, sessionId, conversationId, actor.accountId]
      );
      return {
        revision: String(result.rows[0].copilot_revision),
        inbound_id: result.rows[0].copilot_latest_inbound_id,
      };
    });
  }
  async prepare(actor: KeyActor, input: ReplyInput): Promise<Outbox> {
    if (
      !input.text.trim() ||
      input.text.length > 4096 ||
      input.idempotency_key.length < 8 ||
      input.idempotency_key.length > 128
    )
      throw badRequest('Invalid reply or idempotency key');
    return transaction(this.pool, async (c) => {
      // Return an existing outcome before requiring a live session; it never resubmits.
      const previous = await c.query(
        'SELECT * FROM copilot_outbox WHERE account_id=$1 AND key_id=$2 AND idempotency_key=$3',
        [actor.accountId, actor.keyId, input.idempotency_key]
      );
      if (previous.rows.length) {
        await this.key(c, actor);
        const row: Outbox = previous.rows[0];
        if (
          row.conversation_id !== input.conversation_id ||
          row.reply_text !== input.text ||
          row.inbound_id !== input.inbound_id ||
          row.session_id !== input.session_id ||
          String(row.ownership_revision) !== input.ownership_revision ||
          (row.work_token ?? undefined) !== input.work_token
        )
          throw conflict('Idempotency key payload changed');
        return row;
      }
      const gate = await this.guard(
        c,
        actor,
        input,
        input.ownership_revision,
        input.inbound_id,
        input.work_token
      );
      const knowledgeId =
        gate.mode === 'hybrid'
          ? await verifiedAnswer(
              c,
              actor.accountId,
              input.inbound_id,
              input.text
            )
          : null;
      const result = await c.query(
        `INSERT INTO copilot_outbox(account_id,key_id,operator_id,conversation_id,session_id,ownership_revision,
        inbound_id,policy_revision,idempotency_key,reply_text,state,authorization_basis,knowledge_id,work_token) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14)
        ON CONFLICT DO NOTHING RETURNING *`,
        [
          actor.accountId,
          actor.keyId,
          gate.operator,
          input.conversation_id,
          input.session_id,
          input.ownership_revision,
          input.inbound_id,
          gate.policyRevision,
          input.idempotency_key,
          input.text,
          knowledgeId ? 'approved' : 'draft',
          knowledgeId ? 'verified_answer' : 'human_approval',
          knowledgeId,
          input.work_token ?? null,
        ]
      );
      if (!result.rows.length)
        throw conflict(
          'An outbox entry already exists for this inbound; inspect its outcome'
        );
      await this.clock(c, actor, input.session_id, gate.operator);
      await this.workClock(c, actor, gate.workId, input.work_token);
      return result.rows[0];
    });
  }
  async get(actor: KeyActor, id: string): Promise<Outbox> {
    return transaction(this.pool, async (c) => {
      await this.key(c, actor);
      const row = (
        await c.query(
          'SELECT * FROM copilot_outbox WHERE id=$1 AND account_id=$2 AND key_id=$3',
          [id, actor.accountId, actor.keyId]
        )
      ).rows[0];
      if (!row) throw missing();
      return row;
    });
  }
  async approve(actor: HumanActor, id: string) {
    return transaction(this.pool, async (c) => {
      await this.human(c, actor);
      const row: Outbox = (
        await c.query(
          'SELECT * FROM copilot_outbox WHERE id=$1 AND account_id=$2 AND operator_id=$3',
          [id, actor.accountId, actor.userId]
        )
      ).rows[0];
      if (!row) throw missing();
      const gate = await this.guard(
        c,
        { accountId: actor.accountId, keyId: row.key_id },
        row,
        String(row.ownership_revision),
        row.inbound_id,
        row.work_token
      );
      if (gate.policyRevision !== String(row.policy_revision))
        throw conflict('Policy changed; approval is stale');
      const result = await c.query(
        `UPDATE copilot_outbox SET state='approved',approved_by=$2,approved_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND state IN ('draft','approved') RETURNING *`,
        [id, actor.userId]
      );
      if (!result.rows.length) throw conflict('Outbox is no longer approvable');
      return result.rows[0];
    });
  }
  async takeover(actor: HumanActor, conversationId: string, release = false) {
    return transaction(this.pool, async (c) => {
      await this.human(c, actor);
      const result = await c.query(
        `UPDATE conversations SET copilot_key_id=NULL,copilot_session_id=NULL,copilot_revision=copilot_revision+1,
        assigned_agent_id=$3,ai_autoreply_disabled=$4 WHERE id=$1 AND account_id=$2 RETURNING id,copilot_revision,assigned_agent_id,ai_handoff_summary`,
        [
          conversationId,
          actor.accountId,
          release ? null : actor.userId,
          !release,
        ]
      );
      if (!result.rows.length) throw missing();
      return result.rows[0];
    });
  }
  private async accepted(
    c: PoolClient,
    row: Outbox,
    wamid: string,
    status = 'sent'
  ) {
    await c.query(
      `UPDATE copilot_outbox SET state=$3,provider_message_id=$2,error_code=$4,updated_at=clock_timestamp() WHERE id=$1 AND account_id=$5`,
      [
        row.id,
        wamid,
        status === 'failed' ? 'failed' : 'sent',
        status === 'failed' ? 'verified_provider_failure' : null,
        row.account_id,
      ]
    );
    await c.query(
      `INSERT INTO messages(conversation_id,sender_type,content_type,content_text,message_id,status,ai_generated,reply_to_message_id,created_at)
      SELECT $1,'bot','text',$2,$3,$5,true,$4,coalesce($6::timestamptz,clock_timestamp())
      WHERE NOT EXISTS(SELECT 1 FROM messages WHERE conversation_id=$1 AND message_id=$3)`,
      [
        row.conversation_id,
        row.reply_text,
        wamid,
        row.inbound_id,
        status,
        row.attempted_at ?? null,
      ]
    );
    await c.query(
      `UPDATE conversations SET last_message_text=$2,last_message_at=coalesce($3::timestamptz,clock_timestamp()),updated_at=clock_timestamp()
      WHERE id=$1 AND account_id=$4 AND (last_message_at IS NULL OR last_message_at<=coalesce($3::timestamptz,clock_timestamp()))`,
      [
        row.conversation_id,
        row.reply_text,
        row.attempted_at ?? null,
        row.account_id,
      ]
    );
  }
  private async eligible(
    c: PoolClient,
    actor: KeyActor,
    row: Outbox,
    operator: string
  ) {
    return c.query(
      `SELECT m.message_id AS inbound_wamid,w.phone_number_id,w.access_token,ct.phone,ct.wa_user_id
          FROM messages m JOIN conversations cv ON cv.id=m.conversation_id JOIN contacts ct ON ct.id=cv.contact_id AND ct.account_id=cv.account_id
          JOIN whatsapp_config w ON w.account_id=cv.account_id
          JOIN copilot_sessions s ON s.account_id=cv.account_id AND s.operator_id=$4
          WHERE m.id=$1 AND m.conversation_id=$2 AND cv.account_id=$3 AND m.sender_type='customer'
          AND m.copilot_verified_inbound AND m.message_id LIKE 'wamid.%' AND w.status='connected'
          AND m.created_at>clock_timestamp()-interval '24 hours' AND m.created_at<=clock_timestamp()
          AND s.session_id=$5 AND s.state='active' AND s.expires_at>clock_timestamp()
          AND EXISTS(SELECT 1 FROM api_keys k WHERE k.id=$6 AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp()))
          FOR SHARE OF ct,w`,
      [
        row.inbound_id,
        row.conversation_id,
        actor.accountId,
        operator,
        row.session_id,
        actor.keyId,
      ]
    );
  }
  private async replyAuthorization(
    c: PoolClient,
    actor: KeyActor,
    row: Outbox,
    mode: string
  ) {
    if (row.authorization_basis !== 'verified_answer') return;
    if (
      mode !== 'hybrid' ||
      !row.knowledge_id ||
      (await verifiedAnswer(
        c,
        actor.accountId,
        row.inbound_id,
        row.reply_text
      )) !== row.knowledge_id
    )
      throw conflict(
        'Verified business answer changed or expired; human review required'
      );
  }
  async dispatch(actor: KeyActor, id: string): Promise<Outbox> {
    const row = await this.get(actor, id);
    // A durable pre-dispatch latch survives process/connection failure. No retry path exists.
    const acquired = await transaction(this.pool, async (c) => {
      const gate = await this.guard(
        c,
        actor,
        row,
        String(row.ownership_revision),
        row.inbound_id,
        row.work_token
      );
      if (gate.policyRevision !== String(row.policy_revision))
        throw conflict('Policy changed');
      await this.replyAuthorization(c, actor, row, gate.mode);
      return (
        (
          await c.query(
            `UPDATE copilot_outbox SET state='dispatching',attempted_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND state='approved' AND (approved_by=$2 OR authorization_basis='verified_answer') RETURNING id`,
            [id, gate.operator]
          )
        ).rowCount === 1
      );
    });
    if (!acquired) return this.get(actor, id);
    let attempted = false;
    try {
      await transaction(this.pool, async (c) => {
        const gate = await this.guard(
          c,
          actor,
          row,
          String(row.ownership_revision),
          row.inbound_id,
          row.work_token
        );
        const current = (
          await c.query('SELECT * FROM copilot_outbox WHERE id=$1 FOR UPDATE', [
            id,
          ])
        ).rows[0];
        if (
          current.state !== 'dispatching' ||
          gate.policyRevision !== String(row.policy_revision)
        )
          throw conflict('Outbox authority changed');
        await this.replyAuthorization(c, actor, current, gate.mode);
        const eligible = await this.eligible(c, actor, row, gate.operator);
        if (!eligible.rows.length)
          throw conflict(
            'WhatsApp text reply window or session is not eligible'
          );
        const controller = new AbortController();
        const onError = () => controller.abort();
        c.on('error', onError);
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          // Contact/config locks may have waited after the first clock check.
          // Recheck all clocks and eligibility after those locks, before submission.
          await this.guard(
            c,
            actor,
            current,
            String(current.ownership_revision),
            current.inbound_id,
            current.work_token
          );
          const finalEligible = await this.eligible(
            c,
            actor,
            current,
            gate.operator
          );
          if (!finalEligible.rows.length)
            throw conflict('Final WhatsApp eligibility changed');
          await this.replyAuthorization(c, actor, current, gate.mode);
          attempted = true;
          const wamid = await this.provider(
            { ...finalEligible.rows[0], text: row.reply_text } as ProviderInput,
            controller.signal
          );
          await this.accepted(c, current, wamid);
        } finally {
          clearTimeout(timeout);
          c.removeListener('error', onError);
        }
      });
    } catch (error) {
      // If COMMIT/connection fails after submission, the durable latch still
      // prevents another send. Keep unknown outcomes for receipt reconciliation.
      const state = !attempted
        ? 'cancelled'
        : error instanceof ProviderRejected
          ? 'failed'
          : 'unknown';
      await this.pool
        .query(
          `UPDATE copilot_outbox SET state=$2,error_code=$3,updated_at=clock_timestamp() WHERE id=$1 AND state='dispatching'`,
          [
            id,
            state,
            !attempted
              ? 'authorization_changed'
              : state === 'failed'
                ? 'provider_rejected'
                : 'provider_outcome_unknown',
          ]
        )
        .catch(() => {});
      if (!attempted) throw error;
    }
    return this.get(actor, id);
  }

  /** Human links an ambiguous attempt to a receipt already stored by the signed Meta webhook. Never resends. */
  async reconcile(actor: HumanActor, id: string, wamid: string) {
    return transaction(this.pool, async (c) => {
      await this.human(c, actor);
      const row: Outbox = (
        await c.query(
          'SELECT * FROM copilot_outbox WHERE id=$1 AND account_id=$2 AND operator_id=$3',
          [id, actor.accountId, actor.userId]
        )
      ).rows[0];
      if (!row) throw missing();
      await c.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
        row.conversation_id,
      ]);
      const current = (
        await c.query(
          'SELECT state FROM copilot_outbox WHERE id=$1 FOR UPDATE',
          [id]
        )
      ).rows[0];
      if (!['dispatching', 'unknown'].includes(current.state))
        throw conflict('Only indeterminate attempts can be reconciled');
      const receipt = await c.query(
        `SELECT status FROM pending_message_statuses WHERE account_id=$1 AND wamid=$2
        AND status IN ('sent','delivered','read','failed') ORDER BY (status='failed'),created_at DESC LIMIT 1`,
        [actor.accountId, wamid]
      );
      if (!receipt.rows.length)
        throw conflict(
          'A stored signed-provider status receipt is required; do not retry'
        );
      const mismatch = await c.query(
        `SELECT 1 FROM messages m JOIN conversations cv ON cv.id=m.conversation_id
        WHERE cv.account_id=$1 AND m.message_id=$2 AND (m.conversation_id<>$3 OR m.content_text IS DISTINCT FROM $4)`,
        [actor.accountId, wamid, row.conversation_id, row.reply_text]
      );
      if (mismatch.rows.length)
        throw conflict(
          'Provider ID already belongs to different conversation content'
        );
      await this.accepted(c, row, wamid, receipt.rows[0].status);
      await c.query(
        'UPDATE copilot_outbox SET reconciled_by=$2,reconciled_at=clock_timestamp() WHERE id=$1',
        [id, actor.userId]
      );
      return (await c.query('SELECT * FROM copilot_outbox WHERE id=$1', [id]))
        .rows[0];
    });
  }
}
