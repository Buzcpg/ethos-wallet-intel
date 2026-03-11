import { pgTable, text, timestamp, uuid, bigint, numeric, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { wallets } from './wallets.js';

export const firstFunderSignals = pgTable('first_funder_signals', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  walletId: uuid('wallet_id').references(() => wallets.id),
  chain: text('chain').notNull(),
  funderAddress: text('funder_address').notNull(),
  txHash: text('tx_hash').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  blockTimestamp: timestamp('block_timestamp', { withTimezone: true }),
  source: text('source'),
  confidence: numeric('confidence', { precision: 5, scale: 2 }).default('1.0'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`),
}, (table) => ({
  walletChainUnique: unique().on(table.walletId, table.chain),
}));

export const depositTransferEvidence = pgTable('deposit_transfer_evidence', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  walletId: uuid('wallet_id').references(() => wallets.id),
  chain: text('chain').notNull(),
  recipientAddress: text('recipient_address').notNull(),
  txHash: text('tx_hash').notNull(),
  transferType: text('transfer_type').notNull(),
  tokenSymbol: text('token_symbol'),
  amountRaw: text('amount_raw'),
  blockNumber: bigint('block_number', { mode: 'bigint' }).notNull(),
  blockTimestamp: timestamp('block_timestamp', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`),
}, (table) => ({
  txChainUnique: unique().on(table.txHash, table.chain),
}));

export type FirstFunderSignal = typeof firstFunderSignals.$inferSelect;
export type NewFirstFunderSignal = typeof firstFunderSignals.$inferInsert;
export type DepositTransferEvidence = typeof depositTransferEvidence.$inferSelect;
export type NewDepositTransferEvidence = typeof depositTransferEvidence.$inferInsert;
