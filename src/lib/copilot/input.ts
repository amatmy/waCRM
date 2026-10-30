import { badRequest } from '@/lib/api/v1/respond';
export function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value))
    throw badRequest('JSON object required');
  return value as Record<string, unknown>;
}
export function text(
  body: Record<string, unknown>,
  key: string,
  max = 4096
): string {
  const value = body[key];
  if (typeof value !== 'string' || !value.trim() || value.length > max)
    throw badRequest(`Invalid ${key}`);
  return value;
}
export function uuid(body: Record<string, unknown>, key: string): string {
  const value = text(body, key, 36);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
      value
    )
  )
    throw badRequest(`Invalid ${key}`);
  return value;
}
export function revision(body: Record<string, unknown>): string {
  const value = text(body, 'ownership_revision', 18);
  if (!/^\d+$/.test(value)) throw badRequest('Invalid ownership_revision');
  return value;
}

export function optionalUuid(
  body: Record<string, unknown>,
  key: string
): string | undefined {
  return body[key] === undefined ? undefined : uuid(body, key);
}
