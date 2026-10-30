import type { Pool, PoolClient } from 'pg';
import { ApiError, badRequest, forbidden } from '@/lib/api/v1/respond';
import { transaction } from './db';
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
}
const conflict = (message: string) => new ApiError('bad_request', message, 409);
const missing = () => new ApiError('not_found', 'Resource not found', 404);

/** Server-only service. Actor identity comes from authenticated routes, never model input. */
export class CopilotService {
  constructor(
    private pool: Pool,
    private provider = sendCopilotText
  ) {}

  private async human(c: PoolClient, actor: HumanActor, admin = false) {
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
  private async key(c: PoolClient, actor: KeyActor) {
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
      AND 'copilot:act'=ANY(k.scopes) AND k.scopes <@ ARRAY['copilot:act','contacts:read','conversations:read','messages:read']::text[]
      FOR SHARE OF k,b`,
      [actor.keyId, actor.accountId, operator]
    );
    if (!rows.length)
      throw forbidden('Copilot key is revoked, expired or missing its scope');
    return operator as string;
  }
  private async guard(
    c: PoolClient,
    actor: KeyActor,
    input: Pick<ReplyInput, 'conversation_id' | 'session_id'>,
    revision?: string,
    inboundId?: string
  ) {
    const operator = await this.key(c, actor);
    const session = await c.query(
      `SELECT session_id FROM copilot_sessions WHERE account_id=$1 AND operator_id=$2
      AND session_id=$3 AND state='active' AND expires_at>clock_timestamp() FOR SHARE`,
      [actor.accountId, operator, input.session_id]
    );
    if (!session.rows.length)
      throw conflict('Human session paused, expired or replaced');
    const policy = await c.query(
      "SELECT revision FROM copilot_policies WHERE account_id=$1 AND enabled AND mode='human_approval' FOR SHARE",
      [actor.accountId]
    );
    if (!policy.rows.length) throw forbidden('Copilot policy is disabled');
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
    // Recheck after all potentially blocking locks; statement/transaction NOW is insufficient.
    const live = await c.query(
      `SELECT 1 FROM copilot_sessions s JOIN api_keys k ON k.id=$3 WHERE s.account_id=$1 AND s.operator_id=$2
      AND s.expires_at>clock_timestamp() AND (k.expires_at IS NULL OR k.expires_at>clock_timestamp())`,
      [actor.accountId, operator, actor.keyId]
    );
    if (!live.rows.length)
      throw conflict('Human session expired while waiting');
    return {
      operator,
      conv: row,
      policyRevision: String(policy.rows[0].revision),
    };
  }

  async setPolicy(actor: HumanActor, enabled: boolean) {
    return transaction(this.pool, async (c) => {
      await this.human(c, actor, true);
      return (
        await c.query(
          `INSERT INTO copilot_policies(account_id,enabled) VALUES($1,$2)
        ON CONFLICT(account_id) DO UPDATE SET enabled=$2, revision=copilot_policies.revision+1 RETURNING *`,
          [actor.accountId, enabled]
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
              'contacts:read',
              'conversations:read',
              'messages:read',
            ].includes(s)
        )
      ) {
        throw badRequest(
          'Bind a dedicated key with copilot:act and read scopes only'
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
          String(row.ownership_revision) !== input.ownership_revision
        )
          throw conflict('Idempotency key payload changed');
        return row;
      }
      const gate = await this.guard(
        c,
        actor,
        input,
        input.ownership_revision,
        input.inbound_id
      );
      const result = await c.query(
        `INSERT INTO copilot_outbox(account_id,key_id,operator_id,conversation_id,session_id,ownership_revision,
        inbound_id,policy_revision,idempotency_key,reply_text) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
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
        ]
      );
      if (!result.rows.length)
        throw conflict(
          'An outbox entry already exists for this inbound; inspect its outcome'
        );
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
        row.inbound_id
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
  async handoff(
    actor: KeyActor,
    conversationId: string,
    revision: string,
    summary: string
  ) {
    return transaction(this.pool, async (c) => {
      const operator = await this.key(c, actor);
      const row = (
        await c.query(
          'SELECT * FROM conversations WHERE id=$1 AND account_id=$2 FOR UPDATE',
          [conversationId, actor.accountId]
        )
      ).rows[0];
      if (!row) throw missing();
      if (
        row.copilot_key_id !== actor.keyId ||
        String(row.copilot_revision) !== revision
      )
        throw conflict('Conversation ownership changed');
      return (
        await c.query(
          `UPDATE conversations SET copilot_key_id=NULL,copilot_session_id=NULL,copilot_revision=copilot_revision+1,
        assigned_agent_id=coalesce(assigned_agent_id,$3),ai_autoreply_disabled=true,ai_handoff_summary=$4
        WHERE id=$1 AND account_id=$2 RETURNING id,copilot_revision,assigned_agent_id,ai_handoff_summary`,
          [conversationId, actor.accountId, operator, summary.slice(0, 2000)]
        )
      ).rows[0];
    });
  }

  private async accepted(c: PoolClient, row: Outbox, wamid: string) {
    await c.query(
      `UPDATE copilot_outbox SET state='sent',provider_message_id=$2,error_code=NULL,updated_at=clock_timestamp() WHERE id=$1`,
      [row.id, wamid]
    );
    await c.query(
      `INSERT INTO messages(conversation_id,sender_type,content_type,content_text,message_id,status,ai_generated,reply_to_message_id)
      SELECT $1,'bot','text',$2,$3,'sent',true,$4 WHERE NOT EXISTS(SELECT 1 FROM messages WHERE message_id=$3)`,
      [row.conversation_id, row.reply_text, wamid, row.inbound_id]
    );
    await c.query(
      `UPDATE conversations SET last_message_text=$2,last_message_at=clock_timestamp(),updated_at=clock_timestamp() WHERE id=$1`,
      [row.conversation_id, row.reply_text]
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
        row.inbound_id
      );
      if (gate.policyRevision !== String(row.policy_revision))
        throw conflict('Policy changed');
      return (
        (
          await c.query(
            `UPDATE copilot_outbox SET state='dispatching',attempted_at=clock_timestamp(),updated_at=clock_timestamp()
        WHERE id=$1 AND state='approved' AND approved_by=$2 RETURNING id`,
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
          row.inbound_id
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
        const eligible = await c.query(
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
            gate.operator,
            row.session_id,
            actor.keyId,
          ]
        );
        if (!eligible.rows.length)
          throw conflict(
            'WhatsApp text reply window or session is not eligible'
          );
        const controller = new AbortController();
        const onError = () => controller.abort();
        c.on('error', onError);
        const timeout = setTimeout(() => controller.abort(), 10000);
        try {
          attempted = true;
          const wamid = await this.provider(
            { ...eligible.rows[0], text: row.reply_text } as ProviderInput,
            controller.signal
          );
          await this.accepted(c, row, wamid);
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
      if (receipt.rows[0].status === 'failed')
        await c.query(
          "UPDATE copilot_outbox SET state='failed',provider_message_id=$2,error_code='verified_provider_failure',updated_at=clock_timestamp() WHERE id=$1",
          [id, wamid]
        );
      else await this.accepted(c, row, wamid);
      await c.query(
        'UPDATE copilot_outbox SET reconciled_by=$2,reconciled_at=clock_timestamp() WHERE id=$1',
        [id, actor.userId]
      );
      return (await c.query('SELECT * FROM copilot_outbox WHERE id=$1', [id]))
        .rows[0];
    });
  }
}
