import { pgTable, text, timestamp, uuid, bigint, jsonb, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { wallets } from './wallets.js';

export const walletScanJobs = pgTable('wallet_scan_jobs', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  walletId: uuid('wallet_id').references(() => wallets.id),
  chain: text('chain').notNull(),
  jobType: text('job_type').notNull(),
  status: text('status').notNull().default('pending'),
  startedAt: timestamp('started_at', { withTimezone: true }),
  finishedAt: timestamp('finished_at', { withTimezone: true }),
  fromBlock: bigint('from_block', { mode: 'bigint' }),
  toBlock: bigint('to_block', { mode: 'bigint' }),
  error: text('error'),
  statsJson: jsonb('stats_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`),
});

export type WalletScanJob = typeof walletScanJobs.$inferSelect;
export type NewWalletScanJob = typeof walletScanJobs.$inferInsert;
