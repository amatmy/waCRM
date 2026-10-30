import { beforeEach, expect, it, vi } from 'vitest';
const h = vi.hoisted(() => ({
  auth: vi.fn(),
  approve: vi.fn(),
  takeover: vi.fn(),
  setPolicy: vi.fn(),
  bindKey: vi.fn(),
  reconcile: vi.fn(),
  verifyAnswer: vi.fn(),
  resolveHuman: vi.fn(),
}));
vi.mock('@/lib/auth/account', () => ({
  requireRole: h.auth,
  toErrorResponse: () => Response.json({ error: 'Denied' }, { status: 401 }),
}));
vi.mock('@/lib/rate-limit', () => ({
  checkRateLimit: () => ({ success: true }),
  RATE_LIMITS: { adminAction: {} },
  rateLimitResponse: () => Response.json({}, { status: 429 }),
}));
vi.mock('@/lib/copilot/db', () => ({ copilotPool: () => ({}) }));
vi.mock('@/lib/copilot/service', () => ({
  CopilotService: class {
    approve = h.approve;
    takeover = h.takeover;
    setPolicy = h.setPolicy;
    bindKey = h.bindKey;
    reconcile = h.reconcile;
  },
}));
vi.mock('@/lib/copilot/crm', () => ({
  CopilotCrmService: class {
    verifyBusinessAnswer = h.verifyAnswer;
  },
}));
vi.mock('@/lib/copilot/work', () => ({
  CopilotWorkService: class {
    resolveHuman = h.resolveHuman;
  },
}));
import { POST } from './route';
const id = '00000000-0000-4000-8000-000000000001';
const req = (body: unknown, origin = 'https://crm.test') =>
  new Request('https://crm.test/api/copilot/control', {
    method: 'POST',
    headers: { Origin: origin },
    body: JSON.stringify(body),
  });
beforeEach(() => {
  vi.resetAllMocks();
  h.auth.mockResolvedValue({ accountId: 'human-account', userId: 'human-id' });
  h.approve.mockResolvedValue({ state: 'approved' });
});
it('uses human cookie identity and exact outbox ID for approval', async () => {
  expect(
    (await POST(req({ action: 'approve', outbox_id: id, userId: 'attacker' })))
      .status
  ).toBe(200);
  expect(h.auth).toHaveBeenCalledWith('agent');
  expect(h.approve).toHaveBeenCalledWith(
    { accountId: 'human-account', userId: 'human-id' },
    id
  );
});
it.each(['', 'null', 'https://attacker.test'])(
  'rejects cross-origin or missing Origin: %s',
  async (origin) => {
    expect(
      (await POST(req({ action: 'approve', outbox_id: id }, origin))).status
    ).toBe(403);
    expect(h.approve).not.toHaveBeenCalled();
  }
);
it('rejects unauthenticated approval', async () => {
  h.auth.mockRejectedValue(new Error('No human'));
  expect((await POST(req({ action: 'approve', outbox_id: id }))).status).toBe(
    401
  );
  expect(h.approve).not.toHaveBeenCalled();
});

it('only the human control surface can select hybrid policy or curate verified answers', async () => {
  expect(
    (await POST(req({ action: 'policy', enabled: true, mode: 'hybrid' })))
      .status
  ).toBe(200);
  expect(h.setPolicy).toHaveBeenCalledWith(
    { accountId: 'human-account', userId: 'human-id' },
    true,
    'hybrid'
  );
  const answer = {
    question: 'Hours?',
    answer: '09:00',
    source_reference: 'Approved handbook',
    expires_at: '2027-01-01T00:00:00Z',
  };
  expect((await POST(req({ action: 'verify_answer', answer }))).status).toBe(
    200
  );
  expect(h.verifyAnswer).toHaveBeenCalledWith(
    { accountId: 'human-account', userId: 'human-id' },
    answer
  );
  expect(
    (await POST(req({ action: 'policy', enabled: true, mode: 'autonomous' })))
      .status
  ).toBe(400);
});

it('requires the human control identity for queue resolution and forwards only an explicit summary', async () => {
  expect(
    (
      await POST(
        req({
          action: 'resolve_work',
          work_id: id,
          summary: 'Operator handled the task',
        })
      )
    ).status
  ).toBe(200);
  expect(h.resolveHuman).toHaveBeenCalledWith(
    { accountId: 'human-account', userId: 'human-id' },
    id,
    'Operator handled the task'
  );
});
