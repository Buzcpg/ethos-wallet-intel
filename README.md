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
