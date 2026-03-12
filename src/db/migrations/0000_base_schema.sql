-- Base schema: all tables, constraints, and indexes
-- Generated from Drizzle schema files

-- Profiles
CREATE TABLE IF NOT EXISTS "profiles" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "external_profile_id" integer UNIQUE NOT NULL,
  "display_name" text,
  "slug" text,
  "status" text,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now()
);

-- Wallets
CREATE TABLE IF NOT EXISTS "wallets" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "profile_id" uuid NOT NULL REFERENCES "profiles"("id"),
  "address" text NOT NULL,
  "chain" text NOT NULL,
  "is_primary" boolean DEFAULT false,
  "wallet_source" text,
  "first_seen_at" timestamptz,
  "last_seen_at" timestamptz,
  "last_scanned_block" bigint,
  "last_scanned_at" timestamptz,
  "created_at" timestamptz DEFAULT now(),
  CONSTRAINT "uq_wallets_address_chain" UNIQUE ("address", "chain")
);

-- Wallet scan jobs
CREATE TABLE IF NOT EXISTS "wallet_scan_jobs" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "wallet_id" uuid NOT NULL REFERENCES "wallets"("id"),
  "chain" text NOT NULL,
  "job_type" text NOT NULL,
  "status" text DEFAULT 'pending' NOT NULL,
  "payload" jsonb DEFAULT '{}'::jsonb,
  "result" jsonb,
  "error" text,
  "attempts" integer DEFAULT 0,
  "started_at" timestamptz,
  "completed_at" timestamptz,
  "created_at" timestamptz DEFAULT now()
);

CREATE INDEX IF NOT EXISTS "idx_jobs_status_created" ON "wallet_scan_jobs"("status", "created_at");

-- First funder signals
CREATE TABLE IF NOT EXISTS "first_funder_signals" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "wallet_id" uuid NOT NULL REFERENCES "wallets"("id"),
  "funder_address" text NOT NULL,
  "chain" text NOT NULL,
  "block_number" bigint,
  "block_timestamp" timestamptz,
  "tx_hash" text,
  "confidence" numeric,
  "verification_source" text,
  "created_at" timestamptz DEFAULT now(),
  CONSTRAINT "uq_first_funder_wallet_chain" UNIQUE ("wallet_id", "chain")
);

-- Deposit transfer evidence
CREATE TABLE IF NOT EXISTS "deposit_transfer_evidence" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "wallet_id" uuid NOT NULL REFERENCES "wallets"("id"),
  "deposit_address" text NOT NULL,
  "deposit_label" text,
  "chain" text NOT NULL,
  "tx_hash" text NOT NULL,
  "block_number" bigint,
  "block_timestamp" timestamptz,
  "value_wei" text,
  "token_symbol" text,
  "created_at" timestamptz DEFAULT now(),
  CONSTRAINT "uq_deposit_evidence_tx_hash" UNIQUE ("tx_hash", "chain")
);

-- Address labels (CEX deposit addresses)
CREATE TABLE IF NOT EXISTS "address_labels" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "address" text NOT NULL,
  "chain" text NOT NULL,
  "label" text NOT NULL,
  "category" text,
  "source" text,
  "created_at" timestamptz DEFAULT now(),
  CONSTRAINT "uq_address_labels_chain_address" UNIQUE ("chain", "address")
);

-- Wallet matches (sybil links between individual wallets)
CREATE TABLE IF NOT EXISTS "wallet_matches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "wallet_a_id" uuid NOT NULL REFERENCES "wallets"("id"),
  "wallet_b_id" uuid NOT NULL REFERENCES "wallets"("id"),
  "match_type" text NOT NULL,
  "chain" text NOT NULL,
  "match_key" text NOT NULL,
  "confidence" numeric,
  "signal_count" integer DEFAULT 1,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now(),
  CONSTRAINT "uq_wallet_match" UNIQUE ("wallet_a_id", "wallet_b_id", "match_type", "chain", "match_key")
);

-- Profile matches (sybil links between Ethos profiles)
CREATE TABLE IF NOT EXISTS "profile_matches" (
  "id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
  "profile_a_id" uuid NOT NULL REFERENCES "profiles"("id"),
  "profile_b_id" uuid NOT NULL REFERENCES "profiles"("id"),
  "match_type" text NOT NULL,
  "match_key" text NOT NULL,
  "confidence" numeric,
  "signal_count" integer DEFAULT 1,
  "created_at" timestamptz DEFAULT now(),
  "updated_at" timestamptz DEFAULT now(),
  CONSTRAINT "uq_profile_match" UNIQUE ("profile_a_id", "profile_b_id", "match_type", "match_key")
);
