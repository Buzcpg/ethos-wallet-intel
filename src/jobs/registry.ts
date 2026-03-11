import type { JobHandler, JobType } from './types.js';
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
 * delta — same as backfill (WalletScanner is idempotent).
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

  console.log(`[delta] full scan — wallet ${job.walletId} on ${job.chain}`);
  const scanner = new WalletScanner();
  const result = await scanner.scanWallet(job.walletId, job.chain);
  console.log(`[delta] result:`, result);

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
};
