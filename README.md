# ethos-wallet-intel

Wallet intelligence service for Ethos sybil detection. Analyses EVM wallet activity across multiple chains to identify shared funding sources, deposit address clustering, and inter-wallet relationships that may indicate sybil behaviour.

## Features

- DB-backed job queue for async wallet scanning
- Drizzle ORM with full schema for profiles, wallets, signals, labels, and matches
- Lightweight Hono HTTP API
- Background worker with graceful shutdown
- Zod-validated environment at startup

## Local Setup

```bash
# 1. Clone
git clone https://github.com/Buzcpg/ethos-wallet-intel.git
cd ethos-wallet-intel

# 2. Install dependencies
npm install

# 3. Configure environment
cp .env.example .env
# Edit .env with your DATABASE_URL and other settings

# 4. Run migrations
npm run db:migrate

# 5. Start dev server
npm run dev
```

## Supported Chains

| Slug       | Chain ID | Name          | Native |
|------------|----------|---------------|--------|
| ethereum   | 1        | Ethereum      | ETH    |
| base       | 8453     | Base          | ETH    |
| arbitrum   | 42161    | Arbitrum One  | ETH    |
| optimism   | 10       | Optimism      | ETH    |
| polygon    | 137      | Polygon       | POL    |
| avalanche  | 43114    | Avalanche     | AVAX   |

## API Endpoints

| Method | Path                | Description                          |
|--------|---------------------|--------------------------------------|
| GET    | /health             | Health check                         |
| GET    | /status             | Service status, queue counts, chains |
| GET    | /jobs/:id           | Get a job by ID                      |
| POST   | /jobs/backfill      | Enqueue a backfill job               |
| POST   | /jobs/scan-wallet   | Enqueue a manual wallet scan         |

### POST /jobs/backfill
```json
{ "walletId": "<uuid>", "chain": "ethereum" }
```

### POST /jobs/scan-wallet
```json
{ "walletId": "<uuid>", "chain": "base", "type": "manual" }
```

## Scripts

```bash
npm run dev          # Start with hot reload (tsx watch)
npm run build        # Build to dist/ (tsup)
npm run start        # Run built output
npm run type-check   # TypeScript check (no emit)
npm run test         # Run tests (vitest)
npm run db:generate  # Generate Drizzle migrations
npm run db:migrate   # Apply migrations
npm run db:studio    # Open Drizzle Studio
```

## Architecture

```
src/
├── config/env.ts        # Zod env validation (fails fast on startup)
├── db/
│   ├── client.ts        # pg Pool + Drizzle instance
│   └── schema/          # Full DB schema (profiles, wallets, signals, labels, matches)
├── queue/index.ts       # DB-backed job queue (SELECT FOR UPDATE SKIP LOCKED)
├── workers/index.ts     # Polling worker loop with graceful shutdown
├── jobs/
│   ├── types.ts         # JobType, JobStatus, JobHandler
│   └── registry.ts      # Job type → handler map
├── chains/index.ts      # Supported chain config
├── api/
│   ├── index.ts         # Hono app with middleware
│   └── routes/          # health, status, jobs
└── index.ts             # Entrypoint
```

## Wallet Sync

Ethos profiles and their associated wallet addresses are synced from the [Ethos public API](https://developers.ethos.network/).

The sync creates one `wallets` row per `(address, chain)` pair across all 6 supported chains, using `onConflictDoUpdate` for safe, idempotent upserts.

All requests include `X-Ethos-Client: EthosiansSybilHunter`.

### Sync API Endpoints

| Method | Path                  | Description                              |
|--------|-----------------------|------------------------------------------|
| POST   | /sync/profiles        | Full profile sync (all Ethos profiles)   |
| POST   | /sync/profile/:id     | Single profile sync by Ethos profile ID  |

### POST /sync/profiles

Paginates through all Ethos profiles, fetches wallet addresses for each, and upserts profiles + wallets into the database.

```bash
# Full sync
curl -X POST http://localhost:3000/sync/profiles

# Dry run (counts only, no DB writes)
curl -X POST http://localhost:3000/sync/profiles \
  -H 'Content-Type: application/json' \
  -d '{"dryRun": true}'

# Custom batch size
curl -X POST http://localhost:3000/sync/profiles \
  -H 'Content-Type: application/json' \
  -d '{"batchSize": 50}'
```

Response:
```json
{
  "stats": {
    "profilesProcessed": 42000,
    "profilesUpserted": 38200,
    "walletsUpserted": 229200,
    "walletsSkipped": 3800,
    "errors": 0,
    "durationMs": 94210
  }
}
```

### POST /sync/profile/:id

Syncs a single Ethos profile by its numeric profile ID.

```bash
curl -X POST http://localhost:3000/sync/profile/1234
```

Response:
```json
{ "profileId": 1234, "walletsUpserted": 12 }
```

### Environment Variables

| Variable                | Default | Description                                |
|-------------------------|---------|--------------------------------------------|
| `ETHOS_API_CONCURRENCY` | `20`    | Max concurrent address fetch requests      |
| `ETHOS_API_SLEEP_MS`    | `150`   | Sleep between batches (ms)                 |
| `ETHOS_API_BATCH_SIZE`  | `100`   | Profiles per DB flush batch                |
| `ETHOS_API_MAX_RETRIES` | `3`     | Retries per address fetch (exp. backoff)   |

---

## First Funder Scanner

### How the signal works

The **first funder** is the address that sent the very first inbound native token transaction (ETH, MATIC, AVAX, etc.) to a wallet on a given chain. If two or more Ethos profiles share the same first funder, that is a near-definitive sybil signal — factory wallets are typically funded from a single source.

Two match types are produced:
- **`shared_first_funder`** (score 85) — two wallets were funded by the same external address
- **`direct_funder`** (score 95) — the funder address is itself an Ethos-tracked wallet

### Chain coverage

| Chain     | Adapter      | API key env var        |
|-----------|-------------|------------------------|
| Ethereum  | Etherscan    | `ETHERSCAN_API_KEY`    |
| Optimism  | Etherscan    | `ETHERSCAN_API_KEY`    |
| Polygon   | Etherscan    | `POLYGONSCAN_API_KEY`  |
| Avalanche | Etherscan    | `SNOWTRACE_API_KEY`    |
| Base      | Blockscout   | _(no key needed)_      |
| Arbitrum  | Blockscout   | _(no key needed)_      |

All API keys are optional. Free-tier Etherscan is rate-limited to ~5 req/s; no key means slower but still functional.

### Trigger a scan

```bash
# Scan a single wallet on Ethereum
curl -X POST http://localhost:3000/scanner/scan-wallet \
  -H 'Content-Type: application/json' \
  -d '{"walletId": "<uuid>", "chain": "ethereum"}'

# Scan the next 100 unscanned wallets on Base
curl -X POST http://localhost:3000/scanner/scan-batch \
  -H 'Content-Type: application/json' \
  -d '{"chain": "base", "limit": 100}'

# Detect matches for all chains after scanning
curl -X POST http://localhost:3000/scanner/detect-matches \
  -H 'Content-Type: application/json' \
  -d '{}'

# Detect matches for a single chain
curl -X POST http://localhost:3000/scanner/detect-matches \
  -H 'Content-Type: application/json' \
  -d '{"chain": "ethereum"}'
```

### Coverage stats

```bash
curl http://localhost:3000/scanner/stats
```

Response:
```json
{
  "chains": {
    "ethereum": {
      "totalWallets": 240000,
      "scanned": 12000,
      "withFirstFunder": 9500,
      "matches": 143
    },
    "base": { ... },
    ...
  }
}
```

### Scanner environment variables

| Variable               | Default | Description                                        |
|------------------------|---------|----------------------------------------------------|
| `ETHERSCAN_API_KEY`    | _(none)_ | Etherscan API key (ETH + Optimism)                |
| `POLYGONSCAN_API_KEY`  | _(none)_ | Polygonscan key; falls back to `ETHERSCAN_API_KEY` |
| `SNOWTRACE_API_KEY`    | _(none)_ | Snowtrace key for Avalanche                        |
| `SCANNER_CONCURRENCY`  | `5`     | Parallel wallet scans per batch                    |
| `SCANNER_DELAY_MS`     | `200`   | Delay between Etherscan requests (ms)              |

---

## Full Wallet Scan — Three-Signal Unified Pass (M4)

### Architecture

A single `WalletTransactionFetcher` fetches **all** transactions for a wallet once (paginated, native + ERC20). Three signal extractors run in parallel on the same data — no redundant API calls.

```
WalletScanner.scanWallet(walletId, chain)
  └─ WalletTransactionFetcher.fetchAll()          ← one paginated fetch
       ├─ FirstFunderScanner.extractFromTransactions()   Signal 1
       ├─ DepositScanner.scanTransactions()              Signal 2
       └─ P2PScanner.scanTransactions()                  Signal 3
```

### Signal 1 — Shared First Funder (M3 + M4 enhancement)

The first inbound native transaction to the wallet. Extended in M4 with Etherscan HTML cross-verification:

| Chain        | Cross-verification        | Confidence values             |
|--------------|---------------------------|-------------------------------|
| Ethereum     | Etherscan "Funded By" HTML | 1.0 (match), 0.7 (conflict), 0.9 (not found) |
| Avalanche    | Snowtrace HTML (best-effort) | same as Ethereum              |
| Base, Arbitrum, Optimism, Polygon | Blockscout (no funded-by) | 0.9 (computed) |

Source values stored in `first_funder_signals.source`: `etherscan_verified`, `etherscan_conflict`, `computed`.

### Signal 2 — CEX Deposit Address Detection

Identifies outbound transactions to known centralised exchange addresses or deposit wallets.

**Label resolution order:**
1. `address_labels` DB cache — fastest, no network
2. `CEX_SEED_LABELS` in-memory list — bootstrapped on startup
3. Blockscout public tags API — checked for any chains with a Blockscout instance; result cached in DB

Evidence is stored in `deposit_transfer_evidence` (one row per qualifying transaction).

**Seed the label list at startup:**
```bash
curl -X POST http://localhost:3000/labels/seed
```

**Resolve a single address:**
```bash
curl -X POST http://localhost:3000/labels/resolve \
  -H 'Content-Type: application/json' \
  -d '{"address": "0x28c6c06298d514db089934071355e5743bf21d60", "chain": "ethereum"}'
```

### Signal 3 — P2P Direct Wallet Interaction (score: 70)

Detects transactions (in or out) where the counterparty is another Ethos-tracked wallet in the `wallets` table. A single DB query checks all counterparty addresses in bulk.

Match type: `direct_wallet_interaction`, score `70`. Evidence stored in `wallet_matches.evidence_json`.

### API Endpoints (M4)

| Method | Path                        | Description                                  |
|--------|-----------------------------|----------------------------------------------|
| POST   | /scanner/full-scan-wallet   | Full three-signal scan for one wallet        |
| POST   | /scanner/full-scan-batch    | Batch full scan (unscanned wallets)          |
| GET    | /scanner/deposit-stats      | Deposit evidence counts per chain            |
| GET    | /scanner/p2p-stats          | P2P match counts per chain                   |
| POST   | /labels/seed                | Seed CEX labels from static list (idempotent)|
| POST   | /labels/resolve             | Manual label lookup + cache                  |

### Full scan example

```bash
# Full scan — single wallet
curl -X POST http://localhost:3000/scanner/full-scan-wallet \
  -H 'Content-Type: application/json' \
  -d '{"walletId": "<uuid>", "chain": "ethereum"}'

# Response
{
  "walletId": "...",
  "chain": "ethereum",
  "transactionsFetched": 342,
  "firstFunderFound": true,
  "depositEvidenceFound": 3,
  "p2pMatchesFound": 1,
  "durationMs": 1842
}

# Batch scan — next 50 unscanned wallets on Base
curl -X POST http://localhost:3000/scanner/full-scan-batch \
  -H 'Content-Type: application/json' \
  -d '{"chain": "base", "limit": 50}'

# Deposit stats
curl http://localhost:3000/scanner/deposit-stats

# P2P stats
curl http://localhost:3000/scanner/p2p-stats
```

### Signal score summary

| Signal                   | Match type                    | Score |
|--------------------------|-------------------------------|-------|
| Shared first funder      | `shared_first_funder`         | 85    |
| Direct funder            | `direct_funder`               | 95    |
| P2P wallet interaction   | `direct_wallet_interaction`   | 70    |

---

## Milestone 5 — Delta Rescans

Keeps wallet intelligence fresh without re-fetching full history. When a wallet has already been scanned, we know its `last_scanned_block`. A delta rescan only fetches transactions *after* that block, runs them through all three signal extractors, and updates the wallet's scan state.

### How it works

1. **Delta fetch** — `WalletTransactionFetcher.fetchAll()` now accepts `opts.fromBlock`. For Blockscout chains, it fetches ascending from `fromBlock` (up to `SCAN_MAX_PAGES_DELTA` pages). For Etherscan/Snowtrace, it passes `startblock` directly. The window strategy is skipped entirely.

2. **`WalletScanner.deltaScanWallet(walletId, chain)`** — Loads `lastScannedBlock` from DB. If null (never scanned), falls back to a full scan. Otherwise fetches only new txs, runs all three extractors, updates scan state.

3. **Rescan orchestrator** — Nightly scheduler that queries wallets overdue for a rescan and enqueues `delta` jobs.

4. **New-user fast path** — When a new wallet is added during profile sync, a `new_user` scan job is enqueued immediately (no wait for the nightly orchestrator).

### How to trigger

```bash
# Delta scan a single wallet
curl -X POST http://localhost:3000/rescan/delta-wallet \
  -H 'Content-Type: application/json' \
  -d '{"walletId": "<uuid>", "chain": "ethereum"}'

# Delta batch — scan next 50 due wallets on Base
curl -X POST http://localhost:3000/rescan/delta-batch \
  -H 'Content-Type: application/json' \
  -d '{"chain": "base", "limit": 50}'

# Schedule delta jobs for all overdue wallets (one chain)
curl -X POST http://localhost:3000/rescan/schedule \
  -H 'Content-Type: application/json' \
  -d '{"chain": "ethereum"}'

# Schedule all chains at once
curl -X POST http://localhost:3000/rescan/schedule \
  -H 'Content-Type: application/json' \
  -d '{}'

# Force rescan regardless of last_scanned_at
curl -X POST http://localhost:3000/rescan/schedule \
  -H 'Content-Type: application/json' \
  -d '{"force": true}'

# Trigger profile sync delta (picks up new wallets + enqueues new_user scans)
curl -X POST http://localhost:3000/rescan/sync-profiles

# Count wallets due for rescan per chain
curl http://localhost:3000/rescan/due-count
```

### New API routes (M5)

| Method | Path                        | Description                                        |
|--------|-----------------------------|----------------------------------------------------|
| POST   | /rescan/delta-wallet        | Delta scan one wallet (since lastScannedBlock)     |
| POST   | /rescan/delta-batch         | Delta scan next N due wallets on a chain           |
| POST   | /rescan/schedule            | Enqueue delta jobs for all overdue wallets         |
| POST   | /rescan/sync-profiles       | Trigger profile sync + new-user fast path          |
| GET    | /rescan/due-count           | Count wallets due for rescan per chain             |

### Configuration

| Env var                  | Default | Description                                              |
|--------------------------|---------|----------------------------------------------------------|
| `RESCAN_INTERVAL_HOURS`  | `24`    | Hours between rescans; wallets within window are skipped |
| `SCAN_MAX_PAGES_DELTA`   | `10`    | Max pages to fetch in a delta scan (new txs only)        |

### New-user fast path

When `ProfileSyncService.upsertWallets()` inserts a **new** wallet row (i.e., the address+chain pair didn't previously exist), it immediately enqueues a `new_user` scan job. This ensures fresh wallets are scanned within the next worker poll cycle, without waiting for the nightly `scheduleRescan`.

Detection uses PostgreSQL's `xmax` system column: `xmax = 0` means the row was just inserted (new); `xmax > 0` means it was updated (existing wallet).
