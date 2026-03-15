import { env } from '../config/env.js';
import { dequeueNext, markDone, markFailed, resetStaleJobs } from '../queue/index.js';
import { jobRegistry } from '../jobs/registry.js';
import type { JobType } from '../jobs/types.js';
import { emitStreamEvent } from '../lib/streamEmit.js';
import { wallets } from '../db/schema/index.js';
import { eq } from 'drizzle-orm';
import { db as getDb } from '../db/client.js';

const STALE_JOB_TIMEOUT_MS    = 10 * 60 * 1000; // 10 min — allow for deep_scan page delays
const STALE_RESET_INTERVAL_MS =  5 * 60 * 1000;

let running = false;
let shutdownRequested = false;
let activeSlots = 0;
let staleResetTimer: ReturnType<typeof setInterval> | null = null;

export function isRunning(): boolean { return running; }

async function runSlot(): Promise<void> {
  while (!shutdownRequested) {
    const job = await dequeueNext();

    if (!job) {
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

      const s = stats as Record<string, unknown> | undefined;
      emitStreamEvent({ type: "scan_complete", wallet: walletAddr, chain: job.chain ?? undefined, meta: { txsFetched: s?.transactionsFetched, firstFunderFound: s?.firstFunderFound, depositEvidenceFound: s?.depositEvidenceFound, p2pMatchesFound: s?.p2pMatchesFound, durationMs: s?.durationMs } });

      if (s?.firstFunderFound) emitStreamEvent({ type: "wallet_found", wallet: walletAddr, chain: job.chain ?? undefined, meta: { signal: "first_funder", funderAddress: s?.funderAddress, txsFetched: s?.transactionsFetched } });
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
