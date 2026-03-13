import type { JobHandler, JobType } from './types.js';
import type { ChainSlug } from '../chains/index.js';
import { db } from '../db/client.js';
import { WalletScanner } from '../scanner/walletScanner.js';
import { isValidChain } from '../chains/index.js';
import { markFailed } from '../queue/index.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * backfill — full three-signal scan via WalletScanner.
 * Single tx fetch, all three extractors (firstFunder, deposit, p2p) in parallel.
 */
const backfillHandler: JobHandler = async (job) => {
  if (!job.walletId) {
    console.warn('[backfill] Job missing walletId, skipping');
    return;
  }
  if (!isValidChain(job.chain)) {
    console.warn(`[backfill] Invalid chain "${job.chain}", skipping`);
    return;
  }
  console.log(`[backfill] full scan — wallet ${job.walletId} on ${job.chain}`);
  const scanner = new WalletScanner();
  const result = await scanner.scanWallet(job.walletId, job.chain);
  console.log(`[backfill] result:`, result);
};

/**
 * delta — fetch only transactions since lastScannedBlock, run all three
 * extractors on new data. Falls back to full scan for first-time wallets.
 */
const deltaHandler: JobHandler = async (job) => {
  if (!job.walletId) {
    console.warn('[delta] Job missing walletId, skipping');
    return;
  }
  if (!isValidChain(job.chain)) {
    console.warn(`[delta] Invalid chain "${job.chain}", skipping`);
    return;
  }
  console.log(`[delta] delta scan — wallet ${job.walletId} on ${job.chain}`);
  const scanner = new WalletScanner();
  const result = await scanner.deltaScanWallet(job.walletId, job.chain);
  console.log(`[delta] result:`, result);
};

/**
 * manual — full scan triggered via API.
 */
const manualHandler: JobHandler = async (job) => {
  if (!job.walletId || !isValidChain(job.chain)) {
    console.warn('[manual] invalid job, skipping');
    return;
  }
  console.log(`[manual] full scan — wallet ${job.walletId} on ${job.chain}`);
  const scanner = new WalletScanner();
  await scanner.scanWallet(job.walletId, job.chain);
};

export const jobRegistry: Record<JobType, JobHandler> = {
  backfill: backfillHandler,
  delta: deltaHandler,
  manual: manualHandler,
  /**
   * deep_scan — fetches ALL transactions for a partial wallet (no window limit).
   * Auto-enqueued by WalletScanner when partial=true.
   */
  deep_scan: async (job) => {
    if (!job.walletId) {
      console.warn('[deep_scan] Job missing walletId, skipping');
      return;
    }
    if (!isValidChain(job.chain)) {
      console.warn(`[deep_scan] Invalid chain "${job.chain}", marking job failed`);
      await markFailed(job.id, `Invalid chain: ${job.chain}`);
      return;
    }
    console.log(`[deep_scan] full tx history — wallet ${job.walletId} on ${job.chain}`);
    const scanner = new WalletScanner(db);
    await scanner.scanWallet(job.walletId, job.chain as ChainSlug, { deepScan: true });
  },
};
