// Isolated loopback PostgreSQL and an injected fake provider only.
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
import { CopilotCrmService, type CrmInput } from './crm';
import type { Outbox } from './service';

const url = process.env.COPILOT_TEST_DATABASE_URL;
if (url && !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname))
  throw new Error(
    'Copilot integration tests require an isolated loopback database'
  );
describe.skipIf(!url)('controlled CRM and hybrid policy', () => {
  const applicationName = `copilot-test-${randomUUID()}`;
  const pool = new Pool({
    application_name: applicationName,
    connectionString: url,
    max: 8,
    connectionTimeoutMillis: 3000,
  });
  const provider = vi.fn(async () => `wamid.${randomUUID()}`);
  const service = new CopilotCrmService(pool, provider);
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
        "INSERT INTO api_keys(account_id,created_by,name,key_prefix,key_hash,scopes) VALUES($1,$2,'fixture','fixture',$3,ARRAY['copilot:act','copilot:crm','conversations:read','messages:read']) RETURNING id",
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

  async function action(
    kind: CrmInput['action'],
    payload: Record<string, string>,
    idempotency_key = randomUUID()
  ): Promise<CrmInput> {
    const claim = await service.claim(actor(), conversationId, sessionId);
    return {
      action: kind,
      conversation_id: conversationId,
      session_id: sessionId,
      inbound_id: inboundId,
      ownership_revision: claim.revision,
      idempotency_key,
      payload,
    };
  }
  async function knowledge(
    question = 'Synthetic request',
    answer = 'Verified hours: 09:00 to 17:00'
  ) {
    return service.verifyBusinessAnswer(human(), {
      question,
      answer,
      source_reference: 'fixture handbook section 1',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
  }
  async function hybridDraft(text = 'Verified hours: 09:00 to 17:00') {
    await knowledge();
    await service.setPolicy(human(), true, 'hybrid');
    const claim = await service.claim(actor(), conversationId, sessionId);
    return service.prepare(actor(), {
      conversation_id: conversationId,
      session_id: sessionId,
      ownership_revision: claim.revision,
      inbound_id: inboundId,
      idempotency_key: randomUUID(),
      text,
    });
  }
  async function nativeDeal() {
    const contact = (
      await pool.query('SELECT contact_id FROM conversations WHERE id=$1', [
        conversationId,
      ])
    ).rows[0].contact_id;
    const pipeline = (
      await pool.query(
        "INSERT INTO pipelines(account_id,user_id,name) VALUES($1,$2,'Fixture pipeline') RETURNING id",
        [accountId, userId]
      )
    ).rows[0].id;
    const stage = (
      await pool.query(
        "INSERT INTO pipeline_stages(pipeline_id,name) VALUES($1,'Fixture stage') RETURNING id",
        [pipeline]
      )
    ).rows[0].id;
    const deal = (
      await pool.query(
        "INSERT INTO deals(account_id,user_id,pipeline_id,stage_id,contact_id,conversation_id,title,value) VALUES($1,$2,$3,$4,$5,$6,'Fixture deal',123) RETURNING id",
        [accountId, userId, pipeline, stage, contact, conversationId]
      )
    ).rows[0].id;
    return { deal, pipeline, stage };
  }
  it('writes one native internal note and a persisted outcome under concurrent retries, then replays after takeover', async () => {
    const input = await action('note', { note: 'Synthetic internal context' });
    const rows = await Promise.all([
      service.perform(actor(), input),
      service.perform(actor(), input),
    ]);
    expect(rows[0].id).toBe(rows[1].id);
    expect(rows[0].result.user_id).toBe(userId);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM contact_notes WHERE account_id=$1',
          [accountId]
        )
      ).rows[0].n
    ).toBe(1);
    await service.takeover(human(), conversationId);
    expect((await service.perform(actor(), input)).id).toBe(rows[0].id);
    expect((await service.outcome(actor(), rows[0].id)).result).toEqual(
      rows[0].result
    );
    await expect(
      service.perform(actor(), { ...input, payload: { note: 'changed' } })
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      service.outcome({ accountId: otherAccountId, keyId }, rows[0].id)
    ).rejects.toMatchObject({ status: 403 });
    expect(provider).not.toHaveBeenCalled();
  });
  it.each([
    'paused',
    'expired',
    'replaced',
    'viewer',
    'revoked',
    'scope',
    'policy',
    'takeover',
    'revision',
    'account',
  ])('denies CRM mutation with %s authority', async (condition) => {
    const input = await action('note', { note: 'must not persist' });
    if (condition === 'paused')
      await asHuman("SELECT transition_copilot_session('pause',$1)", [
        sessionId,
      ]);
    if (condition === 'expired')
      await pool.query(
        "UPDATE copilot_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1",
        [accountId]
      );
    if (condition === 'replaced')
      await asHuman("SELECT transition_copilot_session('start')");
    if (condition === 'viewer')
      await pool.query(
        "UPDATE profiles SET account_role='viewer' WHERE user_id=$1",
        [userId]
      );
    if (condition === 'revoked')
      await pool.query(
        'UPDATE api_keys SET revoked_at=clock_timestamp() WHERE id=$1',
        [keyId]
      );
    if (condition === 'scope')
      await pool.query(
        "UPDATE api_keys SET scopes=ARRAY['copilot:act'] WHERE id=$1",
        [keyId]
      );
    if (condition === 'policy') await service.setPolicy(human(), false);
    if (condition === 'takeover')
      await service.takeover(human(), conversationId);
    if (condition === 'revision') input.ownership_revision = '999';
    if (condition === 'account') input.conversation_id = randomUUID();
    await expect(service.perform(actor(), input)).rejects.toBeDefined();
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM contact_notes WHERE account_id=$1',
          [accountId]
        )
      ).rows[0].n
    ).toBe(0);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM copilot_actions WHERE account_id=$1',
          [accountId]
        )
      ).rows[0].n
    ).toBe(0);
    expect(provider).not.toHaveBeenCalled();
  });
  it('a valid foreign-account operator/key/session cannot mutate or inspect this tenant', async () => {
    const input = await action('note', { note: 'Tenant A note' });
    const row = await service.perform(actor(), input);
    const foreignHuman = { accountId: otherAccountId, userId: otherUserId };
    const foreignKey = (
      await pool.query(
        "INSERT INTO api_keys(account_id,created_by,name,key_prefix,key_hash,scopes) VALUES($1,$2,'foreign','fixture',$3,ARRAY['copilot:act','copilot:crm']) RETURNING id",
        [otherAccountId, otherUserId, randomUUID()]
      )
    ).rows[0].id;
    await service.bindKey(foreignHuman, foreignKey);
    await service.setPolicy(foreignHuman, true);
    const c = await pool.connect();
    let foreignSession: string;
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [
        otherUserId,
      ]);
      await c.query('SET LOCAL ROLE authenticated');
      foreignSession = (
        await c.query(
          "SELECT session_id FROM transition_copilot_session('start')"
        )
      ).rows[0].session_id;
      await c.query('COMMIT');
    } finally {
      c.release();
    }
    const foreignActor = { accountId: otherAccountId, keyId: foreignKey };
    await expect(
      service.perform(foreignActor, {
        ...input,
        session_id: foreignSession!,
        idempotency_key: randomUUID(),
      })
    ).rejects.toMatchObject({ status: 404 });
    await expect(service.outcome(foreignActor, row.id)).rejects.toMatchObject({
      status: 404,
    });
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM contact_notes WHERE account_id=$1',
          [accountId]
        )
      ).rows[0].n
    ).toBe(1);
  });
  it('rejects a foreign contact relationship even in an account-owned conversation', async () => {
    const contact = (
      await pool.query(
        "INSERT INTO contacts(account_id,user_id,phone,name) VALUES($1,$2,'+15559876543','Foreign fixture') RETURNING id",
        [otherAccountId, otherUserId]
      )
    ).rows[0].id;
    await pool.query('UPDATE conversations SET contact_id=$2 WHERE id=$1', [
      conversationId,
      contact,
    ]);
    expect(
      (
        await pool.query(
          'SELECT copilot_latest_inbound_id FROM conversations WHERE id=$1',
          [conversationId]
        )
      ).rows[0].copilot_latest_inbound_id
    ).toBeNull();
    await service.takeover(human(), conversationId, true);
    inboundId = (
      await pool.query(
        "INSERT INTO messages(conversation_id,sender_type,content_text,message_id) VALUES($1,'customer','New synthetic request',$2) RETURNING id",
        [conversationId, `wamid.${randomUUID()}`]
      )
    ).rows[0].id;
    const input = await action('note', {
      note: 'must not reach a foreign contact',
    });
    await expect(service.perform(actor(), input)).rejects.toMatchObject({
      status: 404,
    });
    await expect(
      service.context(
        actor(),
        conversationId,
        sessionId,
        input.ownership_revision
      )
    ).rejects.toMatchObject({ status: 404 });
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM contact_notes WHERE account_id=$1',
          [accountId]
        )
      ).rows[0].n
    ).toBe(0);
  });
  it('handoff atomically assigns the bound human, retains history, cancels replies and audits the result', async () => {
    const draft = await approved();
    const input = await action('handoff', {
      summary: 'Needs a human decision',
    });
    const row = await service.perform(actor(), input);
    expect(row.result.assigned_agent_id).toBe(userId);
    expect(row.result.ai_handoff_summary).toBe('Needs a human decision');
    expect(row.result.ai_autoreply_disabled).toBe(true);
    expect((await service.get(actor(), draft.id)).state).toBe('cancelled');
    expect((await service.perform(actor(), input)).id).toBe(row.id);
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM messages WHERE conversation_id=$1',
          [conversationId]
        )
      ).rows[0].n
    ).toBe(1);
  });
  it('only assigns eligible account humans; cannot overwrite a human assignment', async () => {
    const input = await action('assign', {
      operator_id: otherUserId,
      summary: 'Assign to a human',
    });
    await expect(service.perform(actor(), input)).rejects.toMatchObject({
      status: 403,
    });
    // Move an empty synthetic operator to the account, preserving upstream membership invariants.
    await pool.query(
      "UPDATE profiles SET account_id=$2,account_role='agent' WHERE user_id=$1",
      [otherUserId, accountId]
    );
    expect(
      (
        await service.context(
          actor(),
          conversationId,
          sessionId,
          input.ownership_revision
        )
      ).operators.some((o) => o.user_id === otherUserId)
    ).toBe(true);
    const result = await service.perform(actor(), input);
    expect(result.result.assigned_agent_id).toBe(otherUserId);
    await expect(
      service.perform(actor(), {
        ...input,
        idempotency_key: randomUUID(),
        payload: { operator_id: userId, summary: 'must not steal' },
      })
    ).rejects.toMatchObject({ status: 409 });
  });
  it.each(['pending', 'closed'])(
    'status %s cancels authority; reopening does not revive an approval',
    async (status) => {
      const draft = await approved();
      const input = await action('status', { status });
      expect((await service.perform(actor(), input)).result.status).toBe(
        status
      );
      expect((await service.get(actor(), draft.id)).state).toBe('cancelled');
      await asHuman("UPDATE conversations SET status='open' WHERE id=$1", [
        conversationId,
      ]);
      await expect(service.dispatch(actor(), draft.id)).rejects.toMatchObject({
        status: 409,
      });
      expect(provider).not.toHaveBeenCalled();
    }
  );
  it('native human close/reopen independently fences stale claims and approvals (PR #11 regression)', async () => {
    const draft = await approved();
    await asHuman("UPDATE conversations SET status='closed' WHERE id=$1", [
      conversationId,
    ]);
    await asHuman("UPDATE conversations SET status='open' WHERE id=$1", [
      conversationId,
    ]);
    expect((await service.get(actor(), draft.id)).state).toBe('cancelled');
    await expect(service.dispatch(actor(), draft.id)).rejects.toMatchObject({
      status: 409,
    });
    expect(provider).not.toHaveBeenCalled();
  });
  it('updates only linked native deals, with a stage in their current pipeline and no financial changes', async () => {
    const { deal, stage } = await nativeDeal();
    const input = await action('deal', {
      deal_id: deal,
      title: 'Updated fixture',
      stage_id: stage,
      status: 'won',
    });
    const context = await service.context(
      actor(),
      conversationId,
      sessionId,
      input.ownership_revision
    );
    expect(context.deals[0].id).toBe(deal);
    const row = await service.perform(actor(), input);
    expect(row.result.status).toBe('won');
    expect(
      (
        await pool.query('SELECT value,closed_at FROM deals WHERE id=$1', [
          deal,
        ])
      ).rows[0]
    ).toMatchObject({ value: '123.00', closed_at: expect.any(Date) });
    await expect(
      service.perform(actor(), {
        ...input,
        idempotency_key: randomUUID(),
        payload: { deal_id: deal, stage_id: randomUUID() },
      })
    ).rejects.toMatchObject({ status: 400 });
    await expect(
      service.perform(actor(), {
        ...input,
        payload: { deal_id: deal, value: '999' },
      })
    ).rejects.toMatchObject({ status: 400 });
    await pool.query('UPDATE deals SET conversation_id=NULL WHERE id=$1', [
      deal,
    ]);
    await expect(
      service.perform(actor(), { ...input, idempotency_key: randomUUID() })
    ).rejects.toMatchObject({ status: 404 });
  });
  it('session expiry while waiting on a deal row rolls back without an audit or mutation', async () => {
    const { deal } = await nativeDeal();
    const input = await action('deal', {
      deal_id: deal,
      title: 'must not persist',
    });
    await pool.query(
      "UPDATE copilot_sessions SET expires_at=clock_timestamp()+interval '120 milliseconds' WHERE account_id=$1",
      [accountId]
    );
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query('SELECT id FROM deals WHERE id=$1 FOR UPDATE', [deal]);
    const checked = expect(
      service.perform(actor(), input)
    ).rejects.toMatchObject({ status: 409 });
    await new Promise((resolve) => setTimeout(resolve, 220));
    await blocker.query('COMMIT');
    blocker.release();
    await checked;
    expect(
      (await pool.query('SELECT title FROM deals WHERE id=$1', [deal])).rows[0]
        .title
    ).toBe('Fixture deal');
  });
  it('direct authenticated and service role writes cannot forge action outcomes or knowledge', async () => {
    for (const table of ['copilot_actions', 'copilot_answers']) {
      await expect(
        asHuman(`DELETE FROM ${table} WHERE account_id=$1`, [accountId])
      ).rejects.toMatchObject({ code: '42501' });
      const c = await pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('SET LOCAL ROLE service_role');
        await expect(
          c.query(`DELETE FROM ${table} WHERE account_id=$1`, [accountId])
        ).rejects.toMatchObject({ code: '42501' });
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
    }
    const input = await action('note', { note: 'Synthetic row' });
    await service.perform(actor(), input);
    expect(
      (
        await asHuman('SELECT * FROM copilot_actions WHERE account_id=$1', [
          accountId,
        ])
      ).rows
    ).toHaveLength(1);
    expect(
      (
        await asHuman('SELECT * FROM copilot_actions WHERE account_id=$1', [
          otherAccountId,
        ])
      ).rows
    ).toHaveLength(0);
  });
  it('default human approval does not auto-approve even a verified answer', async () => {
    await knowledge();
    const row = await draft();
    expect(row.state).toBe('draft');
    await service.dispatch(actor(), row.id);
    expect(provider).not.toHaveBeenCalled();
  });
  it('hybrid exact verified business answer can dispatch once through all existing guards', async () => {
    const row = await hybridDraft();
    expect(row).toMatchObject({
      state: 'approved',
      authorization_basis: 'verified_answer',
      approved_by: null,
    });
    expect((await service.dispatch(actor(), row.id)).state).toBe('sent');
    await service.dispatch(actor(), row.id);
    expect(provider).toHaveBeenCalledTimes(1);
  });
  it.each([
    'changed reply',
    'unknown query',
    'expired',
    'disabled',
    'unverified',
    'nontext',
    'risky',
  ])(
    'hybrid %s requires human approval instead of trusting model labels',
    async (condition) => {
      await knowledge();
      await service.setPolicy(human(), true, 'hybrid');
      if (condition === 'unknown query')
        await pool.query(
          "UPDATE copilot_answers SET query_normalized='different question' WHERE account_id=$1",
          [accountId]
        );
      if (condition === 'expired')
        await pool.query(
          "UPDATE copilot_answers SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1",
          [accountId]
        );
      if (condition === 'disabled')
        await pool.query(
          'UPDATE copilot_answers SET enabled=false WHERE account_id=$1',
          [accountId]
        );
      if (condition === 'unverified')
        await pool.query(
          'UPDATE messages SET copilot_verified_inbound=false WHERE id=$1',
          [inboundId]
        );
      if (condition === 'nontext')
        await pool.query(
          "UPDATE messages SET content_type='image' WHERE id=$1",
          [inboundId]
        );
      if (condition === 'risky') {
        await pool.query(
          "UPDATE messages SET content_text='I want a human refund' WHERE id=$1",
          [inboundId]
        );
        await pool.query(
          "UPDATE copilot_answers SET query_normalized='i want a human refund' WHERE account_id=$1",
          [accountId]
        );
      }
      // Trusted fixture edits invalidate ownership, so establish the current inbound pointer explicitly.
      await pool.query(
        'UPDATE conversations SET copilot_latest_inbound_id=$2 WHERE id=$1',
        [conversationId, inboundId]
      );
      const claim = await service.claim(actor(), conversationId, sessionId);
      const row = await service.prepare(actor(), {
        conversation_id: conversationId,
        session_id: sessionId,
        ownership_revision: claim.revision,
        inbound_id: inboundId,
        idempotency_key: randomUUID(),
        text:
          condition === 'changed reply'
            ? 'Invented facts'
            : 'Verified hours: 09:00 to 17:00',
      });
      expect(row.state).toBe('draft');
      await service.dispatch(actor(), row.id);
      expect(provider).not.toHaveBeenCalled();
      if (condition === 'unknown query') {
        await service.approve(human(), row.id);
        expect((await service.dispatch(actor(), row.id)).state).toBe('sent');
      }
    }
  );
  it.each(['edit', 'expiry', 'policy', 'takeover', 'pause'])(
    'rechecks hybrid %s at dispatch and prevents sending',
    async (condition) => {
      const row = await hybridDraft();
      if (condition === 'edit')
        await knowledge('Synthetic request', 'Updated verified answer');
      if (condition === 'expiry')
        await pool.query(
          "UPDATE copilot_answers SET expires_at=clock_timestamp()-interval '1 second' WHERE account_id=$1",
          [accountId]
        );
      if (condition === 'policy')
        await service.setPolicy(human(), true, 'human_approval');
      if (condition === 'takeover')
        await service.takeover(human(), conversationId);
      if (condition === 'pause')
        await asHuman("SELECT transition_copilot_session('pause',$1)", [
          sessionId,
        ]);
      await expect(service.dispatch(actor(), row.id)).rejects.toMatchObject({
        status: 409,
      });
      expect(provider).not.toHaveBeenCalled();
    }
  );
  it('session expiry while dispatch waits for a contact lock prevents even a hybrid send', async () => {
    const row = await hybridDraft();
    await pool.query(
      "UPDATE copilot_sessions SET expires_at=clock_timestamp()+interval '150 milliseconds' WHERE account_id=$1",
      [accountId]
    );
    const blocker = await pool.connect();
    await blocker.query('BEGIN');
    await blocker.query(
      'SELECT ct.id FROM contacts ct JOIN conversations cv ON cv.contact_id=ct.id WHERE cv.id=$1 FOR UPDATE OF ct',
      [conversationId]
    );
    const checked = expect(
      service.dispatch(actor(), row.id)
    ).rejects.toMatchObject({ status: 409 });
    await new Promise((resolve) => setTimeout(resolve, 250));
    await blocker.query('COMMIT');
    blocker.release();
    await checked;
    expect(provider).not.toHaveBeenCalled();
    expect((await service.get(actor(), row.id)).state).toBe('cancelled');
  });
  it('a newer inbound prevents CRM mutations from stale context', async () => {
    const input = await action('note', { note: 'stale note' });
    await pool.query(
      "INSERT INTO messages(conversation_id,sender_type,content_text,message_id) VALUES($1,'customer','New request',$2)",
      [conversationId, `wamid.${randomUUID()}`]
    );
    await expect(service.perform(actor(), input)).rejects.toMatchObject({
      status: 409,
    });
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM contact_notes WHERE account_id=$1',
          [accountId]
        )
      ).rows[0].n
    ).toBe(0);
  });
  it('curated business knowledge prevents destructive account replacement when joining a team', async () => {
    const foreignHuman = { accountId: otherAccountId, userId: otherUserId };
    await service.verifyBusinessAnswer(foreignHuman, {
      question: 'Office hours?',
      answer: 'Synthetic office hours',
      source_reference: 'fixture',
      expires_at: new Date(Date.now() + 3600000).toISOString(),
    });
    const token = randomUUID();
    await pool.query(
      "INSERT INTO account_invitations(account_id,token_hash,role,expires_at,created_by_user_id) VALUES($1,$2,'agent',clock_timestamp()+interval '1 hour',$3)",
      [accountId, token, userId]
    );
    const c = await pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SELECT set_config('request.jwt.claim.sub',$1,true)", [
        otherUserId,
      ]);
      await c.query('SET LOCAL ROLE authenticated');
      await expect(
        c.query('SELECT redeem_invitation($1)', [token])
      ).rejects.toMatchObject({ code: '23505' });
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    expect(
      (
        await pool.query(
          'SELECT count(*)::int n FROM copilot_answers WHERE account_id=$1',
          [otherAccountId]
        )
      ).rows[0].n
    ).toBe(1);
  });
  it('only admin humans can curate answers or change policy; risk markers cannot be allowlisted', async () => {
    await expect(
      knowledge('I want a refund', 'Ask the team')
    ).rejects.toMatchObject({ status: 400 });
    await pool.query(
      "UPDATE profiles SET account_role='agent' WHERE user_id=$1",
      [userId]
    );
    await expect(knowledge()).rejects.toMatchObject({ status: 403 });
    await expect(
      service.setPolicy(human(), true, 'hybrid')
    ).rejects.toMatchObject({ status: 403 });
  });
});
