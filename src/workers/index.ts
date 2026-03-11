import { env } from '../config/env.js';
import { dequeueNext, markDone, markFailed } from '../queue/index.js';
import { jobRegistry } from '../jobs/registry.js';
import type { JobType } from '../jobs/types.js';

let running = false;
let shutdownRequested = false;
let pollTimer: ReturnType<typeof setTimeout> | null = null;

export function isRunning(): boolean {
  return running;
}

async function processTick(): Promise<void> {
  if (shutdownRequested) return;

  try {
    const job = await dequeueNext();

    if (job) {
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
    }
  } catch (err) {
    console.error('[worker] error during poll tick:', err);
  }

  if (!shutdownRequested) {
    pollTimer = setTimeout(processTick, env.WORKER_POLL_INTERVAL_MS);
  }
}

export function startWorker(): void {
  if (running) {
    console.warn('[worker] already running');
    return;
  }

  running = true;
  shutdownRequested = false;
  console.log(`[worker] started — polling every ${env.WORKER_POLL_INTERVAL_MS}ms`);

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
}

process.on('SIGTERM', () => {
  console.log('[worker] SIGTERM received — shutting down gracefully');
  stopWorker();
});
