import type { JobHandler, JobType } from './types.js';
import { FirstFunderScanner } from '../scanner/firstFunderScanner.js';
import { FirstFunderMatcher } from '../matcher/firstFunderMatcher.js';
import { isValidChain } from '../chains/index.js';

const backfillHandler: JobHandler = async (job) => {
  if (!job.walletId) {
    console.warn('[backfill] Job missing walletId, skipping');
    return;
  }

  if (!isValidChain(job.chain)) {
    console.warn(`[backfill] Invalid chain "${job.chain}", skipping`);
    return;
  }

  console.log(`[backfill] scanning wallet ${job.walletId} on ${job.chain}`);
  const scanner = new FirstFunderScanner();
  const result = await scanner.scanWallet(job.walletId, job.chain);
  console.log(`[backfill] result:`, result);

  // After scan, run matcher for this chain to pick up new matches
  const matcher = new FirstFunderMatcher();
  const matchStats = await matcher.detectMatches(job.chain);
  console.log(`[backfill] match stats:`, matchStats);
};

const deltaHandler: JobHandler = async (job) => {
  if (!job.walletId) {
    console.warn('[delta] Job missing walletId, skipping');
    return;
  }

  if (!isValidChain(job.chain)) {
    console.warn(`[delta] Invalid chain "${job.chain}", skipping`);
    return;
  }

  console.log(`[delta] scanning wallet ${job.walletId} on ${job.chain}`);
  const scanner = new FirstFunderScanner();
  const result = await scanner.scanWallet(job.walletId, job.chain);
  console.log(`[delta] result:`, result);

  const matcher = new FirstFunderMatcher();
  const matchStats = await matcher.detectMatches(job.chain);
  console.log(`[delta] match stats:`, matchStats);
};

const newUserHandler: JobHandler = async (job) => {
  if (!job.walletId || !isValidChain(job.chain)) {
    console.warn(`[new_user] invalid job, skipping`);
    return;
  }
  console.log(`[new_user] scanning wallet ${job.walletId} on ${job.chain}`);
  const scanner = new FirstFunderScanner();
  await scanner.scanWallet(job.walletId, job.chain);
};

const manualHandler: JobHandler = async (job) => {
  if (!job.walletId || !isValidChain(job.chain)) {
    console.warn(`[manual] invalid job, skipping`);
    return;
  }
  console.log(`[manual] scanning wallet ${job.walletId} on ${job.chain}`);
  const scanner = new FirstFunderScanner();
  await scanner.scanWallet(job.walletId, job.chain);
};

export const jobRegistry: Record<JobType, JobHandler> = {
  backfill: backfillHandler,
  delta: deltaHandler,
  new_user: newUserHandler,
  manual: manualHandler,
};
