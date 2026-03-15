-- Intel daemon tables: funding hubs + profile risk scores

-- Addresses that funded multiple tracked wallets (potential Sybil coordinators)
CREATE TABLE IF NOT EXISTS funding_hub_signals (
  id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  funder_address        TEXT NOT NULL,
  chain                 TEXT NOT NULL,
  wallets_funded_count  INTEGER NOT NULL DEFAULT 0,
  profiles_funded_count INTEGER NOT NULL DEFAULT 0,
  funded_wallet_ids     JSONB,    -- array of wallet UUIDs
  funded_profile_ids    JSONB,    -- array of profile UUIDs (distinct)
  computed_at           TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT uq_funding_hub_funder_chain UNIQUE (funder_address, chain)
);

CREATE INDEX IF NOT EXISTS idx_funding_hub_wallets_funded ON funding_hub_signals (wallets_funded_count DESC);

-- Aggregated risk score per profile — fully recomputed each daemon run
CREATE TABLE IF NOT EXISTS profile_scores (
  id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  profile_id                UUID NOT NULL REFERENCES profiles(id),
  external_profile_id       INTEGER NOT NULL,
  total_score               NUMERIC(8,2) NOT NULL DEFAULT 0,
  risk_tier                 TEXT NOT NULL DEFAULT 'low',  -- low / medium / high / critical
  wallet_match_count        INTEGER NOT NULL DEFAULT 0,   -- wallet_matches involving this profile's wallets
  profile_match_count       INTEGER NOT NULL DEFAULT 0,   -- distinct profiles matched
  first_funder_match_count  INTEGER NOT NULL DEFAULT 0,   -- first_funder_signals rows
  funding_hub_connection    BOOLEAN NOT NULL DEFAULT FALSE, -- any wallet funded by a hub
  cex_deposit_count         INTEGER NOT NULL DEFAULT 0,
  signal_breakdown          JSONB,                        -- full score workings
  computed_at               TIMESTAMP WITH TIME ZONE DEFAULT now(),
  CONSTRAINT uq_profile_scores_profile UNIQUE (profile_id)
);

CREATE INDEX IF NOT EXISTS idx_profile_scores_tier ON profile_scores (risk_tier);
CREATE INDEX IF NOT EXISTS idx_profile_scores_total ON profile_scores (total_score DESC);
