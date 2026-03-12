# Deployment Complete — ethos-wallet-intel

## Infrastructure Status

### Postgres (Docker)
- **Container:** ethos-intel-pg (postgres:16-alpine)
- **Network binding:** 127.0.0.1:5433 only (loopback — no external exposure)
- **Auth:** scram-sha-256, app user "ethos_intel"
- **Config:** Pi-tuned (512MB shared_buffers, synchronous_commit=off, random_page_cost=3.0)
- **Restart policy:** unless-stopped
- **Health check:** pg_isready every 10s

### Database
- **Status:** All migrations applied (0000_base_schema + 0001_hardening)
- **Tables:** 9 tables created (profiles, wallets, jobs, signals, labels, matches)
- **Indexes:** idx_jobs_status_created on wallet_scan_jobs(status, created_at)
- **Data:** 23,000+ profiles synced, 296,544 wallets

### Service (npm run dev)
- **Port:** 3000 (loopback)
- **Health:** ✅ /health endpoint responding
- **Workers:** Started (concurrency=5, poll interval=5000ms)
- **Crons:** New-profile probe running (every 30 min)
- **Auth:** WEBHOOK_SECRET not set (dev mode — all routes unauthenticated)

## Live Operations

### Current Sync Task
- **Task ID:** 2a8f029a-6259-434c-a154-7223ce945546
- **Endpoint:** POST /rescan/sync-profiles
- **Status:** Running (Supabase pagination in progress)
- **Data ingested so far:** 23,000 profiles, 296,544 wallets
- **Progress:** Reading profiles_v2.userkeys from Supabase, upserting wallets

### API Ready
- **GET /health** — service status
- **POST /sync/profiles** — full Ethos API sync (returns 202 + taskId)
- **POST /rescan/sync-profiles** — Supabase fast-path (returns 202 + taskId)
- **GET /tasks/:taskId** — poll task status

## Security Notes

1. **Postgres port binding:** 127.0.0.1:5433 only (Docker host-level binding, no external routes)
2. **pg_hba.conf:** Local socket allowed (health checks), TCP requires scram-sha-256 auth
3. **Docker network:** Removed `internal: true` to allow host→container port binding
4. **Password:** Stored in postgres/pg_password.secret (gitignored, mode 600)
5. **Environment:** DATABASE_URL updated with generated credentials in .env

## Known Limitations (Dev Mode)

- **WEBHOOK_SECRET:** Not set — all API routes are unauthenticated
  - Before production: set WEBHOOK_SECRET in .env, restart service
- **Schema mismatch fixed:** address_labels and wallet_scan_jobs were manually corrected to match Drizzle definitions
- **Drizzle tooling:** Cannot parse ESM .js imports; base schema applied manually

## Next Steps

1. Let the Supabase sync complete (task still running, monitoring progress)
2. Start scanner workers when ready: GET /rescan/scheduleAllChains?force=true
3. Monitor task completion via GET /tasks/:taskId
4. Check database size and performance on Pi under load

