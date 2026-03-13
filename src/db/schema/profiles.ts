import { pgTable, text, timestamp, uuid, integer } from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

export const profiles = pgTable('profiles', {
  id: uuid('id').primaryKey().default(sql`gen_random_uuid()`),
  // L4: integer — Ethos profile IDs are always numeric; eliminates CAST in raw SQL
  externalProfileId: integer('external_profile_id').unique().notNull(),
  slug: text('slug'),
  displayName: text('display_name'),
  primaryAddress: text('primary_address'),
  status: text('status').default('active'),
  createdAt: timestamp('created_at', { withTimezone: true }).default(sql`now()`),
  updatedAt: timestamp('updated_at', { withTimezone: true }).default(sql`now()`),
});

export type Profile = typeof profiles.$inferSelect;
export type NewProfile = typeof profiles.$inferInsert;
