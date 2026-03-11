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
