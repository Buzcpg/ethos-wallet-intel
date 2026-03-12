import { env } from '../config/env.js';
import { dequeueNext, markDone, markFailed, resetStaleJobs } from '../queue/index.js';
import { jobRegistry } from '../jobs/registry.js';
import type { JobType, WalletScanJob } from '../jobs/types.js';

// C3 — stale-job timeout: jobs running longer than this are reset to pending on startup
// and every STALE_RESET_INTERVAL_MS milliseconds.
const STALE_JOB_TIMEOUT_MS = 5 * 60 * 1000;   // 5 minutes
const STALE_RESET_INTERVAL_MS = 5 * 60 * 1000; // every 5 minutes

// Minimum pause between ticks when the queue is empty (avoid tight DB polling loop)
const IDLE_POLL_MS = env.WORKER_POLL_INTERVAL_MS;
// Minimum pause between ticks when jobs were found (yield the event loop, don't hammer DB)
const BUSY_POLL_MS = 50;

let running = false;
let shutdownRequested = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;
let staleResetTimer: ReturnType<typeof setInterval> | null = null;

export function isRunning(): boolean {
  return running;
}

// H1 — process up to WORKER_CONCURRENCY jobs per tick using Promise.allSettled.
// When jobs were found, loop back immediately (BUSY_POLL_MS) to keep throughput high.
// When the queue is empty, back off to IDLE_POLL_MS to avoid hammering Postgres.
async function processTick(): Promise<void> {
  if (shutdownRequested) return;

  let didWork = false;

  try {
    const concurrency = env.WORKER_CONCURRENCY;

    // Dequeue up to `concurrency` jobs atomically (FOR UPDATE SKIP LOCKED — no overlap)
    const dequeuePromises = Array.from({ length: concurrency }, () => dequeueNext());
    const dequeued = await Promise.all(dequeuePromises);
    const jobs = dequeued.filter((j): j is WalletScanJob => j !== null);

    if (jobs.length > 0) {
      didWork = true;
      await Promise.allSettled(
        jobs.map(async (job) => {
          const handler = jobRegistry[job.jobType as JobType];

          if (!handler) {
            await markFailed(job.id, `Unknown job type: ${job.jobType}`);
            return;
          }

          try {
            await handler(job);
            await markDone(job.id);
          } catch (err) {
            const message = err instanceof Error ? err.message : String(err);
            console.error(`[worker] job ${job.id} (${job.jobType}) failed: ${message}`);
            await markFailed(job.id, message);
          }
        }),
      );
    }
  } catch (err) {
    console.error('[worker] error during poll tick:', err);
  }

  if (!shutdownRequested) {
    // Loop back quickly while queue is hot; idle poll when empty
    const delay = didWork ? BUSY_POLL_MS : IDLE_POLL_MS;
    pollTimer = setTimeout(processTick, delay);
  }
}

export async function startWorker(): Promise<void> {
  if (running) {
    console.warn('[worker] already running');
    return;
  }

  running = true;
  shutdownRequested = false;
  console.log(`[worker] started — idle poll ${IDLE_POLL_MS}ms, busy poll ${BUSY_POLL_MS}ms, concurrency=${env.WORKER_CONCURRENCY}`);

  // C3 — reset stale jobs at startup
  try {
    const resetCount = await resetStaleJobs(STALE_JOB_TIMEOUT_MS);
    if (resetCount > 0) {
      console.log(`[worker] reset ${resetCount} stale running jobs at startup`);
    }
  } catch (err) {
    console.error('[worker] startup stale-job reset failed:', err);
  }

  // C3 — periodic stale-job reset every 5 minutes
  staleResetTimer = setInterval(async () => {
    try {
      const n = await resetStaleJobs(STALE_JOB_TIMEOUT_MS);
      if (n > 0) console.log(`[worker] periodic reset: ${n} stale jobs → pending`);
    } catch (err) {
      console.error('[worker] periodic stale-job reset failed:', err);
    }
  }, STALE_RESET_INTERVAL_MS);

  void processTick();
}

export function stopWorker(): void {
  console.log('[worker] shutdown requested');
  shutdownRequested = true;
  running = false;

  if (pollTimer) {
    clearTimeout(pollTimer);
    pollTimer = null;
  }

  // M13 — stale-reset interval cleared here (not in a separate SIGTERM handler)
  if (staleResetTimer) {
    clearInterval(staleResetTimer);
    staleResetTimer = null;
  }
}

// M13 — removed duplicate SIGTERM handler; src/index.ts handles SIGTERM + shutdown + process.exit
