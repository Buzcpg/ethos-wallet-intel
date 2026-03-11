import { pgTable, text, timestamp, uuid, numeric, jsonb, unique } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const addressLabels = pgTable('address_labels', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  chain: text('chain').notNull(),
  address: text('address').notNull(),
  labelValue: text('label_value').notNull(),
  labelKind: text('label_kind').notNull(),
  source: text('source').notNull(),
  confidence: numeric('confidence', { precision: 5, scale: 2 }).default('1.0'),
  rawEvidenceJson: jsonb('raw_evidence_json'),
  firstVerifiedAt: timestamp('first_verified_at', { withTimezone: true }).default(sql`now()`),
  lastVerifiedAt: timestamp('last_verified_at', { withTimezone: true }).default(sql`now()`),
}, (table) => ({
  chainAddressUnique: unique().on(table.chain, table.address),
}));

export type AddressLabel = typeof addressLabels.$inferSelect;
export type NewAddressLabel = typeof addressLabels.$inferInsert;
