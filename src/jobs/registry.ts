import type { JobHandler, JobType } from './types.js';
import type { ChainSlug } from '../chains/index.js';
import { db } from '../db/client.js';
import { WalletScanner } from '../scanner/walletScanner.js';
import { FirstFunderScanner } from '../scanner/firstFunderScanner.js';
import { FirstFunderMatcher } from '../matcher/firstFunderMatcher.js';
import { LabelResolver } from '../labels/labelResolver.js';
import { isValidChain } from '../chains/index.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

/**
 * backfill — full three-signal scan via WalletScanner.
 * Single tx fetch, all extractors in parallel.
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

  // Run first-funder matcher after scan to pick up new matches
  const matcher = new FirstFunderMatcher();
  const matchStats = await matcher.detectMatches(job.chain);
  console.log(`[backfill] match stats:`, matchStats);
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

  // Re-run matcher to pick up any new signals discovered in delta
  const matcher = new FirstFunderMatcher();
  const matchStats = await matcher.detectMatches(job.chain);
  console.log(`[delta] match stats:`, matchStats);
};

/**
 * new_user — full scan for a newly synced wallet.
 */
const newUserHandler: JobHandler = async (job) => {
  if (!job.walletId || !isValidChain(job.chain)) {
    console.warn('[new_user] invalid job, skipping');
    return;
  }
  console.log(`[new_user] full scan — wallet ${job.walletId} on ${job.chain}`);
  const scanner = new WalletScanner();
  await scanner.scanWallet(job.walletId, job.chain);
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
  new_user: newUserHandler,
  manual: manualHandler,
  /**
   * deep_scan — fetches ALL transactions for a partial wallet (no window limit).
   * Runs with DEEP_SCAN_PAGE_DELAY_MS between pages to stay within rate limits.
   * Only queued for wallets where a previous scan returned partial=true.
   */
  deep_scan: async (job) => {
    if (!job.walletId || !job.chain) {
      console.warn('[deep_scan] invalid job, skipping');
      return;
    }
    console.log(`[deep_scan] full tx history — wallet ${job.walletId} on ${job.chain}`);
    const scanner = new WalletScanner(db);
    await scanner.scanWallet(job.walletId, job.chain as ChainSlug, { deepScan: true });
  },
};
