import type { WalletScanJob } from '../db/schema/index.js';

export const JOB_TYPES = ['backfill', 'delta', 'manual', 'deep_scan'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

export type JobHandler = (job: WalletScanJob) => Promise<void>;

export interface EnqueueJobOptions {
  fromBlock?: bigint;
  toBlock?: bigint;
}

export { type WalletScanJob };
