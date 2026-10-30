import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ApiError } from '@/lib/api/v1/respond';

const lookup = vi.hoisted(() => ({
  result: { data: null as unknown, error: null as unknown },
  binding: { data: null as unknown, error: null as unknown },
}));

vi.mock('@/lib/flows/admin-client', () => ({
  supabaseAdmin: () => {
    let tableName = '';
    const builder = {
      select: () => builder,
      eq: () => builder,
      maybeSingle: async () =>
        tableName === 'copilot_keys' ? lookup.binding : lookup.result,
    };
    return {
      from: (table: string) => {
        tableName = table;
        return builder;
      },
    };
  },
}));

const { findActiveKeyByHash } = await import('./store');

const activeRow = {
  id: 'key-1',
  account_id: 'acct-1',
  created_by: null,
  name: 'Key',
  scopes: [],
  expires_at: null,
  revoked_at: null,
};

beforeEach(() => {
  lookup.result = { data: null, error: null };
  lookup.binding = { data: null, error: null };
  vi.spyOn(console, 'error').mockImplementation(() => {});
});

describe('findActiveKeyByHash', () => {
  it('marks a bound key independently of its mutable scopes', async () => {
    lookup.result = {
      data: { ...activeRow, scopes: ['contacts:write'] },
      error: null,
    };
    lookup.binding = { data: { operator_id: 'human' }, error: null };
    await expect(findActiveKeyByHash('h')).resolves.toMatchObject({
      copilot_bound: true,
    });
  });
  it('fails closed when durable key binding cannot be checked', async () => {
    lookup.result = { data: activeRow, error: null };
    lookup.binding = { data: null, error: { message: 'unavailable' } };
    await expect(findActiveKeyByHash('h')).rejects.toMatchObject({
      status: 503,
    });
  });
  it('returns the row for an active key', async () => {
    lookup.result = { data: activeRow, error: null };
    await expect(findActiveKeyByHash('h')).resolves.toEqual(activeRow);
  });

  it('returns null when no key matches', async () => {
    await expect(findActiveKeyByHash('h')).resolves.toBeNull();
  });

  it('returns null for a revoked key', async () => {
    lookup.result = {
      data: { ...activeRow, revoked_at: '2026-01-01T00:00:00Z' },
      error: null,
    };
    await expect(findActiveKeyByHash('h')).resolves.toBeNull();
  });

  it('throws a 503 ApiError when the lookup fails', async () => {
    lookup.result = { data: null, error: { message: 'connection refused' } };
    const err = await findActiveKeyByHash('h').catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiError);
    expect((err as ApiError).status).toBe(503);
    expect((err as ApiError).code).toBe('unavailable');
  });
});
