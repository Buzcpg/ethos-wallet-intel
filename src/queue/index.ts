import { env } from '../config/env.js';
import { db as getDb } from '../db/client.js';
import { walletScanJobs } from '../db/schema/index.js';
import type { WalletScanJob, JobStatus } from '../jobs/types.js';
import type { ChainSlug } from '../chains/index.js';
import { eq, and } from 'drizzle-orm';
import { sql } from 'drizzle-orm';

export interface EnqueueJobOptions {
  fromBlock?: bigint;
  toBlock?: bigint;
}

export async function enqueueJob(
  walletId: string,
  chain: ChainSlug,
  jobType: string,
  options: EnqueueJobOptions = {},
): Promise<WalletScanJob> {
  const [job] = await getDb()
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

interface RawJobRow extends Record<string, unknown> {
  id: string;
  wallet_id: string | null;
  chain: string;
  job_type: string;
  status: string;
  started_at: string | null;
  finished_at: string | null;
  from_block: string | null;
  to_block: string | null;
  error: string | null;
  stats_json: unknown;
  created_at: string | null;
  updated_at: string | null;
}

function mapRawJobRow(row: RawJobRow): WalletScanJob {
  return {
    id: row.id,
    walletId: row.wallet_id,
    chain: row.chain,
    jobType: row.job_type,
    status: row.status as JobStatus,
    startedAt: row.started_at ? new Date(row.started_at) : null,
    finishedAt: row.finished_at ? new Date(row.finished_at) : null,
    fromBlock: row.from_block ? BigInt(row.from_block) : null,
    toBlock: row.to_block ? BigInt(row.to_block) : null,
    error: row.error,
    statsJson: row.stats_json,
    createdAt: row.created_at ? new Date(row.created_at) : null,
    updatedAt: row.updated_at ? new Date(row.updated_at) : null,
  };
}

export async function dequeueNext(): Promise<WalletScanJob | null> {
  // Build chain exclusion clause from SKIP_CHAINS env var
  const skipChains = env.SKIP_CHAINS
    ? env.SKIP_CHAINS.split(',').map(c => c.trim()).filter(Boolean)
    : [];

  const chainFilter = skipChains.length > 0
    ? sql`AND chain NOT IN (${sql.raw(skipChains.map(c => `'${c}'`).join(', '))})`
    : sql``;

  const result = await getDb().execute<RawJobRow>(sql`
    UPDATE wallet_scan_jobs
    SET status = 'running',
        started_at = now(),
        updated_at = now()
    WHERE id = (
      SELECT id FROM wallet_scan_jobs
      WHERE status = 'pending'
      ${chainFilter}
      ORDER BY created_at ASC
      LIMIT 1
      FOR UPDATE SKIP LOCKED
    )
    RETURNING *
  `);

  if (!result.rows[0]) return null;
  return mapRawJobRow(result.rows[0]);
}

export async function markDone(jobId: string, stats?: Record<string, unknown>): Promise<void> {
  await getDb()
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
  await getDb()
    .update(walletScanJobs)
    .set({
      status: 'failed',
      finishedAt: sql`now()`,
      updatedAt: sql`now()`,
      error,
    })
    .where(eq(walletScanJobs.id, jobId));
}

export async function resetStaleJobs(staleTimeoutMs: number): Promise<number> {
  const cutoff = new Date(Date.now() - staleTimeoutMs);

  const result = await getDb()
    .update(walletScanJobs)
    .set({
      status: 'pending',
      updatedAt: new Date(),
    })
    .where(
      and(
        eq(walletScanJobs.status, 'running'),
        sql`started_at < ${cutoff}`,
      ),
    );

  return result.rowCount ?? 0;
}

export async function getQueueCounts(): Promise<{
  pending: number;
  running: number;
  done: number;
  failed: number;
}> {
  const result = await getDb()
    .select({
      status: walletScanJobs.status,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(walletScanJobs)
    .groupBy(walletScanJobs.status);

  const counts = {
    pending: 0,
    running: 0,
    done: 0,
    failed: 0,
  };

  for (const row of result) {
    if (row.status === 'pending') counts.pending = row.count;
    if (row.status === 'running') counts.running = row.count;
    if (row.status === 'done') counts.done = row.count;
    if (row.status === 'failed') counts.failed = row.count;
  }

  return counts;
}

export async function getJob(jobId: string): Promise<WalletScanJob | null> {
  const result = await getDb().query.walletScanJobs.findFirst({
    where: eq(walletScanJobs.id, jobId),
  });
  return result ?? null;
}
