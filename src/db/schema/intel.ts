import { pgTable, text, timestamp, uuid, integer, numeric, jsonb, boolean, unique, index } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';
import { profiles } from './profiles.js';

export const fundingHubSignals = pgTable('funding_hub_signals', {
  id:                  uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  funderAddress:       text('funder_address').notNull(),
  chain:               text('chain').notNull(),
  walletsFundedCount:  integer('wallets_funded_count').notNull().default(0),
  profilesFundedCount: integer('profiles_funded_count').notNull().default(0),
  fundedWalletIds:     jsonb('funded_wallet_ids'),
  fundedProfileIds:    jsonb('funded_profile_ids'),
  computedAt:          timestamp('computed_at', { withTimezone: true }).default(sql`now()`),
}, (t) => ({
  uqFunderChain: unique('uq_funding_hub_funder_chain').on(t.funderAddress, t.chain),
}));

export const profileScores = pgTable('profile_scores', {
  id:                     uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  profileId:              uuid('profile_id').references(() => profiles.id).notNull(),
  externalProfileId:      integer('external_profile_id').notNull(),
  totalScore:             numeric('total_score', { precision: 8, scale: 2 }).notNull().default('0'),
  riskTier:               text('risk_tier').notNull().default('low'),
  walletMatchCount:       integer('wallet_match_count').notNull().default(0),
  profileMatchCount:      integer('profile_match_count').notNull().default(0),
  firstFunderMatchCount:  integer('first_funder_match_count').notNull().default(0),
  fundingHubConnection:   boolean('funding_hub_connection').notNull().default(false),
  cexDepositCount:        integer('cex_deposit_count').notNull().default(0),
  signalBreakdown:        jsonb('signal_breakdown'),
  computedAt:             timestamp('computed_at', { withTimezone: true }).default(sql`now()`),
}, (t) => ({
  uqProfile: unique('uq_profile_scores_profile').on(t.profileId),
}));

export type FundingHubSignal = typeof fundingHubSignals.$inferSelect;
export type ProfileScore     = typeof profileScores.$inferSelect;
