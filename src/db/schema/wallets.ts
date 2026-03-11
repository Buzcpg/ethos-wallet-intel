import { pgTable, text, timestamp, uuid, boolean, bigint, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { profiles } from './profiles.js';

export const wallets = pgTable('wallets', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  profileId: uuid('profile_id').references(() => profiles.id),
  address: text('address').notNull(),
  chain: text('chain').notNull(),
  isPrimary: boolean('is_primary').default(false),
  walletSource: text('wallet_source'),
  firstSeenAt: timestamp('first_seen_at', { withTimezone: true }),
  lastSeenAt: timestamp('last_seen_at', { withTimezone: true }),
  lastScannedBlock: bigint('last_scanned_block', { mode: 'bigint' }),
  lastScannedAt: timestamp('last_scanned_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`),
}, (table) => ({
  addressChainUnique: unique().on(table.address, table.chain),
}));

export type Wallet = typeof wallets.$inferSelect;
export type NewWallet = typeof wallets.$inferInsert;
