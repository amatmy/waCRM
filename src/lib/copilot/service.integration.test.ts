// Real PostgreSQL, synthetic data and an injected fake provider. Never Meta.
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
import { CopilotService, type Outbox, type ReplyInput } from './service';
import { ProviderRejected } from './provider';

const url = process.env.COPILOT_TEST_DATABASE_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error(
    'Copilot integration tests require an isolated loopback database'
  );
describe.skipIf(!url)('copilot real-database authorization and races', () => {
  const pool = new Pool({
    connectionString: url,
    max: 8,
    connectionTimeoutMillis: 3000,
  });
  const provider = vi.fn(async () => `wamid.${randomUUID()}`);
  const service = new CopilotService(pool, provider);
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
  async function draft(): Promise<Outbox> {
    const claim = await service.claim(actor(), conversationId, sessionId);
    return service.prepare(actor(), {
      conversation_id: conversationId,
      session_id: sessionId,
      ownership_revision: claim.revision,
      inbound_id: inboundId,
      idempotency_key: randomUUID(),
      text: 'Synthetic approved reply',
    });
  }
  async function approved() {
    const row = await draft();
    await service.approve(human(), row.id);
    return row;
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
        "INSERT INTO api_keys(account_id,created_by,name,key_prefix,key_hash,scopes) VALUES($1,$2,'fixture','fixture',$3,ARRAY['copilot:act','conversations:read','messages:read']) RETURNING id",
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
        "INSERT INTO messages(conversation_id,sender_type,content_text,message_id) VALUES($1,'customer','Synthetic request',$2) RETURNING id",
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

  it('requires exact human approval, persists one message and suppresses duplicate dispatch', async () => {
    const row = await draft();
    expect((await service.dispatch(actor(), row.id)).state).toBe('draft');
    expect(provider).not.toHaveBeenCalled();
    await service.approve(human(), row.id);
    const result = await service.dispatch(actor(), row.id);
    expect(result.state).toBe('sent');
    expect(provider).toHaveBeenCalledTimes(1);
    expect((await service.dispatch(actor(), row.id)).state).toBe('sent');
    expect(provider).toHaveBeenCalledTimes(1);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1 AND ai_generated',
          [conversationId]
        )
      ).rows[0].n
    ).toBe(1);
  });
  it('returns the same immutable draft for retries and rejects changed payload/new keys for the same inbound', async () => {
    const row = await draft();
    const input: ReplyInput = {
      conversation_id: conversationId,
      session_id: sessionId,
      ownership_revision: String(row.ownership_revision),
      inbound_id: inboundId,
      idempotency_key: row.idempotency_key,
      text: row.reply_text,
    };
    expect((await service.prepare(actor(), input)).id).toBe(row.id);
    await expect(
      service.prepare(actor(), { ...input, text: 'Changed' })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.prepare(actor(), { ...input, idempotency_key: randomUUID() })
    ).rejects.toMatchObject({ status: 409 });
  });
  it('takeover before dispatch cancels pending work and rejects stale in-flight model results', async () => {
    const row = await approved();
    await service.takeover(human(), conversationId);
    await expect(service.dispatch(actor(), row.id)).rejects.toMatchObject({
      status: 409,
    });
    expect((await service.get(actor(), row.id)).state).toBe('cancelled');
    expect(provider).not.toHaveBeenCalled();
    const conv = (
      await pool.query('SELECT * FROM conversations WHERE id=$1', [
        conversationId,
      ])
    ).rows[0];
    expect(conv.copilot_key_id).toBeNull();
    expect(conv.assigned_agent_id).toBe(userId);
    await expect(
      service.claim(actor(), conversationId, sessionId)
    ).rejects.toMatchObject({ status: 409 });
  });
  it.each(['pause', 'expire', 'replace'])(
    '%s stops a previously approved reply without sending',
    async (action) => {
      const row = await approved();
      if (action === 'pause')
        await asHuman("SELECT transition_copilot_session('pause',$1)", [
          sessionId,
        ]);
      if (action === 'expire')
        await pool.query(
          "UPDATE copilot_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1",
          [accountId]
        );
      if (action === 'replace')
        await asHuman("SELECT transition_copilot_session('start')");
      await expect(service.dispatch(actor(), row.id)).rejects.toMatchObject({
        status: 409,
      });
      expect(provider).not.toHaveBeenCalled();
      expect((await service.get(actor(), row.id)).state).toBe('approved');
    }
  );
  it.each(['role', 'key', 'scope', 'binding'])(
    'revoked %s denies the dispatch',
    async (kind) => {
      const row = await approved();
      if (kind === 'role')
        await pool.query(
          "UPDATE profiles SET account_role='viewer' WHERE user_id=$1",
          [userId]
        );
      if (kind === 'key')
        await pool.query(
          'UPDATE api_keys SET revoked_at=clock_timestamp() WHERE id=$1',
          [keyId]
        );
      if (kind === 'scope')
        await pool.query("UPDATE api_keys SET scopes='{}' WHERE id=$1", [
          keyId,
        ]);
      if (kind === 'binding')
        await pool.query('DELETE FROM copilot_keys WHERE key_id=$1', [keyId]);
      await expect(service.dispatch(actor(), row.id)).rejects.toMatchObject({
        status: 403,
      });
      expect(provider).not.toHaveBeenCalled();
    }
  );
  it('denies cross-account actions and policy changes after approval', async () => {
    const row = await approved();
    await expect(
      service.get({ accountId: otherAccountId, keyId }, row.id)
    ).rejects.toMatchObject({ status: 403 });
    await expect(
      service.takeover({ accountId, userId: otherUserId }, conversationId)
    ).rejects.toMatchObject({ status: 403 });
    await service.setPolicy(human(), true);
    await expect(service.dispatch(actor(), row.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(provider).not.toHaveBeenCalled();
  });
  it('new inbound, edited context and closed window prevent stale replies', async () => {
    const row = await approved();
    await pool.query(
      "INSERT INTO messages(conversation_id,sender_type,content_text,message_id) VALUES($1,'customer','New context','wamid.new')",
      [conversationId]
    );
    await expect(service.dispatch(actor(), row.id)).rejects.toMatchObject({
      status: 409,
    });
    await pool.query(
      'UPDATE conversations SET copilot_latest_inbound_id=$2 WHERE id=$1',
      [conversationId, inboundId]
    );
    await pool.query(
      "UPDATE messages SET created_at=clock_timestamp()-interval '25 hours' WHERE id=$1",
      [inboundId]
    );
    expect((await service.get(actor(), row.id)).state).toBe('cancelled');
    expect(provider).not.toHaveBeenCalled();
  });
  it('rejects a 24-hour closed WhatsApp window at final dispatch', async () => {
    await pool.query(
      "UPDATE messages SET created_at=clock_timestamp()-interval '25 hours' WHERE id=$1",
      [inboundId]
    );
    await pool.query(
      'UPDATE conversations SET copilot_latest_inbound_id=$2 WHERE id=$1',
      [conversationId, inboundId]
    );
    const row = await approved();
    await expect(service.dispatch(actor(), row.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(provider).not.toHaveBeenCalled();
    expect((await service.get(actor(), row.id)).state).toBe('cancelled');
  });
  it('handoff preserves history and summary and fences future AI sends', async () => {
    const row = await approved();
    const result = await service.handoff(
      actor(),
      conversationId,
      String(row.ownership_revision),
      'Synthetic handoff summary'
    );
    expect(result.ai_handoff_summary).toBe('Synthetic handoff summary');
    expect(result.assigned_agent_id).toBe(userId);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int AS n FROM messages WHERE conversation_id=$1',
          [conversationId]
        )
      ).rows[0].n
    ).toBe(1);
    await expect(service.dispatch(actor(), row.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(provider).not.toHaveBeenCalled();
  });
  it('unknown provider outcomes and crashed dispatch latches are never retried; reconciliation requires a signed receipt', async () => {
    const row = await approved();
    provider.mockRejectedValue(new Error('ambiguous timeout after acceptance'));
    expect((await service.dispatch(actor(), row.id)).state).toBe('unknown');
    await service.dispatch(actor(), row.id);
    expect(provider).toHaveBeenCalledTimes(1);
    await expect(
      service.reconcile(human(), row.id, 'wamid.verified')
    ).rejects.toMatchObject({ status: 409 });
    await pool.query(
      "INSERT INTO pending_message_statuses(account_id,wamid,status) VALUES($1,'wamid.verified','delivered')",
      [accountId]
    );
    expect(
      (await service.reconcile(human(), row.id, 'wamid.verified')).state
    ).toBe('sent');
    await service.dispatch(actor(), row.id);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('a crash before provider submission retains the dispatch latch and cannot cause a duplicate', async () => {
    const row = await approved();
    await pool.query(
      "UPDATE copilot_outbox SET state='dispatching' WHERE id=$1",
      [row.id]
    );
    expect((await service.dispatch(actor(), row.id)).state).toBe('dispatching');
    expect(provider).not.toHaveBeenCalled();
  });
  it('definite provider rejection is terminal', async () => {
    const row = await approved();
    provider.mockRejectedValue(new ProviderRejected('synthetic rejection'));
    expect((await service.dispatch(actor(), row.id)).state).toBe('failed');
    await service.dispatch(actor(), row.id);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('concurrent dispatches submit exactly one provider request', async () => {
    const row = await approved();
    await Promise.all([
      service.dispatch(actor(), row.id),
      service.dispatch(actor(), row.id),
    ]);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('takeover racing a submitted attempt waits; after its success no new AI request can begin', async () => {
    const row = await approved();
    let enter!: () => void, finish!: (id: string) => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    provider.mockImplementation(() => {
      enter();
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const sending = service.dispatch(actor(), row.id);
    await entered;
    let tookOver = false;
    const taking = service.takeover(human(), conversationId).then((value) => {
      tookOver = true;
      return value;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(tookOver).toBe(false);
    finish('wamid.linearized');
    expect((await sending).state).toBe('sent');
    await taking;
    await expect(service.dispatch(actor(), row.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('native manual takeover and direct assignment revoke authority under human RLS', async () => {
    const row = await approved();
    expect(
      (
        await asHuman('SELECT copilot_manual_takeover($1) AS ok', [
          conversationId,
        ])
      ).rows[0].ok
    ).toBe(true);
    expect((await service.get(actor(), row.id)).state).toBe('cancelled');
    await expect(
      asHuman('UPDATE conversations SET copilot_key_id=$2 WHERE id=$1', [
        conversationId,
        keyId,
      ])
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asHuman("UPDATE copilot_outbox SET state='approved' WHERE id=$1", [
        row.id,
      ])
    ).rejects.toMatchObject({ code: '42501' });
    await expect(
      asHuman('SELECT * FROM copilot_outbox WHERE account_id=$1', [
        otherAccountId,
      ])
    ).resolves.toMatchObject({ rowCount: 0 });
  });
  it('native inbox assignment revokes the claim without a new UI or application helper', async () => {
    const row = await approved();
    await asHuman('UPDATE conversations SET assigned_agent_id=$2 WHERE id=$1', [
      conversationId,
      userId,
    ]);
    expect((await service.get(actor(), row.id)).state).toBe('cancelled');
    await expect(service.dispatch(actor(), row.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(provider).not.toHaveBeenCalled();
  });
  it('a duplicate webhook upsert does not move the inbound pointer to an uninserted UUID', async () => {
    const row = await approved();
    const wamid = (
      await pool.query('SELECT message_id FROM messages WHERE id=$1', [
        inboundId,
      ])
    ).rows[0].message_id;
    await pool.query(
      "INSERT INTO messages(conversation_id,sender_type,content_text,message_id) VALUES($1,'customer','Replay',$2) ON CONFLICT(message_id) DO NOTHING",
      [conversationId, wamid]
    );
    expect((await service.dispatch(actor(), row.id)).state).toBe('sent');
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('human-created customer records cannot forge WhatsApp inbound verification', async () => {
    const fake = (
      await asHuman(
        "INSERT INTO messages(conversation_id,sender_type,content_text,message_id,copilot_verified_inbound) VALUES($1,'customer','Forged','wamid.forged',true) RETURNING id,copilot_verified_inbound",
        [conversationId]
      )
    ).rows[0];
    expect(fake.copilot_verified_inbound).toBe(false);
    inboundId = fake.id;
    await expect(
      asHuman('UPDATE messages SET copilot_verified_inbound=true WHERE id=$1', [
        inboundId,
      ])
    ).rejects.toMatchObject({ code: '42501' });
    const row = await approved();
    await expect(service.dispatch(actor(), row.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(provider).not.toHaveBeenCalled();
  });
  it('session pause racing submission waits for the bounded attempt, then fences later dispatch', async () => {
    const row = await approved();
    let enter!: () => void, finish!: (id: string) => void;
    const entered = new Promise<void>((resolve) => {
      enter = resolve;
    });
    provider.mockImplementation(() => {
      enter();
      return new Promise<string>((resolve) => {
        finish = resolve;
      });
    });
    const sending = service.dispatch(actor(), row.id);
    await entered;
    let paused = false;
    const pausing = asHuman("SELECT transition_copilot_session('pause',$1)", [
      sessionId,
    ]).then(() => {
      paused = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(paused).toBe(false);
    finish('wamid.before-pause');
    await sending;
    await pausing;
    await expect(service.dispatch(actor(), row.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it('lease expiry while waiting for a conversation lock is rechecked before any submission', async () => {
    const row = await approved();
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM conversations WHERE id=$1 FOR UPDATE', [
      conversationId,
    ]);
    await pool.query(
      "UPDATE copilot_sessions SET expires_at=clock_timestamp()+interval '100 milliseconds' WHERE account_id=$1",
      [accountId]
    );
    const sending = service.dispatch(actor(), row.id);
    // Attach the rejection handler before releasing the lock, to avoid an unhandled rejection.
    const checked = expect(sending).rejects.toMatchObject({ status: 409 });
    await new Promise((resolve) => setTimeout(resolve, 150));
    await blocker.query('COMMIT');
    blocker.release();
    await checked;
    expect(provider).not.toHaveBeenCalled();
  });
});
