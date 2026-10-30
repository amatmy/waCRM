import { Pool, type PoolClient } from 'pg';
import { ApiError } from '@/lib/api/v1/respond';

let pool: Pool | undefined;
export function copilotPool(): Pool {
  const connectionString = process.env.COPILOT_DATABASE_URL;
  if (!connectionString)
    throw new ApiError(
      'unavailable',
      'Copilot database connection is not configured',
      503
    );
  if (!pool) {
    pool = new Pool({
      connectionString,
      max: 4,
      connectionTimeoutMillis: 5000,
      idleTimeoutMillis: 10000,
    });
    pool.on('error', () =>
      console.error('[copilot] idle database connection failed')
    );
  }
  return pool;
}

export async function transaction<T>(
  pool: Pool,
  fn: (client: PoolClient) => Promise<T>
): Promise<T> {
  const client = await pool.connect();
  let broken = false;
  const onError = () => {
    broken = true;
  };
  client.on('error', onError);
  try {
    await client.query('BEGIN');
    await client.query(
      "SET LOCAL lock_timeout = '5s'; SET LOCAL statement_timeout = '15s'; SET LOCAL idle_in_transaction_session_timeout = '15s'"
    );
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK').catch(() => {
      broken = true;
    });
    throw error;
  } finally {
    client.removeListener('error', onError);
    client.release(broken);
  }
}
