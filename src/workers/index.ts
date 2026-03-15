import { env } from '../config/env.js';
import { dequeueNext, markDone, markFailed, resetStaleJobs } from '../queue/index.js';
import { jobRegistry } from '../jobs/registry.js';
import type { JobType } from '../jobs/types.js';
import { emitStreamEvent } from '../lib/streamEmit.js';
import { wallets, profileScores } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { db as getDb, getPool } from '../db/client.js';

const STALE_JOB_TIMEOUT_MS    = 10 * 60 * 1000; // 10 min — allow for deep_scan page delays
const STALE_RESET_INTERVAL_MS =  5 * 60 * 1000;

let running = false;
let jobsCompleted = 0;

async function emitStats(): Promise<void> {
  try {
    const pool = getPool();
    const client = await pool.connect();
    try {
      const jobRes = await client.query(`SELECT
        COUNT(*) FILTER (WHERE status = 'done')    AS total_done,
        COUNT(*) FILTER (WHERE status = 'pending') AS total_pending,
        COUNT(*) FILTER (WHERE status = 'running') AS total_running
        FROM wallet_scan_jobs`);
      const sigRes = await client.query(`SELECT COUNT(*) AS total_flagged, COUNT(DISTINCT funder_address) AS unique_funders FROM first_funder_signals`);
      const jr = jobRes.rows[0] ?? {}, sr = sigRes.rows[0] ?? {};
      const totalDone = Number(jr.total_done ?? 0), totalPending = Number(jr.total_pending ?? 0);
      const totalRunning = Number(jr.total_running ?? 0);
      const totalFlagged = Number(sr.total_flagged ?? 0), uniqueFunders = Number(sr.unique_funders ?? 0);
      const clearRate = totalDone > 0 ? Math.round(((totalDone - totalFlagged) / totalDone) * 100) : 0;
      lastStatEmit = Date.now();
      emitStreamEvent({ type: "stats", meta: { totalScanned: totalDone, totalPending, activeScans: totalRunning, totalFlagged, uniqueFunders, clearRate, idle: totalPending === 0 && totalRunning === 0 } });
    } finally { client.release(); }
  } catch { /* never crash */ }
}
let lastStatEmit = 0;
const STAT_EMIT_INTERVAL_MS = 15_000; // emit stats at most once per 15s
let shutdownRequested = false;
let activeSlots = 0;
let staleResetTimer: ReturnType<typeof setInterval> | null = null;

export function isRunning(): boolean { return running; }

async function runSlot(): Promise<void> {
  while (!shutdownRequested) {
    const job = await dequeueNext();

    if (!job) {
      // Emit idle stats when queue is empty (once per throttle window)
      if (Date.now() - lastStatEmit > STAT_EMIT_INTERVAL_MS) void emitStats();
      await new Promise(r => setTimeout(r, env.WORKER_POLL_INTERVAL_MS));
      continue;
    }

    const handler = jobRegistry[job.jobType as JobType];
    if (!handler) {
      await markFailed(job.id, `Unknown job type: ${job.jobType}`);
      continue;
    }

    let walletAddr: string | undefined;

    // Resolve wallet address independently — a DB blip here must not fail the job
    try {
      const [w] = await getDb().select({ address: wallets.address }).from(wallets).where(eq(wallets.id, job.walletId!)).limit(1);
      walletAddr = w?.address ?? (job.walletId?.slice(0, 8) ?? "unknown");
    } catch {
      walletAddr = job.walletId?.slice(0, 8) ?? "unknown";
    }

    try {
      emitStreamEvent({ type: "scan_start", wallet: walletAddr, chain: job.chain ?? undefined, meta: { jobType: job.jobType } });

      const stats = await handler(job);
      await markDone(job.id, stats ?? undefined);
      jobsCompleted++;

      const s = stats as Record<string, unknown> | undefined;

      let riskTier: string | undefined;
      try {
        const [w2] = await getDb().select({ profileId: wallets.profileId }).from(wallets).where(eq(wallets.id, job.walletId!)).limit(1);
        if (w2?.profileId) {
          const [ps] = await getDb().select({ riskTier: profileScores.riskTier }).from(profileScores).where(eq(profileScores.profileId, w2.profileId)).limit(1);
          riskTier = ps?.riskTier ?? undefined;
        }
      } catch { /* never crash the worker */ }

      emitStreamEvent({ type: "scan_complete", wallet: walletAddr, chain: job.chain ?? undefined, meta: { txsFetched: s?.transactionsFetched, firstFunderFound: s?.firstFunderFound, depositEvidenceFound: s?.depositEvidenceFound, p2pMatchesFound: s?.p2pMatchesFound, durationMs: s?.durationMs, riskTier } });

      if (s?.firstFunderFound) emitStreamEvent({ type: "wallet_found", wallet: walletAddr, chain: job.chain ?? undefined, meta: { signal: "first_funder", funderAddress: s?.funderAddress, txsFetched: s?.transactionsFetched } });

      // Emit live stats periodically
      if (Date.now() - lastStatEmit > STAT_EMIT_INTERVAL_MS) void emitStats();
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[worker] job ${job.id} (${job.jobType}) failed: ${message}`);
      await markFailed(job.id, message);
      emitStreamEvent({ type: "scan_error", wallet: walletAddr ?? "unknown", chain: job.chain ?? undefined, meta: { error: message } });
    }
  }
  activeSlots--;
}

export async function startWorker(): Promise<void> {
  if (running) { console.warn('[worker] already running'); return; }

  running = true;
  shutdownRequested = false;
  const concurrency = env.WORKER_CONCURRENCY;
  activeSlots = concurrency;

  console.log(`[worker] started — ${concurrency} slots, stale timeout ${STALE_JOB_TIMEOUT_MS / 60000}min`);
  // Emit initial stats so dashboard gets real numbers immediately
  void emitStats();

  try {
    const n = await resetStaleJobs(STALE_JOB_TIMEOUT_MS);
    if (n > 0) console.log(`[worker] reset ${n} stale jobs at startup`);
  } catch (err) {
    console.error('[worker] startup stale reset failed:', err);
  }

  staleResetTimer = setInterval(async () => {
    try {
      const n = await resetStaleJobs(STALE_JOB_TIMEOUT_MS);
      if (n > 0) console.log(`[worker] periodic reset: ${n} stale jobs → pending`);
    } catch (err) {
      console.error('[worker] periodic stale reset failed:', err);
    }
  }, STALE_RESET_INTERVAL_MS);

  for (let i = 0; i < concurrency; i++) {
    void runSlot();
  }
}

export function stopWorker(): void {
  console.log('[worker] shutdown requested');
  shutdownRequested = true;
  running = false;
  if (staleResetTimer) { clearInterval(staleResetTimer); staleResetTimer = null; }
}
