import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { ApiError, forbidden, badRequest } from '@/lib/api/v1/respond';
import { transaction } from './db';
import { CopilotService, type KeyActor, type HumanActor } from './service';

const conflict = (s: string) => new ApiError('bad_request', s, 409);
const missing = () => new ApiError('not_found', 'Work not found', 404);
export interface WorkLease {
  id: string;
  conversation_id: string;
  source_id: string;
  lease_token: string;
  session_id: string;
  ownership_revision: string;
  lease_until: string | Date;
  policy_revision: string;
  state: string;
  attempts: number;
  message: { content_type: string; content_text: string | null };
}

/** Server-authorized work protocol, not an inference runtime or independent send path. */
export class CopilotWorkService extends CopilotService {
  private async workKey(c: PoolClient, actor: KeyActor) {
    const operator = await this.key(c, actor);
    if (
      !(
        await c.query(
          `SELECT 1 FROM api_keys WHERE id=$1 AND scopes @> ARRAY['copilot:work','messages:read','conversations:read']::text[]`,
          [actor.keyId]
        )
      ).rows.length
    )
      throw forbidden(
        'Work, message-read and conversation-read scopes required'
      );
    return operator;
  }
  /** Repeated bounded anti-join pages have no timestamp watermark to skip late commits/backdated rows. */
  async reconcileInbound(actor: KeyActor) {
    return transaction(this.pool, async (c) => {
      await this.workKey(c, actor);
      const rows = (
        await c.query(
          `SELECT m.id,m.conversation_id FROM messages m JOIN conversations cv ON cv.id=m.conversation_id
        WHERE cv.account_id=$1 AND m.sender_type='customer' AND m.copilot_verified_inbound AND m.message_id LIKE 'wamid.%'
        AND NOT EXISTS(SELECT 1 FROM copilot_work w WHERE w.account_id=$1 AND w.provider_message_id=m.message_id)
        AND NOT EXISTS(SELECT 1 FROM copilot_work w WHERE w.source_id=m.id)
        ORDER BY m.created_at,m.id LIMIT 100`,
          [actor.accountId]
        )
      ).rows;
      let inserted = 0;
      for (const row of rows) {
        // Same conversation -> work lock order as ingress, claim, dispatch and takeover.
        const available = await c.query(
          'SELECT id FROM conversations WHERE id=$1 AND account_id=$2 FOR UPDATE SKIP LOCKED',
          [row.conversation_id, actor.accountId]
        );
        if (!available.rows.length) continue;
        inserted +=
          (
            await c.query(
              `INSERT INTO copilot_work(account_id,conversation_id,source_id,provider_message_id,ready,state)
          SELECT cv.account_id,cv.id,m.id,m.message_id,m.copilot_ingress_completed,CASE WHEN m.copilot_ingress_completed AND m.copilot_ingress_consumed THEN 'completed' WHEN cv.copilot_latest_inbound_id=m.id THEN 'pending' ELSE 'superseded' END
          FROM messages m JOIN conversations cv ON cv.id=m.conversation_id WHERE m.id=$1 AND cv.account_id=$2
          AND m.sender_type='customer' AND m.copilot_verified_inbound AND m.message_id LIKE 'wamid.%'
          ON CONFLICT DO NOTHING`,
              [row.id, actor.accountId]
            )
          ).rowCount ?? 0;
      }
      return {
        scanned: rows.length,
        inserted,
        more_possible: rows.length === 100,
      };
    });
  }
  async inspect(actor: KeyActor, workId: string) {
    return transaction(this.pool, async (c) => {
      await this.workKey(c, actor);
      const row = (
        await c.query(
          `SELECT id,conversation_id,source_id,provider_message_id,ready,state,attempts,reason,outcome,created_at,updated_at
        FROM copilot_work WHERE id=$1 AND account_id=$2`,
          [workId, actor.accountId]
        )
      ).rows[0];
      if (!row) throw missing();
      // Never disclose a replacement worker's lease capability to an old worker.
      const outbox =
        (
          await c.query(
            `SELECT id,state FROM copilot_outbox WHERE conversation_id=$1 AND inbound_id=$2 AND account_id=$3`,
            [row.conversation_id, row.source_id, actor.accountId]
          )
        ).rows[0] ?? null;
      return { ...row, outbox };
    });
  }
  private async end(c: PoolClient, workId: string, reason: string) {
    await c.query(
      `UPDATE copilot_work_attempts SET ended_at=clock_timestamp(),reason=$2 WHERE work_id=$1 AND ended_at IS NULL`,
      [workId, reason]
    );
  }
  private async existingOutcome(
    c: PoolClient,
    actor: KeyActor,
    job: { conversation_id: string; source_id: string }
  ) {
    return (
      await c.query(
        `SELECT id,state FROM copilot_outbox WHERE conversation_id=$1 AND inbound_id=$2 AND account_id=$3`,
        [job.conversation_id, job.source_id, actor.accountId]
      )
    ).rows[0];
  }
  async claimNext(
    actor: KeyActor,
    sessionId: string
  ): Promise<
    WorkLease | { id: string; state: string; outcome: unknown } | null
  > {
    return transaction(this.pool, async (c) => {
      await this.workKey(c, actor);
      const authority = await this.active(c, actor, sessionId);
      const candidate = (
        await c.query(
          `SELECT cv.id FROM conversations cv JOIN contacts ct ON ct.id=cv.contact_id AND ct.account_id=cv.account_id
        WHERE cv.account_id=$1 AND cv.status='open' AND NOT cv.ai_autoreply_disabled AND cv.assigned_agent_id IS NULL
        AND (cv.copilot_key_id IS NULL OR cv.copilot_work_id IS NOT NULL)
        AND EXISTS(SELECT 1 FROM copilot_work w WHERE w.account_id=$1 AND w.conversation_id=cv.id AND w.source_id=cv.copilot_latest_inbound_id
          AND w.ready AND (w.state='pending' OR (w.state='leased' AND (w.lease_until<=clock_timestamp() OR w.policy_revision<>$4 OR (w.operator_id=$2 AND w.session_id<>$3)))))
        ORDER BY cv.id LIMIT 1 FOR UPDATE OF cv SKIP LOCKED`,
          [
            actor.accountId,
            authority.operator,
            sessionId,
            authority.policyRevision,
          ]
        )
      ).rows[0];
      if (!candidate) return null;
      const gate = await this.guard(
        c,
        actor,
        { conversation_id: candidate.id, session_id: sessionId },
        undefined,
        undefined,
        undefined,
        true
      );
      const job = (
        await c.query(
          `SELECT * FROM copilot_work WHERE account_id=$1 AND conversation_id=$2 AND source_id=$3 FOR UPDATE`,
          [actor.accountId, candidate.id, gate.conv.copilot_latest_inbound_id]
        )
      ).rows[0];
      if (!job) throw missing();
      const message = (
        await c.query(
          `SELECT content_type,content_text FROM messages WHERE id=$1 AND conversation_id=$2 AND sender_type='customer'
        AND copilot_verified_inbound AND copilot_ingress_completed AND NOT copilot_ingress_consumed AND message_id=$3`,
          [job.source_id, job.conversation_id, job.provider_message_id]
        )
      ).rows[0];
      const old = await this.existingOutcome(c, actor, job);
      if (!message || old) {
        const state = !message
          ? 'invalidated'
          : old.state === 'sent'
            ? 'completed'
            : 'awaiting_human';
        const outcome = old ?? { reason: 'source_changed' };
        // No retry/replacement of an existing outbox entry, even if never submitted.
        await c.query(
          `UPDATE conversations SET copilot_key_id=NULL,copilot_session_id=NULL,copilot_revision=copilot_revision+1
          WHERE id=$1 AND account_id=$2 AND copilot_work_id=$3`,
          [job.conversation_id, actor.accountId, job.id]
        );
        await this.end(c, job.id, 'existing_outcome');
        await c.query(
          `UPDATE copilot_work SET state=$2,outcome=$3,reason='existing_outcome',updated_at=clock_timestamp() WHERE id=$1`,
          [job.id, state, JSON.stringify(outcome)]
        );
        await this.clock(c, actor, sessionId, gate.operator);
        return { id: job.id, state, outcome };
      }
      await c.query(
        'SELECT id FROM contacts WHERE id=$1 AND account_id=$2 FOR SHARE',
        [gate.conv.contact_id, actor.accountId]
      );
      const token = randomUUID();
      const revision = String(
        (
          await c.query(
            `UPDATE conversations SET copilot_key_id=$2,copilot_session_id=$3,copilot_revision=copilot_revision+1,
        copilot_work_id=$4,copilot_work_token=$5 WHERE id=$1 AND account_id=$6 RETURNING copilot_revision`,
            [
              job.conversation_id,
              actor.keyId,
              sessionId,
              job.id,
              token,
              actor.accountId,
            ]
          )
        ).rows[0].copilot_revision
      );
      await this.end(c, job.id, 'reclaimed');
      const leased = (
        await c.query(
          `UPDATE copilot_work w SET state='leased',lease_token=$2,key_id=$3,operator_id=$4,session_id=$5,ownership_revision=$6,
        policy_revision=$7,lease_until=least(s.expires_at,clock_timestamp()+interval '30 seconds'),attempts=w.attempts+1,reason=NULL,outcome=NULL,updated_at=clock_timestamp()
        FROM copilot_sessions s WHERE w.id=$1 AND s.account_id=w.account_id AND s.operator_id=$4 RETURNING w.*`,
          [
            job.id,
            token,
            actor.keyId,
            gate.operator,
            sessionId,
            revision,
            gate.policyRevision,
          ]
        )
      ).rows[0];
      await c.query(
        `INSERT INTO copilot_work_attempts(token,work_id,account_id,key_id,operator_id,session_id,ownership_revision,policy_revision,expires_at)
        VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
        [
          token,
          job.id,
          actor.accountId,
          actor.keyId,
          gate.operator,
          sessionId,
          revision,
          gate.policyRevision,
          leased.lease_until,
        ]
      );
      await this.clock(c, actor, sessionId, gate.operator);
      await this.workClock(c, actor, job.id, token);
      return { ...leased, ownership_revision: revision, message };
    });
  }
  private async owned(
    c: PoolClient,
    actor: KeyActor,
    workId: string,
    token: string
  ) {
    await this.workKey(c, actor);
    const initial = (
      await c.query(
        'SELECT * FROM copilot_work WHERE id=$1 AND account_id=$2 AND key_id=$3',
        [workId, actor.accountId, actor.keyId]
      )
    ).rows[0];
    if (!initial) throw missing();
    const gate = await this.guard(
      c,
      actor,
      {
        conversation_id: initial.conversation_id,
        session_id: initial.session_id,
      },
      String(initial.ownership_revision),
      initial.source_id,
      token
    );
    const row = (
      await c.query('SELECT * FROM copilot_work WHERE id=$1 FOR UPDATE', [
        workId,
      ])
    ).rows[0];
    if (row.state !== 'leased' || row.lease_token !== token)
      throw conflict('Work lease changed');
    return { row, gate };
  }
  async renew(actor: KeyActor, workId: string, token: string) {
    return transaction(this.pool, async (c) => {
      const { row, gate } = await this.owned(c, actor, workId, token);
      const result = (
        await c.query(
          `UPDATE copilot_work w SET lease_until=least(s.expires_at,clock_timestamp()+interval '30 seconds'),updated_at=clock_timestamp()
        FROM copilot_sessions s WHERE w.id=$1 AND s.account_id=w.account_id AND s.operator_id=$2 RETURNING w.lease_until`,
          [workId, gate.operator]
        )
      ).rows[0];
      await c.query(
        'UPDATE copilot_work_attempts SET expires_at=$2 WHERE token=$1 AND ended_at IS NULL',
        [token, result.lease_until]
      );
      await this.clock(c, actor, row.session_id, gate.operator);
      await this.workClock(c, actor, workId, token);
      return { id: workId, lease_until: result.lease_until };
    });
  }
  async release(
    actor: KeyActor,
    workId: string,
    token: string,
    settle = false
  ) {
    return transaction(this.pool, async (c) => {
      const { row, gate } = await this.owned(c, actor, workId, token);
      const outbox = await this.existingOutcome(c, actor, row);
      // Waiting for exact human approval is work, not a successful customer reply.
      if (settle && outbox && ['draft', 'approved'].includes(outbox.state))
        return {
          id: workId,
          state: 'leased',
          outbox,
          waiting_for: 'human_approval',
        };
      if (settle && !outbox)
        throw conflict(
          'No persisted reply outcome; release unfinished work instead'
        );
      const state = outbox
        ? outbox.state === 'sent'
          ? 'completed'
          : 'awaiting_human'
        : 'pending';
      await c.query(
        `UPDATE conversations SET copilot_key_id=NULL,copilot_session_id=NULL,copilot_revision=copilot_revision+1
        WHERE id=$1 AND account_id=$2`,
        [row.conversation_id, actor.accountId]
      );
      await c.query(
        `UPDATE copilot_work SET state=$2,reason=$3,outcome=$4,updated_at=clock_timestamp() WHERE id=$1`,
        [
          workId,
          state,
          outbox ? 'existing_outcome' : 'released',
          outbox ? JSON.stringify(outbox) : null,
        ]
      );
      await this.end(c, workId, outbox ? 'existing_outcome' : 'released');
      await this.clock(c, actor, row.session_id, gate.operator);
      await this.workClock(c, actor, workId, token);
      return { id: workId, state, outbox: outbox ?? null };
    });
  }
  /** Explicit human attestation closes queue work, never an outbox retry/reconciliation. */
  async resolveHuman(actor: HumanActor, workId: string, summary: string) {
    if (!summary.trim() || summary.length > 2000)
      throw badRequest('Resolution summary required');
    return transaction(this.pool, async (c) => {
      await this.human(c, actor);
      const initial = (
        await c.query(
          'SELECT conversation_id FROM copilot_work WHERE id=$1 AND account_id=$2',
          [workId, actor.accountId]
        )
      ).rows[0];
      if (!initial) throw missing();
      await c.query(
        'SELECT id FROM conversations WHERE id=$1 AND account_id=$2 FOR UPDATE',
        [initial.conversation_id, actor.accountId]
      );
      const row = (
        await c.query(
          'SELECT * FROM copilot_work WHERE id=$1 AND account_id=$2 FOR UPDATE',
          [workId, actor.accountId]
        )
      ).rows[0];
      if (
        row.state === 'completed' &&
        row.outcome?.type === 'human_resolution' &&
        row.outcome?.resolved_by === actor.userId &&
        row.outcome?.summary === summary
      )
        return { id: workId, state: row.state, outcome: row.outcome };
      if (
        row.state !== 'awaiting_human' &&
        !(row.state === 'pending' && !row.ready)
      )
        throw conflict(
          'Only human-review or incomplete-ingress work can be resolved; completed outcomes cannot be rewritten'
        );
      const outbox = await this.existingOutcome(
        c,
        { accountId: actor.accountId, keyId: row.key_id },
        row
      );
      await c.query(
        `UPDATE conversations SET copilot_key_id=NULL,copilot_session_id=NULL,copilot_revision=copilot_revision+1,
        ai_autoreply_disabled=true,assigned_agent_id=coalesce(assigned_agent_id,$3) WHERE id=$1 AND account_id=$2`,
        [row.conversation_id, actor.accountId, actor.userId]
      );
      const result = (
        await c.query(
          `UPDATE copilot_work SET state='completed',reason='human_resolution',updated_at=clock_timestamp(),
        outcome=jsonb_build_object('type','human_resolution','resolved_by',$2::text,'summary',$3::text,'resolved_at',clock_timestamp(),'outbox',$4::jsonb)
        WHERE id=$1 RETURNING id,state,outcome`,
          [workId, actor.userId, summary, JSON.stringify(outbox ?? null)]
        )
      ).rows[0];
      await this.end(c, workId, 'human_resolution');
      return result;
    });
  }
}
