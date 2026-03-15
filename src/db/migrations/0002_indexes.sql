-- Missing indexes identified in performance review
-- Run: docker exec -i ethos-intel-pg psql -U ethos_intel -d ethos_wallet_intel < src/db/migrations/0002_indexes.sql

-- Hot path: getUnscannedWallets / getWalletsDueForRescan
CREATE INDEX IF NOT EXISTS idx_wallets_chain_scanned
  ON wallets(chain, last_scanned_at NULLS FIRST);

-- seed-queue.ts idempotency check + worker dequeue filtering
CREATE INDEX IF NOT EXISTS idx_jobs_wallet_id_status
  ON wallet_scan_jobs(wallet_id, status)
  WHERE wallet_id IS NOT NULL;
