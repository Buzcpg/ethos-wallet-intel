import { pgTable, text, timestamp, uuid, numeric, jsonb, integer, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { wallets } from './wallets.js';
import { profiles } from './profiles.js';

export const walletMatches = pgTable('wallet_matches', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  walletAId: uuid('wallet_a_id').references(() => wallets.id),
  walletBId: uuid('wallet_b_id').references(() => wallets.id),
  matchType: text('match_type').notNull(),
  chain: text('chain').notNull(),
  matchKey: text('match_key').notNull(),
  score: numeric('score', { precision: 5, scale: 2 }),
  evidenceJson: jsonb('evidence_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`),
}, (table) => ({
  uniqueMatch: unique().on(table.walletAId, table.walletBId, table.matchType, table.chain, table.matchKey),
}));

export const profileMatches = pgTable('profile_matches', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  profileAId: uuid('profile_a_id').references(() => profiles.id),
  profileBId: uuid('profile_b_id').references(() => profiles.id),
  score: numeric('score', { precision: 5, scale: 2 }),
  signalCount: integer('signal_count').default(0),
  status: text('status').default('new'),
  summaryJson: jsonb('summary_json'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`),
}, (table) => ({
  profilePairUnique: unique().on(table.profileAId, table.profileBId),
}));

export const eventOutbox = pgTable('event_outbox', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  eventType: text('event_type').notNull(),
  payloadJson: jsonb('payload_json').notNull(),
  status: text('status').notNull().default('pending'),
  attemptCount: integer('attempt_count').default(0),
  lastAttemptAt: timestamp('last_attempt_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`),
});

export type WalletMatch = typeof walletMatches.$inferSelect;
export type NewWalletMatch = typeof walletMatches.$inferInsert;
export type ProfileMatch = typeof profileMatches.$inferSelect;
export type NewProfileMatch = typeof profileMatches.$inferInsert;
export type EventOutbox = typeof eventOutbox.$inferSelect;
export type NewEventOutbox = typeof eventOutbox.$inferInsert;
