-- Migration: fix/full-hardening
-- Generated manually (drizzle-kit cannot parse ESM .js imports)
-- Run with: psql $DATABASE_URL -f src/db/migrations/0001_hardening.sql

-- L4: Change external_profile_id from text to integer.
--     All existing values must be numeric strings; the USING clause handles the cast.
ALTER TABLE profiles
  ALTER COLUMN external_profile_id TYPE integer
  USING external_profile_id::integer;

-- L5: Make wallets.profile_id NOT NULL.
--     Ensure no orphaned wallet rows exist before running:
--       SELECT COUNT(*) FROM wallets WHERE profile_id IS NULL;
ALTER TABLE wallets
  ALTER COLUMN profile_id SET NOT NULL;

-- L6: Rename the Drizzle-generated unique constraint to a stable explicit name.
--     The auto-generated name varies by Drizzle version; replace <generated_name> if needed.
DO $$
DECLARE
  constraint_name text;
BEGIN
  SELECT conname INTO constraint_name
  FROM pg_constraint
  WHERE conrelid = 'wallets'::regclass
    AND contype = 'u'
    AND array_length(conkey, 1) = 2;

  IF constraint_name IS NOT NULL AND constraint_name != 'uq_wallets_address_chain' THEN
    EXECUTE format('ALTER TABLE wallets RENAME CONSTRAINT %I TO uq_wallets_address_chain', constraint_name);
  END IF;
END $$;

-- M10: Index to speed up worker dequeue (WHERE status = 'pending' ORDER BY created_at).
CREATE INDEX IF NOT EXISTS idx_jobs_status_created
  ON wallet_scan_jobs(status, created_at);
