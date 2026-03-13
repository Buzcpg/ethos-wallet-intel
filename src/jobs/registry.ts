import type { JobHandler, JobType } from './types.js';
import type { ChainSlug } from '../chains/index.js';
import { WalletScanner } from '../scanner/walletScanner.js';
import { isValidChain } from '../chains/index.js';
import { enqueueJob } from '../queue/index.js';

// ---------------------------------------------------------------------------
// Handlers — each returns scan stats for persistence to stats_json
// ---------------------------------------------------------------------------

const backfillHandler: JobHandler = async (job) => {
  if (!job.walletId) throw new Error('Job missing walletId');
  if (!isValidChain(job.chain)) throw new Error(`Invalid chain: ${job.chain}`);

  const scanner = new WalletScanner();
  const result = await scanner.scanWallet(job.walletId, job.chain);

  if (result.error) throw new Error(result.error);

  // Auto-enqueue deep_scan for wallets where windowed scan was truncated
  if (result.partial) {
    await enqueueJob(job.walletId, job.chain as ChainSlug, 'deep_scan').catch((err: unknown) => {
      console.warn(`[backfill] failed to enqueue deep_scan for ${job.walletId}:`, err);
    });
  }

  return result as unknown as Record<string, unknown>;
};

const deltaHandler: JobHandler = async (job) => {
  if (!job.walletId) throw new Error('Job missing walletId');
  if (!isValidChain(job.chain)) throw new Error(`Invalid chain: ${job.chain}`);

  const scanner = new WalletScanner();
  const result = await scanner.deltaScanWallet(job.walletId, job.chain);
  return result as unknown as Record<string, unknown>;
};

const manualHandler: JobHandler = async (job) => {
  if (!job.walletId) throw new Error('Job missing walletId');
  if (!isValidChain(job.chain)) throw new Error(`Invalid chain: ${job.chain}`);

  const scanner = new WalletScanner();
  const result = await scanner.scanWallet(job.walletId, job.chain);
  return result as unknown as Record<string, unknown>;
};

const deepScanHandler: JobHandler = async (job) => {
  if (!job.walletId) throw new Error('Job missing walletId');
  if (!isValidChain(job.chain)) throw new Error(`Invalid chain: ${job.chain}`);

  const scanner = new WalletScanner();
  const result = await scanner.scanWallet(job.walletId, job.chain as ChainSlug, { deepScan: true });
  return result as unknown as Record<string, unknown>;
};

export const jobRegistry: Record<JobType, JobHandler> = {
  backfill: backfillHandler,
  delta: deltaHandler,
  manual: manualHandler,
  deep_scan: deepScanHandler,
};
