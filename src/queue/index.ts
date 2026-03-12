import { eq, sql } from 'drizzle-orm';
import { db } from '../db/client.js';
import { walletScanJobs } from '../db/schema/index.js';
import type { JobType, EnqueueJobOptions, WalletScanJob } from '../jobs/types.js';
import type { ChainSlug } from '../chains/index.js';

// L7 — chain param typed as ChainSlug instead of string for type safety at call sites.
export async function enqueueJob(
  walletId: string,
  chain: ChainSlug,
  jobType: JobType,
  options: EnqueueJobOptions = {},
): Promise<WalletScanJob> {
  const [job] = await db()
    .insert(walletScanJobs)
    .values({
      walletId,
      chain,
      jobType,
      status: 'pending',
      fromBlock: options.fromBlock ?? null,
      toBlock: options.toBlock ?? null,
    })
    .returning();

  if (!job) throw new Error('Failed to enqueue job');
  return job;
}

export async function dequeueNext(): Promise<WalletScanJob | null> {
  const result = await db().execute<WalletScanJob>(sql`
    UPDATE wallet_scan_jobs
    SET status = 'running',
        started_at = now(),
        updated_at = now()
    WHERE id = (
      SELECT id FROM wallet_scan_jobs
      WHERE status = 'pending'
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  return (result.rows[0] as WalletScanJob | undefined) ?? null;
}

export async function markDone(jobId: string, stats?: Record<string, unknown>): Promise<void> {
  await db()
    .update(walletScanJobs)
    .set({
      status: 'done',
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
      statsJson: stats ?? null,
    })
    .where(eq(walletScanJobs.id, jobId));
}

export async function markFailed(jobId: string, error: string): Promise<void> {
  await db()
    .update(walletScanJobs)
    .set({
      status: 'failed',
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
      error,
    })
    .where(eq(walletScanJobs.id, jobId));
}

export async function getJob(jobId: string): Promise<WalletScanJob | null> {
  const [job] = await db()
    .select()
    .from(walletScanJobs)
    .where(eq(walletScanJobs.id, jobId))
    .limit(1);

  return job ?? null;
}

export async function getQueueCounts(): Promise<{ pending: number; running: number; failed: number }> {
  const result = await db().execute<{ status: string; count: string }>(sql`
    SELECT status, COUNT(*) as count
    FROM wallet_scan_jobs
    WHERE status IN ('pending', 'running', 'failed')
    GROUP BY status
  `);

  const counts = { pending: 0, running: 0, failed: 0 };
  for (const row of result.rows) {
    const r = row as { status: string; count: string };
    if (r.status === 'pending') counts.pending = parseInt(r.count, 10);
    if (r.status === 'running') counts.running = parseInt(r.count, 10);
    if (r.status === 'failed') counts.failed = parseInt(r.count, 10);
  }
  return counts;
}

/**
 * C3 — Reset stale running jobs back to pending.
 * Any job in status='running' with started_at older than timeoutMs is reset.
 * Call at worker startup and periodically to recover from worker crashes.
 * Returns the number of jobs reset.
 */
export async function resetStaleJobs(timeoutMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - timeoutMs);
  const result = await db().execute<{ id: string }>(sql`
    UPDATE wallet_scan_jobs
    SET status = 'pending',
        started_at = null,
        updated_at = now()
    WHERE status = 'running'
      AND started_at < ${cutoff}
    RETURNING id
  `);
  return result.rows.length;
}
