-- Migration 0003: wallet_transactions
-- Apply manually: docker exec ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel -f /dev/stdin < this_file
-- DO NOT run drizzle-kit push — it will drop manual indexes from 0002.

CREATE TABLE IF NOT EXISTS wallet_transactions (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  wallet_id UUID NOT NULL REFERENCES wallets(id),
  chain TEXT NOT NULL,
  tx_hash TEXT NOT NULL,
  block_number BIGINT,
  block_timestamp TIMESTAMPTZ,
  direction TEXT NOT NULL,            -- 'inbound' | 'outbound'
  counterparty_address TEXT NOT NULL,
  value_wei TEXT,
  token_symbol TEXT,
  token_contract_address TEXT,
  is_erc20 BOOLEAN DEFAULT FALSE,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE UNIQUE INDEX IF NOT EXISTS uq_wallet_txs
  ON wallet_transactions(wallet_id, tx_hash, direction);

CREATE INDEX IF NOT EXISTS idx_wallet_txs_wallet_id
  ON wallet_transactions(wallet_id);

-- Used by P2P post-hoc analysis: find all Ethos wallets that transacted with a given address
CREATE INDEX IF NOT EXISTS idx_wallet_txs_counterparty
  ON wallet_transactions(counterparty_address, chain);
