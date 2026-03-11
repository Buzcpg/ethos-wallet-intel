import type { JobHandler, JobType } from './types.js';

const backfillHandler: JobHandler = async (job) => {
  console.log(`[backfill] started for wallet ${job.walletId} on chain ${job.chain}`);
};

const deltaHandler: JobHandler = async (job) => {
  console.log(`[delta] delta scan for wallet ${job.walletId} on chain ${job.chain}`);
};

const newUserHandler: JobHandler = async (job) => {
  console.log(`[new_user] new_user scan for wallet ${job.walletId} on chain ${job.chain}`);
};

const manualHandler: JobHandler = async (job) => {
  console.log(`[manual] manual scan requested for wallet ${job.walletId} on chain ${job.chain}`);
};

export const jobRegistry: Record<JobType, JobHandler> = {
  backfill: backfillHandler,
  delta: deltaHandler,
  new_user: newUserHandler,
  manual: manualHandler,
};
