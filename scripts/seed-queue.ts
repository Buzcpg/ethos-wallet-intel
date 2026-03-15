/**
 * seed-queue.ts — enqueue backfill jobs for all unscanned ethereum wallets
 *
 * Reads wallets seeded from Supabase profiles_v2 for the target chain (CHAIN env var, default 'ethereum')
 * and bulk-inserts backfill jobs into wallet_scan_jobs.
 *
 * Idempotent: skips wallets that already have a pending or running job.
 * Safe to re-run at any time.
 *
 * Usage:
 *   npx tsx scripts/seed-queue.ts            # enqueue all unscanned
 *   npx tsx scripts/seed-queue.ts --dry-run  # preview counts, no writes
 *   npx tsx scripts/seed-queue.ts --limit 500  # cap at 500 wallets
 */
import 'dotenv/config';
import { db as getDb } from '../src/db/client.js';
import { wallets, walletScanJobs } from '../src/db/schema/index.js';
import { isNull, eq, and, inArray, sql } from 'drizzle-orm';

const CHAIN = (process.env.CHAIN as 'ethereum' | 'base' | 'arbitrum' | 'optimism' | 'polygon') ?? 'ethereum';
const BATCH_SIZE = 500;

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const limitArg = args.find(a => a.startsWith('--limit=') || a === '--limit');
const LIMIT = limitArg
  ? parseInt(limitArg.startsWith('--limit=') ? limitArg.split('=')[1] : args[args.indexOf('--limit') + 1], 10)
  : null;

async function main() {
  const db = getDb();

  console.log(`\n[seed-queue] chain=${CHAIN} dry-run=${DRY_RUN}${LIMIT ? ` limit=${LIMIT}` : ''}`);

  // 1. Count total unscanned wallets
  const [{ total }] = await db
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(wallets)
    .where(and(eq(wallets.chain, CHAIN), isNull(wallets.lastScannedAt)));

  console.log(`[seed-queue] unscanned wallets on ${CHAIN}: ${total}`);

  if (total === 0) {
    console.log('[seed-queue] nothing to do.');
    process.exit(0);
  }

  const target = LIMIT ? Math.min(LIMIT, total) : total;
  const batches = Math.ceil(target / BATCH_SIZE);
  console.log(`[seed-queue] enqueueing ${target} wallets in ${batches} batches of ${BATCH_SIZE}`);

  if (DRY_RUN) {
    console.log('[seed-queue] dry-run — no writes. exiting.');
    process.exit(0);
  }

  // 2. Page through unscanned wallets and bulk-insert jobs
  let enqueued = 0;
  let skipped = 0;
  let offset = 0;

  while (enqueued + skipped < target) {
    const batchLimit = Math.min(BATCH_SIZE, target - enqueued - skipped);

    const rows = await db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.chain, CHAIN), isNull(wallets.lastScannedAt)))
      .limit(batchLimit)
      .offset(offset);

    if (rows.length === 0) break;

    const walletIds = rows.map(r => r.id);

    // Find which of these already have a pending/running job
    const existingJobs = await db
      .select({ walletId: walletScanJobs.walletId })
      .from(walletScanJobs)
      .where(
        and(
          inArray(walletScanJobs.walletId, walletIds),
          inArray(walletScanJobs.status, ['pending', 'running']),
        ),
      );

    const alreadyQueued = new Set(existingJobs.map(j => j.walletId));
    const toEnqueue = walletIds.filter(id => !alreadyQueued.has(id));

    if (toEnqueue.length > 0) {
      await db.insert(walletScanJobs).values(
        toEnqueue.map(walletId => ({
          walletId,
          chain: CHAIN,
          jobType: 'backfill',
          status: 'pending' as const,
        })),
      );
      enqueued += toEnqueue.length;
    }

    skipped += alreadyQueued.size;
    offset += rows.length;

    const pct = Math.round(((enqueued + skipped) / target) * 100);
    process.stdout.write(`\r[seed-queue] ${enqueued} enqueued, ${skipped} skipped (${pct}%)`);
  }

  console.log(`\n[seed-queue] done — ${enqueued} jobs enqueued, ${skipped} already had jobs`);

  // 3. Final queue state
  const counts = await db
    .select({
      status: walletScanJobs.status,
      count: sql<number>`count(*)`.mapWith(Number),
    })
    .from(walletScanJobs)
    .groupBy(walletScanJobs.status);

  console.log('\n[seed-queue] queue state:');
  for (const row of counts) {
    console.log(`  ${row.status.padEnd(10)} ${row.count}`);
  }
  console.log('');
}

main().catch(err => {
  console.error('[seed-queue] fatal:', err);
  process.exit(1);
});
