import type { WalletScanJob } from '../db/schema/index.js';

export const JOB_TYPES = ['backfill', 'delta', 'manual', 'deep_scan'] as const;
export type JobType = (typeof JOB_TYPES)[number];

export const JOB_STATUSES = ['pending', 'running', 'done', 'failed'] as const;
export type JobStatus = (typeof JOB_STATUSES)[number];

/** Handler returns optional stats that get persisted to stats_json on completion. */
export type JobHandler = (job: WalletScanJob) => Promise<Record<string, unknown> | void>;

export { type WalletScanJob };
