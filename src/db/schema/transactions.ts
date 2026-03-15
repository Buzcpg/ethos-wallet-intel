import { pgTable, text, timestamp, uuid, bigint, boolean, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { wallets } from './wallets.js';

export const walletTransactions = pgTable('wallet_transactions', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  walletId: uuid('wallet_id').notNull().references(() => wallets.id),
  chain: text('chain').notNull(),
  txHash: text('tx_hash').notNull(),
  blockNumber: bigint('block_number', { mode: 'bigint' }),
  blockTimestamp: timestamp('block_timestamp', { withTimezone: true }),
  direction: text('direction').notNull(), // 'inbound' | 'outbound'
  counterpartyAddress: text('counterparty_address').notNull(),
  valueWei: text('value_wei'),
  tokenSymbol: text('token_symbol'),
  tokenContractAddress: text('token_contract_address'),
  isErc20: boolean('is_erc20').default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`),
}, (table) => ({
  uniq: unique('uq_wallet_txs').on(table.walletId, table.txHash, table.direction),
}));

export type WalletTransaction = typeof walletTransactions.$inferSelect;
export type NewWalletTransaction = typeof walletTransactions.$inferInsert;
