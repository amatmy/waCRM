// Canonical PostgreSQL, synthetic accounts/messages and injected fake provider only.
import { randomUUID } from 'node:crypto';
import { Pool } from 'pg';
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { CopilotWorkService, type WorkLease } from './work';
import { CopilotCrmService } from './crm';

const url = process.env.COPILOT_TEST_DATABASE_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error(
    'Copilot integration tests require an isolated loopback database'
  );
describe.skipIf(!url)('durable inbound work and recovery', () => {
  const applicationName = `copilot-test-${randomUUID()}`;
  const pool = new Pool({
    application_name: applicationName,
    connectionString: url,
    max: 8,
    connectionTimeoutMillis: 3000,
  });
  const provider = vi.fn(async () => `wamid.${randomUUID()}`);
  const service = new CopilotWorkService(pool, provider);
  let userId: string,
    otherUserId: string,
    accountId: string,
    otherAccountId: string,
    keyId: string,
    conversationId: string,
    inboundId: string,
    sessionId: string;
  const human = () => ({ accountId, userId });
  const actor = () => ({ accountId, keyId });
  async function asHuman(sql: string, values: unknown[] = []) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [
        userId,
      ]);
      await c.query('SET LOCAL ROLE authenticated');
      const result = await c.query(sql, values);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }
  beforeEach(async () => {
    provider.mockReset();
    provider.mockImplementation(async () => `wamid.${randomUUID()}`);
    userId = randomUUID();
    otherUserId = randomUUID();
    await pool.query('INSERT INTO auth.users(id,email) VALUES($1,$3),($2,$4)', [
      userId,
      otherUserId,
      `${userId}@example.invalid`,
      `${otherUserId}@example.invalid`,
    ]);
    accountId = (
      await pool.query('SELECT account_id FROM profiles WHERE user_id=$1', [
        userId,
      ])
    ).rows[0].account_id;
    otherAccountId = (
      await pool.query('SELECT account_id FROM profiles WHERE user_id=$1', [
        otherUserId,
      ])
    ).rows[0].account_id;
    keyId = (
      await pool.query(
        "INSERT INTO api_keys(account_id,created_by,name,key_prefix,key_hash,scopes) VALUES($1,$2,'fixture','fixture',$3,ARRAY['copilot:act','copilot:crm','copilot:work','conversations:read','messages:read']) RETURNING id",
        [accountId, userId, randomUUID()]
      )
    ).rows[0].id;
    const contactId = (
      await pool.query(
        "INSERT INTO contacts(user_id,account_id,phone,name) VALUES($1,$2,'+15551234567','Synthetic contact') RETURNING id",
        [userId, accountId]
      )
    ).rows[0].id;
    conversationId = (
      await pool.query(
        'INSERT INTO conversations(user_id,account_id,contact_id) VALUES($1,$2,$3) RETURNING id',
        [userId, accountId, contactId]
      )
    ).rows[0].id;
    inboundId = (
      await pool.query(
        "INSERT INTO messages(conversation_id,sender_type,content_text,message_id,copilot_ingress_completed) VALUES($1,'customer','Synthetic request',$2,true) RETURNING id",
        [conversationId, `wamid.inbound.${randomUUID()}`]
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO whatsapp_config(user_id,account_id,phone_number_id,access_token,status) VALUES($1,$2,'synthetic-phone-id','synthetic-token','connected')",
      [userId, accountId]
    );
    sessionId = (
      await asHuman(
        "SELECT session_id FROM transition_copilot_session('start')"
      )
    ).rows[0].session_id;
    await service.setPolicy(human(), true);
    await service.bindKey(human(), keyId);
  });
  afterEach(async () => {
    await pool.query('DELETE FROM accounts WHERE id=ANY($1::uuid[])', [
      [accountId, otherAccountId].filter(Boolean),
    ]);
    await pool.query('DELETE FROM auth.users WHERE id=ANY($1::uuid[])', [
      [userId, otherUserId].filter(Boolean),
    ]);
  });
  afterAll(() => pool.end());

  async function lease(serviceInstance = service, session = sessionId) {
    const result = await serviceInstance.claimNext(actor(), session);
    expect(result?.state).toBe('leased');
    return result as WorkLease;
  }
  function replyInput(row: WorkLease, text = 'Synthetic reply') {
    return {
      conversation_id: row.conversation_id,
      session_id: row.session_id,
      ownership_revision: row.ownership_revision,
      inbound_id: row.source_id,
      work_token: row.lease_token,
      idempotency_key: randomUUID(),
      text,
    };
  }
  async function expire(row: WorkLease) {
    await pool.query(
      "UPDATE copilot_work SET lease_until=clock_timestamp()-interval '1 second' WHERE id=$1",
      [row.id]
    );
  }
  async function shortLease(row: WorkLease) {
    await pool.query(
      "UPDATE copilot_work SET lease_until=clock_timestamp()+interval '150 milliseconds' WHERE id=$1",
      [row.id]
    );
  }
  async function insert(
    text = 'New synthetic inbound',
    wamid = `wamid.${randomUUID()}`,
    date = new Date()
  ) {
    return (
      await pool.query(
        "INSERT INTO messages(conversation_id,sender_type,content_text,message_id,created_at,copilot_ingress_completed) VALUES($1,'customer',$2,$3,$4,true) RETURNING id",
        [conversationId, text, wamid, date]
      )
    ).rows[0].id as string;
  }
  it('queued handoff atomically records human review and closes the worker attempt', async () => {
    const row = await lease();
    const input = {
      action: 'handoff' as const,
      conversation_id: conversationId,
      session_id: sessionId,
      inbound_id: inboundId,
      ownership_revision: row.ownership_revision,
      work_token: row.lease_token,
      idempotency_key: randomUUID(),
      payload: { summary: 'Synthetic request needs a human' },
    };
    const crm = new CopilotCrmService(pool, provider);
    const outcome = await crm.perform(actor(), input);
    const work = (
      await pool.query(
        'SELECT state,reason,outcome FROM copilot_work WHERE id=$1',
        [row.id]
      )
    ).rows[0];
    expect(work).toMatchObject({
      state: 'awaiting_human',
      reason: 'human_handoff',
      outcome: { type: 'human_handoff', action_id: outcome.id },
    });
    expect(
      (
        await pool.query(
          'SELECT ended_at,reason FROM copilot_work_attempts WHERE work_id=$1',
          [row.id]
        )
      ).rows[0]
    ).toMatchObject({ reason: 'human_handoff', ended_at: expect.any(Date) });
    expect((await crm.perform(actor(), input)).id).toBe(outcome.id);
    expect(provider).not.toHaveBeenCalled();
  });
  it('atomically journals trusted persisted inbound while paused; explicit restart claims the same work', async () => {
    await asHuman("SELECT transition_copilot_session('pause',$1)", [sessionId]);
    const id = await insert();
    const row = (
      await pool.query('SELECT * FROM copilot_work WHERE source_id=$1', [id])
    ).rows[0];
    expect(row.state).toBe('pending');
    await expect(service.claimNext(actor(), sessionId)).rejects.toMatchObject({
      status: 409,
    });
    sessionId = (
      await asHuman(
        "SELECT session_id FROM transition_copilot_session('start')"
      )
    ).rows[0].session_id;
    expect((await lease()).id).toBe(row.id);
    expect(provider).not.toHaveBeenCalled();
  });
  it('rolls back queue insertion with failed message storage; duplicate webhook upsert creates no second job', async () => {
    const c = await pool.connect();
    let id: string;
    try {
      await c.query('BEGIN');
      id = (
        await c.query(
          "INSERT INTO messages(conversation_id,sender_type,content_text,message_id) VALUES($1,'customer','Rolled back',$2) RETURNING id",
          [conversationId, `wamid.${randomUUID()}`]
        )
      ).rows[0].id;
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    expect(
      (
        await pool.query('SELECT id FROM copilot_work WHERE source_id=$1', [
          id!,
        ])
      ).rows
    ).toHaveLength(0);
    const wm = (
      await pool.query('SELECT message_id FROM messages WHERE id=$1', [
        inboundId,
      ])
    ).rows[0].message_id;
    await pool.query(
      "INSERT INTO messages(conversation_id,sender_type,content_text,message_id) VALUES($1,'customer','Duplicate',$2) ON CONFLICT(conversation_id,message_id) DO NOTHING",
      [conversationId, wm]
    );
    expect(
      (
        await pool.query('SELECT id FROM copilot_work WHERE account_id=$1', [
          accountId,
        ])
      ).rows
    ).toHaveLength(1);
    expect((await lease()).source_id).toBe(inboundId);
  });
  it('provider IDs deduplicate within an account, independently across accounts', async () => {
    const wm = (
      await pool.query('SELECT message_id FROM messages WHERE id=$1', [
        inboundId,
      ])
    ).rows[0].message_id;
    const ct = (
      await pool.query(
        "INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,'+15557654321','Other') RETURNING id",
        [otherAccountId, otherUserId]
      )
    ).rows[0].id;
    const cv = (
      await pool.query(
        'INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id',
        [otherAccountId, otherUserId, ct]
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO messages(conversation_id,sender_type,content_text,message_id) VALUES($1,'customer','Same provider ID different tenant',$2)",
      [cv, wm]
    );
    expect(
      (
        await pool.query(
          'SELECT id FROM copilot_work WHERE provider_message_id=$1',
          [wm]
        )
      ).rows
    ).toHaveLength(2);
  });
  it('human-created customer rows do not become trusted work', async () => {
    const result = await asHuman(
      "INSERT INTO messages(conversation_id,sender_type,content_text,message_id) VALUES($1,'customer','Forged inbound',$2) RETURNING id",
      [conversationId, `wamid.${randomUUID()}`]
    );
    expect(
      (
        await pool.query('SELECT id FROM copilot_work WHERE source_id=$1', [
          result.rows[0].id,
        ])
      ).rows
    ).toHaveLength(0);
  });
  it('REST reconciliation fills missed/backdated canonical rows in bounded idempotent pages, even paused', async () => {
    await asHuman("SELECT transition_copilot_session('pause',$1)", [sessionId]);
    await pool.query(
      "INSERT INTO messages(conversation_id,sender_type,content_text,message_id,created_at,copilot_ingress_completed) SELECT $1,'customer','Backdated fixture','wamid.'||gen_random_uuid()::text,clock_timestamp()-interval '2 days',true FROM generate_series(1,120)",
      [conversationId]
    );
    await pool.query('DELETE FROM copilot_work WHERE account_id=$1', [
      accountId,
    ]); // Simulate missing old trigger / notification backlog.
    expect((await service.reconcileInbound(actor())).inserted).toBe(100);
    expect((await service.reconcileInbound(actor())).inserted).toBe(21);
    expect((await service.reconcileInbound(actor())).inserted).toBe(0);
    await insert(
      'Late backdated commit',
      `wamid.${randomUUID()}`,
      new Date(Date.now() - 864000000)
    );
    await pool.query(
      "DELETE FROM copilot_work WHERE account_id=$1 AND state='pending'",
      [accountId]
    );
    expect((await service.reconcileInbound(actor())).inserted).toBe(1);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM copilot_work WHERE account_id=$1',
          [accountId]
        )
      ).rows[0].n
    ).toBe(122);
  });
  it('two simultaneous worker processes cannot acquire the same work', async () => {
    const other = new CopilotWorkService(pool, provider);
    const rows = await Promise.all([
      service.claimNext(actor(), sessionId),
      other.claimNext(actor(), sessionId),
    ]);
    expect(rows.filter(Boolean)).toHaveLength(1);
    expect(
      (
        await pool.query(
          'SELECT * FROM copilot_work_attempts WHERE account_id=$1',
          [accountId]
        )
      ).rows
    ).toHaveLength(1);
  });
  it('restart after expired lease rotates capability/revision and preserves attempt history', async () => {
    const old = await lease();
    await expire(old);
    const fresh = await lease(new CopilotWorkService(pool, provider));
    expect(fresh.id).toBe(old.id);
    expect(fresh.lease_token).not.toBe(old.lease_token);
    expect(BigInt(fresh.ownership_revision)).toBeGreaterThan(
      BigInt(old.ownership_revision)
    );
    expect(fresh.attempts).toBe(2);
    await expect(
      service.prepare(actor(), replyInput(old))
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.renew(actor(), old.id, old.lease_token)
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.release(actor(), old.id, old.lease_token)
    ).rejects.toMatchObject({ status: 409 });
    const inspect = await service.inspect(actor(), fresh.id);
    expect(inspect).not.toHaveProperty('lease_token');
    expect(
      (
        await pool.query(
          'SELECT * FROM copilot_work_attempts WHERE work_id=$1',
          [old.id]
        )
      ).rows
    ).toHaveLength(2);
    expect((await service.prepare(actor(), replyInput(fresh))).state).toBe(
      'draft'
    );
  });
  it('a delayed worker cannot bypass lease expiry by using generic claim, prepare or CRM endpoints', async () => {
    const row = await lease();
    await expire(row);
    await expect(
      service.claim(actor(), conversationId, sessionId)
    ).rejects.toMatchObject({ status: 409 });
    const input = replyInput(row);
    delete (input as { work_token?: string }).work_token;
    await expect(service.prepare(actor(), input)).rejects.toMatchObject({
      status: 409,
    });
    await expect(
      new CopilotCrmService(pool).perform(actor(), {
        action: 'note',
        conversation_id: conversationId,
        session_id: sessionId,
        inbound_id: inboundId,
        ownership_revision: row.ownership_revision,
        work_token: row.lease_token,
        idempotency_key: randomUUID(),
        payload: { note: 'Late result' },
      })
    ).rejects.toMatchObject({ status: 409 });
  });
  it('renewal is capped by human lease, and expiry never resurrects through renewal', async () => {
    const row = await lease();
    await pool.query(
      "UPDATE copilot_sessions SET expires_at=clock_timestamp()+interval '5 seconds' WHERE account_id=$1",
      [accountId]
    );
    const renewed = await service.renew(actor(), row.id, row.lease_token);
    const humanExpiry = (
      await pool.query(
        'SELECT expires_at FROM copilot_sessions WHERE account_id=$1',
        [accountId]
      )
    ).rows[0].expires_at;
    expect(new Date(renewed.lease_until).getTime()).toBeLessThanOrEqual(
      humanExpiry.getTime()
    );
    await expire(row);
    await expect(
      service.renew(actor(), row.id, row.lease_token)
    ).rejects.toMatchObject({ status: 409 });
  });
  it('pause preserves work and a replaced human generation invalidates even an unexpired old worker', async () => {
    const old = await lease();
    await asHuman("SELECT transition_copilot_session('pause',$1)", [sessionId]);
    await expect(
      service.prepare(actor(), replyInput(old))
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.inspect(actor(), old.id)).state).toBe('leased');
    sessionId = (
      await asHuman(
        "SELECT session_id FROM transition_copilot_session('start')"
      )
    ).rows[0].session_id;
    const fresh = await lease();
    expect(fresh.id).toBe(old.id);
    expect(fresh.session_id).not.toBe(old.session_id);
    await expect(
      service.prepare(actor(), replyInput(old))
    ).rejects.toMatchObject({ status: 409 });
  });
  it.each(['revoked', 'scope', 'viewer', 'expired_key', 'policy'])(
    '%s revocation blocks work and delayed processing',
    async (kind) => {
      const row = await lease();
      if (kind === 'revoked')
        await pool.query(
          'UPDATE api_keys SET revoked_at=clock_timestamp() WHERE id=$1',
          [keyId]
        );
      if (kind === 'scope')
        await pool.query(
          "UPDATE api_keys SET scopes=ARRAY['copilot:act','messages:read','conversations:read'] WHERE id=$1",
          [keyId]
        );
      if (kind === 'viewer')
        await pool.query(
          "UPDATE profiles SET account_role='viewer' WHERE user_id=$1",
          [userId]
        );
      if (kind === 'expired_key')
        await pool.query(
          "UPDATE api_keys SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
          [keyId]
        );
      if (kind === 'policy') await service.setPolicy(human(), false);
      await expect(
        service.renew(actor(), row.id, row.lease_token)
      ).rejects.toBeDefined();
      await expect(
        service.prepare(actor(), replyInput(row))
      ).rejects.toBeDefined();
      expect(provider).not.toHaveBeenCalled();
    }
  );
  it('takeover blocks old work without destroying pending history; explicit human release permits a new generation', async () => {
    const old = await lease();
    await service.takeover(human(), conversationId);
    expect(await service.claimNext(actor(), sessionId)).toBeNull();
    await expect(
      service.prepare(actor(), replyInput(old))
    ).rejects.toMatchObject({ status: 409 });
    expect((await service.inspect(actor(), old.id)).source_id).toBe(inboundId);
    await service.takeover(human(), conversationId, true);
    const fresh = await lease();
    expect(fresh.id).toBe(old.id);
  });
  it('new inbound supersedes old pending/leased work and rejects delayed results', async () => {
    const old = await lease();
    const id = await insert();
    expect((await service.inspect(actor(), old.id)).state).toBe('superseded');
    await expect(
      service.prepare(actor(), replyInput(old))
    ).rejects.toMatchObject({ status: 409 });
    expect((await lease()).source_id).toBe(id);
  });
  it('stale immutable drafts require human handling rather than a second entry or automatic retry', async () => {
    const old = await lease();
    const draft = await service.prepare(actor(), replyInput(old));
    await expire(old);
    const recovered = await service.claimNext(actor(), sessionId);
    expect(recovered?.state).toBe('awaiting_human');
    expect((await service.get(actor(), draft.id)).state).toBe('cancelled');
    expect(await service.claimNext(actor(), sessionId)).toBeNull();
    expect(
      (
        await pool.query(
          'SELECT * FROM copilot_outbox WHERE conversation_id=$1',
          [conversationId]
        )
      ).rows
    ).toHaveLength(1);
    expect(provider).not.toHaveBeenCalled();
  });
  it('release with no outbox preserves pending work; settle cannot invent customer-reply success', async () => {
    const row = await lease();
    await expect(
      service.release(actor(), row.id, row.lease_token, true)
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (await service.release(actor(), row.id, row.lease_token)).state
    ).toBe('pending');
    expect((await lease()).id).toBe(row.id);
  });
  it('human approval and actual persisted provider outcome determine completion', async () => {
    const row = await lease();
    const draft = await service.prepare(actor(), replyInput(row));
    expect(
      (await service.release(actor(), row.id, row.lease_token, true)).state
    ).toBe('leased');
    await service.approve(human(), draft.id);
    expect((await service.dispatch(actor(), draft.id)).state).toBe('sent');
    expect(
      (await service.release(actor(), row.id, row.lease_token, true)).state
    ).toBe('completed');
    expect((await service.inspect(actor(), row.id)).outbox.state).toBe('sent');
    expect(await service.claimNext(actor(), sessionId)).toBeNull();
    await expect(service.dispatch(actor(), draft.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('an ambiguous provider attempt is quarantined across recovery, never resent', async () => {
    const row = await lease();
    const draft = await service.prepare(actor(), replyInput(row));
    await service.approve(human(), draft.id);
    provider.mockRejectedValue(new Error('synthetic lost response'));
    expect((await service.dispatch(actor(), draft.id)).state).toBe('unknown');
    expect(
      (await service.release(actor(), row.id, row.lease_token, true)).state
    ).toBe('awaiting_human');
    expect(await service.claimNext(actor(), sessionId)).toBeNull();
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await service.get(actor(), draft.id)).state).toBe('unknown');
  });
  it('accepted provider work finishing after lease expiry is recovered from the outbox, not resubmitted', async () => {
    const row = await lease();
    const draft = await service.prepare(actor(), replyInput(row));
    await service.approve(human(), draft.id);
    await pool.query(
      "UPDATE copilot_work SET lease_until=clock_timestamp()+interval '1 second' WHERE id=$1",
      [row.id]
    );
    provider.mockImplementation(async () => {
      await new Promise((resolve) => setTimeout(resolve, 1200));
      return 'wamid.synthetic-delayed';
    });
    expect((await service.dispatch(actor(), draft.id)).state).toBe('sent');
    expect((await service.claimNext(actor(), sessionId))?.state).toBe(
      'completed'
    );
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('source deletion invalidates retained work IDs and prevents stale processing', async () => {
    const row = await lease();
    await pool.query('DELETE FROM messages WHERE id=$1', [inboundId]);
    expect((await service.inspect(actor(), row.id)).state).toBe('invalidated');
    await expect(
      service.prepare(actor(), replyInput(row))
    ).rejects.toMatchObject({ status: 409 });
    expect(await service.claimNext(actor(), sessionId)).toBeNull();
  });
  it('tenant identity is enforced for work reads, renewal and canonical reconciliation', async () => {
    const row = await lease();
    await expect(
      service.inspect({ accountId: otherAccountId, keyId }, row.id)
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.renew(actor(), randomUUID(), row.lease_token)
    ).rejects.toMatchObject({ status: 404 });
    await service.reconcileInbound(actor());
    expect(
      (
        await pool.query('SELECT * FROM copilot_work WHERE account_id=$1', [
          otherAccountId,
        ])
      ).rows
    ).toHaveLength(0);
  });
  it('direct human/service writes cannot forge leases or conversation work capabilities', async () => {
    const row = await lease();
    await expect(
      asHuman(
        'UPDATE copilot_work SET lease_until=clock_timestamp() WHERE id=$1',
        [row.id]
      )
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asHuman('UPDATE conversations SET copilot_work_token=$2 WHERE id=$1', [
        conversationId,
        randomUUID(),
      ])
    ).rejects.toMatchObject({ code: '42501' });
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE service_role');
      await expect(
        c.query('DELETE FROM copilot_work WHERE id=$1', [row.id])
      ).rejects.toMatchObject({ code: '42501' });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect(
      (
        await asHuman('SELECT id FROM copilot_work WHERE account_id=$1', [
          accountId,
        ])
      ).rows
    ).toHaveLength(1);
    expect(
      (
        await asHuman('SELECT id FROM copilot_work WHERE account_id=$1', [
          otherAccountId,
        ])
      ).rows
    ).toHaveLength(0);
  });
  it('worker expiry while waiting on contact eligibility prevents provider submission', async () => {
    const row = await lease();
    const draft = await service.prepare(actor(), replyInput(row));
    await service.approve(human(), draft.id);
    await shortLease(row);
    const c = await pool.connect();
    await c.query('BEGIN');
    await c.query(
      'SELECT ct.id FROM contacts ct JOIN conversations cv ON cv.contact_id=ct.id WHERE cv.id=$1 FOR UPDATE OF ct',
      [conversationId]
    );
    const checked = expect(
      service.dispatch(actor(), draft.id)
    ).rejects.toMatchObject({ status: 409 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await c.query('COMMIT');
    c.release();
    await checked;
    expect(provider).not.toHaveBeenCalled();
  });
  it('worker expiry during reply insert rolls back the late draft', async () => {
    const row = await lease();
    await shortLease(row);
    const c = await pool.connect();
    await c.query('BEGIN');
    await c.query('LOCK TABLE copilot_outbox IN SHARE MODE');
    const checked = expect(
      service.prepare(actor(), replyInput(row))
    ).rejects.toMatchObject({ status: 409 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await c.query('COMMIT');
    c.release();
    await checked;
    expect(
      (
        await pool.query(
          'SELECT * FROM copilot_outbox WHERE conversation_id=$1',
          [conversationId]
        )
      ).rows
    ).toHaveLength(0);
  });
  it('worker expiry during CRM audit insert rolls back the note and result', async () => {
    const row = await lease();
    await shortLease(row);
    const c = await pool.connect();
    await c.query('BEGIN');
    await c.query('LOCK TABLE copilot_actions IN SHARE MODE');
    const checked = expect(
      new CopilotCrmService(pool).perform(actor(), {
        action: 'note',
        conversation_id: conversationId,
        session_id: sessionId,
        inbound_id: inboundId,
        ownership_revision: row.ownership_revision,
        work_token: row.lease_token,
        idempotency_key: randomUUID(),
        payload: { note: 'Late audit' },
      })
    ).rejects.toMatchObject({ status: 409 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await c.query('COMMIT');
    c.release();
    await checked;
    expect(
      (
        await pool.query('SELECT * FROM contact_notes WHERE account_id=$1', [
          accountId,
        ])
      ).rows
    ).toHaveLength(0);
  });
  it('separate conversations can be claimed concurrently without duplicate ownership', async () => {
    const ct = (
      await pool.query(
        "INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,'+15553456789','Second fixture') RETURNING id",
        [accountId, userId]
      )
    ).rows[0].id;
    const cv = (
      await pool.query(
        'INSERT INTO conversations(account_id,user_id,contact_id) VALUES($1,$2,$3) RETURNING id',
        [accountId, userId, ct]
      )
    ).rows[0].id;
    await pool.query(
      "INSERT INTO messages(conversation_id,sender_type,content_text,message_id,copilot_ingress_completed) VALUES($1,'customer','Second work',$2,true)",
      [cv, `wamid.${randomUUID()}`]
    );
    const rows = await Promise.all([
      service.claimNext(actor(), sessionId),
      new CopilotWorkService(pool, provider).claimNext(actor(), sessionId),
    ]);
    expect(rows.every((x) => x?.state === 'leased')).toBe(true);
    expect(new Set(rows.map((x) => x!.id)).size).toBe(2);
  });
  it('current policy revision fences old work immediately and permits fresh processing without an outbox', async () => {
    const old = await lease();
    await service.setPolicy(human(), true);
    await expect(
      service.prepare(actor(), replyInput(old))
    ).rejects.toMatchObject({ status: 409 });
    const fresh = await lease();
    expect(fresh.id).toBe(old.id);
    expect(fresh.lease_token).not.toBe(old.lease_token);
    expect((await service.prepare(actor(), replyInput(fresh))).state).toBe(
      'draft'
    );
  });
  it('human expiry while claiming rolls back queue generation and attempt creation', async () => {
    await pool.query(
      "UPDATE copilot_sessions SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE account_id=$1",
      [accountId]
    );
    const c = await pool.connect();
    await c.query('BEGIN');
    await c.query('LOCK TABLE copilot_work_attempts IN SHARE MODE');
    const checked = expect(
      service.claimNext(actor(), sessionId)
    ).rejects.toMatchObject({ status: 409 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await c.query('COMMIT');
    c.release();
    await checked;
    const row = (
      await pool.query('SELECT * FROM copilot_work WHERE source_id=$1', [
        inboundId,
      ])
    ).rows[0];
    expect(row.state).toBe('pending');
    expect(row.attempts).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT copilot_work_id FROM conversations WHERE id=$1',
          [conversationId]
        )
      ).rows[0].copilot_work_id
    ).toBeNull();
  });
  it('a valid foreign operator/key/session still cannot inspect or renew another account work', async () => {
    const row = await lease();
    const humanB = { accountId: otherAccountId, userId: otherUserId };
    const keyB = (
      await pool.query(
        "INSERT INTO api_keys(account_id,created_by,name,key_prefix,key_hash,scopes) VALUES($1,$2,'B','B',$3,ARRAY['copilot:act','copilot:work','messages:read','conversations:read']) RETURNING id",
        [otherAccountId, otherUserId, randomUUID()]
      )
    ).rows[0].id;
    await service.bindKey(humanB, keyB);
    await service.setPolicy(humanB, true);
    const c = await pool.connect();
    let sessionB: string;
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [
        otherUserId,
      ]);
      await c.query('SET LOCAL ROLE authenticated');
      sessionB = (
        await c.query(
          "SELECT session_id FROM transition_copilot_session('start')"
        )
      ).rows[0].session_id;
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const actorB = { accountId: otherAccountId, keyId: keyB };
    await expect(service.inspect(actorB, row.id)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.renew(actorB, row.id, row.lease_token)
    ).rejects.toMatchObject({ status: 404 });
    expect(await service.claimNext(actorB, sessionB!)).toBeNull();
    expect((await service.reconcileInbound(actorB)).inserted).toBe(0);
  });
  it('human-only resolution closes stale work without replacing drafts or manufacturing delivery', async () => {
    const row = await lease();
    const draft = await service.prepare(actor(), replyInput(row));
    await expire(row);
    await service.claimNext(actor(), sessionId);
    await expect(
      service.resolveHuman(
        { accountId: otherAccountId, userId: otherUserId },
        row.id,
        'Other tenant'
      )
    ).rejects.toMatchObject({ status: 404 });
    const resolved = await service.resolveHuman(
      human(),
      row.id,
      'Handled by the operator; no automated retry'
    );
    expect(resolved.state).toBe('completed');
    expect(resolved.outcome.type).toBe('human_resolution');
    expect(resolved.outcome.resolved_by).toBe(userId);
    expect((await service.get(actor(), draft.id)).state).toBe('cancelled');
    expect(provider).not.toHaveBeenCalled();
    expect(
      (
        await service.resolveHuman(
          human(),
          row.id,
          'Handled by the operator; no automated retry'
        )
      ).outcome
    ).toEqual(resolved.outcome);
    await expect(
      service.resolveHuman(human(), row.id, 'Rewrite history')
    ).rejects.toMatchObject({ status: 409 });
    expect(await service.claimNext(actor(), sessionId)).toBeNull();
  });
  it('human resolution never resolves or resends an indeterminate provider attempt', async () => {
    const row = await lease();
    const draft = await service.prepare(actor(), replyInput(row));
    await service.approve(human(), draft.id);
    provider.mockRejectedValue(new Error('synthetic unknown'));
    await service.dispatch(actor(), draft.id);
    await expire(row);
    await service.claimNext(actor(), sessionId);
    await service.resolveHuman(
      human(),
      row.id,
      'Operator acknowledged the ambiguous attempt; provider reconciliation remains separate'
    );
    expect((await service.get(actor(), draft.id)).state).toBe('unknown');
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('changed source tombstones do not starve REST reconciliation or create new work', async () => {
    await pool.query('UPDATE messages SET message_id=$2 WHERE id=$1', [
      inboundId,
      `wamid.changed.${randomUUID()}`,
    ]);
    expect((await service.reconcileInbound(actor())).scanned).toBe(0);
    expect(
      (
        await pool.query('SELECT state FROM copilot_work WHERE source_id=$1', [
          inboundId,
        ])
      ).rows[0].state
    ).toBe('invalidated');
    const id = await insert();
    await pool.query('DELETE FROM copilot_work WHERE source_id=$1', [id]);
    expect((await service.reconcileInbound(actor())).inserted).toBe(1);
    expect((await service.reconcileInbound(actor())).scanned).toBe(0);
  });
  async function finalize(id: string, consumed = false) {
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SET LOCAL ROLE service_role');
      const result = await c.query('SELECT copilot_finalize_ingress($1,$2)', [
        id,
        consumed,
      ]);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      throw error;
    } finally {
      c.release();
    }
  }
  it('pending ingress cannot race native flows, including through ordinary claim APIs', async () => {
    inboundId = (
      await pool.query(
        "INSERT INTO messages(conversation_id,sender_type,content_text,message_id) VALUES($1,'customer','Pending pipeline',$2) RETURNING id",
        [conversationId, `wamid.${randomUUID()}`]
      )
    ).rows[0].id;
    expect(await service.claimNext(actor(), sessionId)).toBeNull();
    await expect(
      service.claim(actor(), conversationId, sessionId)
    ).rejects.toMatchObject({ status: 409 });
    await finalize(inboundId);
    expect((await lease()).source_id).toBe(inboundId);
  });
  it('consumed native flow/interactive work is terminal without claiming a customer delivery', async () => {
    const id = (
      await pool.query(
        "INSERT INTO messages(conversation_id,sender_type,content_text,message_id) VALUES($1,'customer','Native flow',$2) RETURNING id",
        [conversationId, `wamid.${randomUUID()}`]
      )
    ).rows[0].id;
    await finalize(id, true);
    const row = (
      await pool.query('SELECT * FROM copilot_work WHERE source_id=$1', [id])
    ).rows[0];
    expect(row.state).toBe('completed');
    expect(row.outcome.type).toBe('native_consumed');
    await expect(
      service.claim(actor(), conversationId, sessionId)
    ).rejects.toMatchObject({ status: 409 });
    expect(await service.claimNext(actor(), sessionId)).toBeNull();
    expect(provider).not.toHaveBeenCalled();
    await pool.query('DELETE FROM copilot_work WHERE source_id=$1', [id]);
    expect((await service.reconcileInbound(actor())).inserted).toBe(1);
    expect(
      (
        await pool.query(
          'SELECT outcome FROM copilot_work WHERE source_id=$1',
          [id]
        )
      ).rows[0].outcome.type
    ).toBe('native_consumed');
  });
  it('REST repair preserves incomplete-ingress work and requires explicit human resolution', async () => {
    const id = (
      await pool.query(
        "INSERT INTO messages(conversation_id,sender_type,content_text,message_id) VALUES($1,'customer','Interrupted pipeline',$2) RETURNING id",
        [conversationId, `wamid.${randomUUID()}`]
      )
    ).rows[0].id;
    await pool.query('DELETE FROM copilot_work WHERE source_id=$1', [id]);
    expect((await service.reconcileInbound(actor())).inserted).toBe(1);
    expect(await service.claimNext(actor(), sessionId)).toBeNull();
    const row = (
      await pool.query('SELECT id FROM copilot_work WHERE source_id=$1', [id])
    ).rows[0];
    expect(
      (
        await service.resolveHuman(
          human(),
          row.id,
          'Operator reviewed interrupted native processing'
        )
      ).outcome.type
    ).toBe('human_resolution');
    await finalize(id);
    expect((await service.inspect(actor(), row.id)).state).toBe('completed'); // Late finalization cannot rewrite human history.
  });
  it('native human and noncopilot bot responses prevent an extra queued AI answer after human release', async () => {
    const old = await lease();
    await pool.query(
      "INSERT INTO messages(conversation_id,sender_type,content_text,message_id) VALUES($1,'agent','Human handled it',$2)",
      [conversationId, `wamid.${randomUUID()}`]
    );
    expect((await service.inspect(actor(), old.id)).state).toBe(
      'awaiting_human'
    );
    await service.takeover(human(), conversationId, true);
    expect(await service.claimNext(actor(), sessionId)).toBeNull();
    await expect(
      service.claim(actor(), conversationId, sessionId)
    ).rejects.toMatchObject({ status: 409 });
    inboundId = await insert('Next request');
    await pool.query(
      "INSERT INTO messages(conversation_id,sender_type,content_text,message_id) VALUES($1,'bot','Native automation response',$2)",
      [conversationId, `wamid.${randomUUID()}`]
    );
    expect(await service.claimNext(actor(), sessionId)).toBeNull();
    await expect(
      service.claim(actor(), conversationId, sessionId)
    ).rejects.toMatchObject({ status: 409 });
    expect(
      (
        await pool.query('SELECT state FROM copilot_work WHERE source_id=$1', [
          inboundId,
        ])
      ).rows[0].state
    ).toBe('awaiting_human');
  });
  it('only the trusted ingestion backend can finalize; human flags and completion cannot be forged', async () => {
    await expect(
      asHuman('SELECT copilot_finalize_ingress($1,false)', [inboundId])
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asHuman(
        'UPDATE messages SET copilot_ingress_completed=false WHERE id=$1',
        [inboundId]
      )
    ).rejects.toMatchObject({ code: '42501' });
  });
});
