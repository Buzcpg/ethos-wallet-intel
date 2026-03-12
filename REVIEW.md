# Code Review — ethos-wallet-intel

**Reviewer:** Claude Sonnet 4.6
**Date:** 2026-03-12
**Branch:** `fix/code-review-pass`
**Scope:** All TypeScript source files under `src/`

---

## Critical Issues (bugs, data loss risk, security)

### C1 — Permanent skip of deposit/P2P data for wallets whose first scan partially failed
**File:** `src/scanner/walletScanner.ts:113–128`

```ts
const alreadyFullyScanned =
  existingSignal.length > 0 && wallet.lastScannedAt !== null;

if (alreadyFullyScanned) {
  return {
    ...
    depositEvidenceFound: 0,  // ← returned as zero even if data was never collected
    p2pMatchesFound: 0,
    ...
  };
}
```

If the first scan saved a `firstFunderSignal` and updated `lastScannedAt` but the deposit or P2P extractors errored, every subsequent call to `scanWallet` will short-circuit here and the deposit/P2P data will **never be populated**. The wallet is permanently marked as complete based solely on the first-funder signal.

**Fix:** Track per-extractor completion (e.g., separate `lastDepositScannedAt` columns, or remove this early exit entirely and rely on the idempotency already built into each individual extractor).

---

### C2 — No authentication on any API route
**File:** `src/api/index.ts`, all `src/api/routes/*.ts`

All endpoints — including `POST /sync/profiles` (full DB overwrite), `POST /scanner/full-scan-batch`, `POST /rescan/schedule?force=true`, and `POST /rescan/sync-profiles` — are completely unauthenticated. `WEBHOOK_SECRET` is defined in `src/config/env.ts:10` but never referenced anywhere in the codebase.

**Fix:** At minimum, add a bearer-token middleware that validates `Authorization: Bearer <WEBHOOK_SECRET>` on all non-health routes before this service is network-accessible.

---

### C3 — Stale `running` jobs after worker crash cause permanent queue blockage
**File:** `src/queue/index.ts:28–45`

`dequeueNext` sets `status = 'running'` via `FOR UPDATE SKIP LOCKED`. If the worker process crashes or is OOM-killed mid-job, those jobs remain `running` indefinitely and are never retried. With `SKIP LOCKED`, subsequent worker polls will skip them forever.

**Fix:** Add a stale-job reset query (e.g., reset jobs in `running` state whose `started_at` is older than a configurable timeout back to `pending`). Run this at worker startup and periodically.

---

### C4 — `block_number: null` from Blockscout stored as block 0
**File:** `src/chains/transactionFetcher.ts:136`

```ts
blockNumber: BigInt(tx.block_number ?? 0),
```

Blockscout returns `block_number: null` for pending (unconfirmed) transactions. These are stored with `blockNumber = 0n`. A `blockNumber` of 0 would be interpreted as the genesis block, corrupting `lastScannedBlock` and causing incorrect delta scan ranges. The same issue exists in `normaliseTokenTransfer` (line 150) and in the delta scan filter (line 344).

**Fix:** Skip transactions where `block_number` is null (they have not been confirmed), or filter them out before processing.

---

### C5 — `listAllProfiles` can infinite-loop if API returns empty page with nonzero `total`
**File:** `src/ethos/client.ts:121–143`

```ts
while (offset < total) {
  const json = ... as ProfilesPageResponse;
  total = json.total;
  for (const profile of json.values) { yield profile; }
  offset += limit;
  // No check: if json.values is empty but total > offset, loop never terminates
}
```

If the Ethos API returns `total: 50000` but an empty `values` array on any page (network glitch, server-side bug), the loop advances `offset` but yields nothing, and will loop until `offset` finally exceeds `total`. With `limit = 1000` and `total = 50000`, that's 50 unnecessary API calls after the first empty page, but if `total` is also updated to a higher value each round, it never terminates.

**Fix:** Add `if (json.values.length === 0) break;` after yielding.

---

## High Priority (error handling, type safety)

### H1 — Worker processes exactly one job per poll interval (no concurrency)
**File:** `src/workers/index.ts:14–44`

`processTick` dequeues one job, awaits it to completion, then schedules itself again after `WORKER_POLL_INTERVAL_MS`. A single wallet scan on Ethereum (window fetch + deposit + P2P) can take 5–30 seconds. With `WORKER_POLL_INTERVAL_MS=5000`, the effective throughput ceiling is ~1 job/5s even when hundreds are queued.

**Fix:** Process N jobs concurrently per tick (bounded by a configurable concurrency setting), or use a producer/consumer pattern with a fixed-size worker pool.

---

### H2 — `upsertWallets` performs N × 6 sequential DB round-trips
**File:** `src/sync/profileSync.ts:200–249`

For every address × chain combination, there is one `INSERT ... ON CONFLICT DO UPDATE ... RETURNING`. For a profile with 3 addresses × 6 chains = 18 sequential DB calls. During a full sync of 50,000 profiles this becomes ~900,000 individual statements, severely bottlenecking throughput.

**Fix:** Collect all `(address, chain)` value tuples and issue a single bulk `INSERT ... ON CONFLICT DO UPDATE` with a `RETURNING xmax` to detect new rows.

---

### H3 — `DepositScanner` N+1 idempotency queries
**File:** `src/scanner/depositScanner.ts:62–104`

For each outbound transaction touching a CEX address, a separate `SELECT ... LIMIT 1` is issued to check for existing evidence before inserting. For a wallet with 100 CEX deposits, this is 100 selects + 100 inserts = 200 DB round-trips in one scan.

**Fix:** Collect all candidate `txHash` values up-front, do a single `WHERE txHash = ANY(...)` check, then bulk-insert only the missing ones.

---

### H4 — `FirstFunderMatcher` O(N²) query explosion for large funder groups
**File:** `src/matcher/firstFunderMatcher.ts:145–202`

`processWalletPairs` iterates over all unique pairs. For a shared funder that funded 100 wallets, that's 4,950 pairs. Each pair does a `SELECT` for existing wallet match, plus a potential `SELECT + INSERT/UPDATE` for the profile match — ~15,000 DB queries per funder group.

**Fix:** Do bulk existence checks (`WHERE (walletAId, walletBId, matchType, chain, matchKey) IN (...)`) then bulk insert new pairs. Use a single upsert for profile matches.

---

### H5 — `WalletDriftChecker.fetchSupabaseRows` URL can exceed limits with 500 IDs
**File:** `src/sync/walletDriftChecker.ts:159`

```ts
url.searchParams.set('raw_profile_id', `in.(${rawIds.join(',')})`);
```

500 integer IDs in a URL query parameter generates ~2,500 chars. Supabase / PostgREST has a default `max_get_request_size` and some proxies cap URLs at 2,083 or 8,192 bytes. Larger batches will fail silently (non-2xx response → `throw`), halting the entire drift check with an uncaught error.

**Fix:** Paginate `fetchSupabaseRows` in sub-batches of ≤ 100 IDs, or switch to a `POST` with a JSON body filter.

---

### H6 — `WalletDriftChecker` pagination has no `ORDER BY` — can skip or duplicate records
**File:** `src/sync/walletDriftChecker.ts:76–80`

```ts
const knownProfiles = await db
  .select(...)
  .from(profiles)
  .limit(BATCH_SIZE)
  .offset(offset);
```

Without `ORDER BY`, the database is free to return rows in any order, and this order can change between pages if the table is modified (new profiles inserted during the drift check). Records near a page boundary can be skipped or processed twice.

**Fix:** Add `.orderBy(profiles.id)` (or `profiles.externalProfileId`).

---

### H7 — API batch endpoints block the HTTP connection indefinitely
**Files:** `src/api/routes/scanner.ts`, `src/api/routes/sync.ts`, `src/api/routes/rescan.ts`

`POST /sync/profiles`, `POST /scanner/full-scan-batch`, `POST /rescan/delta-batch` all `await` operations that can run for minutes, holding the HTTP connection open. There is no timeout, no streaming, and no way for the client to know progress. A client disconnect mid-operation leaves the operation running but responses are lost.

**Fix:** Return a job/task ID immediately and expose a status polling endpoint, or at minimum add an HTTP request timeout.

---

### H8 — `windowCapped` partial detection uses `&&` instead of `||` — under-reports partial scans
**File:** `src/chains/transactionFetcher.ts:257–260`

```ts
const windowCapped = (!nativeExhaustedFirst || !tokensExhaustedFirst) &&
                     (!nativeExhaustedLast  || !tokensExhaustedLast);
```

This marks `windowCapped` only when **both** the first window AND the last window were not exhausted. If only one window was capped (e.g., the wallet has many old txs so `first` is capped but `last` is exhausted), `windowCapped` will be `false` and the wallet won't be queued for `deep_scan`, even though it has an uncovered gap.

**Fix:** Use `||` — a scan is partial if either window was capped:
```ts
const windowCapped = (!nativeExhaustedFirst || !tokensExhaustedFirst) ||
                     (!nativeExhaustedLast  || !tokensExhaustedLast);
```

---

### H9 — `deep_scan` job handler skips chain validation
**File:** `src/jobs/registry.ts:100–108`

```ts
deep_scan: async (job) => {
  if (!job.walletId || !job.chain) { ... }  // no isValidChain() check
  const scanner = new WalletScanner(db);
  await scanner.scanWallet(job.walletId, job.chain as ChainSlug, { deepScan: true });
},
```

`job.chain` is cast directly to `ChainSlug` without validation. If a malformed chain string reaches the DB (e.g., from a manually inserted row or a bug), `WalletTransactionFetcher` will throw an uncaught error. All other handlers (`backfill`, `delta`, `new_user`, `manual`) call `isValidChain()`.

**Fix:** Add `if (!isValidChain(job.chain)) { ... }` before the scan call, matching the pattern in all other handlers.

---

### H10 — `WEBHOOK_SECRET` is defined but never enforced
**Files:** `src/config/env.ts:10`, all API route files

The env var exists, is validated on startup, but is never read by any middleware or route handler. This creates a false sense of security — operators may set it believing the API is protected.

**Fix:** Implement bearer token middleware in `src/api/index.ts`, or remove the env var if auth is intentionally deferred.

---

## Medium Priority (performance, architecture)

### M1 — Duplicate `sleep`, `fetchWithRetry`, and chain config maps
**Files:** `src/chains/adapters/blockscout.ts`, `src/chains/adapters/etherscan.ts`, `src/chains/transactionFetcher.ts`, `src/labels/labelResolver.ts`

`sleep()` and `fetchWithRetry()` are defined identically in three files. `BLOCKSCOUT_CONFIGS` is duplicated in `transactionFetcher.ts` and `adapters/blockscout.ts` (and a third partial copy in `labelResolver.ts`). Any change must be made in 3 places.

**Fix:** Extract to `src/chains/utils.ts` and `src/chains/config.ts`, import from there.

---

### M2 — `createLimiter` duplicated in client and orchestrator
**Files:** `src/ethos/client.ts:50–77`, `src/scanner/rescanOrchestrator.ts:130–141`

Identical concurrency limiter implementation appears in two places. The orchestrator version is an inline function inside a method.

**Fix:** Export `createLimiter` from `src/ethos/client.ts` (or a shared util) and import it in the orchestrator.

---

### M3 — `EtherscanAdapter.getFirstInboundNativeTx` only fetches 10 transactions
**File:** `src/chains/adapters/etherscan.ts:142`

```ts
offset: '10',  // only 10 txs fetched
```

For a wallet whose first 10 transactions are all outbound, this returns `null` even though the true first inbound tx exists further back. This silently misses the first funder for a class of wallets.

**Fix:** Increase to at least 50–100, or document the deliberate trade-off prominently. The field name `offset` in the Etherscan API is a count (results per page), not a pagination offset.

---

### M4 — `seedFromStaticList` uses SELECT-then-INSERT anti-pattern
**File:** `src/labels/labelResolver.ts:112–130`

For each of the 18+ seed labels, a `SELECT ... LIMIT 1` is issued before conditionally inserting. This is 18–36 sequential DB calls on every startup.

**Fix:** Use a single `INSERT ... ON CONFLICT (chain, address) DO NOTHING` for all rows, leveraging the existing `chainAddressUnique` constraint.

---

### M5 — `RescanOrchestrator.getDueCounts` fetches all IDs to count them
**File:** `src/scanner/rescanOrchestrator.ts:267–278`

```ts
const ids = await this.walletScanner.getWalletsDueForRescan(chain, env.RESCAN_INTERVAL_HOURS);
result[chain] = ids.length;
```

`getWalletsDueForRescan` fetches up to 10,000 wallet ID strings just to count them. This is called for 6 chains.

**Fix:** Add a `countWalletsDueForRescan(chain, intervalHours)` method that issues a `SELECT COUNT(*)` query.

---

### M6 — `upsertProfiles` iterates with sequential inserts
**File:** `src/sync/profileSync.ts:146–168`

One `INSERT ... ON CONFLICT DO UPDATE` per profile. For batches of 100 profiles this is 100 sequential round-trips.

**Fix:** Use Drizzle's batch insert or collect values and issue a single statement with multiple value tuples.

---

### M7 — `rescanOrchestrator.ts` `newWallets` count is always incorrect
**File:** `src/scanner/rescanOrchestrator.ts:172`

```ts
newWallets += data.allAddresses.length * 6; // 6 chains per address
```

This multiplies the address count by 6 regardless of whether those wallets were truly new or already in the DB (the actual upsert in `syncProfile` handles de-duplication). The `newWallets` value in the return struct and in logs is therefore systematically over-counted.

**Fix:** Return the actual count from `syncProfile` (which in turn comes from `upsertWallets`).

---

### M8 — `ProfileSyncService.processBatch` does not catch per-profile errors on profile upsert
**File:** `src/sync/profileSync.ts:110–114`

```ts
if (!dryRun) {
  await this.upsertProfiles(batch);  // ← throws for entire batch on any profile failure
}
```

If `upsertProfiles` throws (e.g., DB constraint violation on one profile), the entire batch fails and none of the wallets in that batch are processed. The per-profile `try/catch` on line 117 only protects the wallet upsert step.

**Fix:** Upsert profiles individually within the try/catch, or collect errors and continue.

---

### M9 — Blockscout `fetchBlockscoutPage` URL reconstruction is fragile
**File:** `src/chains/transactionFetcher.ts:170–178`

The next-page URL is reconstructed by stripping `next_page_params` keys from the existing query string using string splitting. If the API ever adds a `next_page_params` key that matches an existing fixed param (like `limit` or `sort`), the fixed param would be dropped.

**Fix:** Build next-page URLs from scratch using only the base path and the `next_page_params` object, appending fixed params explicitly.

---

### M10 — `walletScanJobs` has no index on `status` column
**File:** `src/db/schema/jobs.ts`

`dequeueNext` queries `WHERE status = 'pending' ORDER BY created_at ASC LIMIT 1`. Without an index on `status` (or a composite index on `(status, created_at)`), this is a full table scan. As the jobs table grows (especially with many `done` rows), this will become a bottleneck.

**Fix:** Add `index('idx_jobs_status_created').on(table.status, table.createdAt)` in the table definition.

---

### M11 — Etherscan HTML scraping is fragile and potentially against ToS
**File:** `src/scanner/firstFunderScanner.ts:49–78`

`scrapeFundedBy` fetches and parses Etherscan HTML with a regex. This will silently break on any Etherscan UI update. The `User-Agent` mimics a browser explicitly to avoid bot blocking, which may be against Etherscan's Terms of Service.

**Fix:** Use the Etherscan API's `txlistinternal` or the official `getfundedbytxhash` endpoint if available, or use Blockscout's `transactions` endpoint which returns structured data. If Etherscan HTML scraping is kept, add explicit failure alerting rather than silent fallback.

---

### M12 — `blockTimestamp` is not validated for `Invalid Date`
**Files:** `src/chains/transactionFetcher.ts:131`, `src/chains/adapters/blockscout.ts:89`

```ts
blockTimestamp: new Date(tx.timestamp),
```

If the API returns a malformed timestamp string, `new Date(...)` produces `Invalid Date`. This is silently stored in the DB (PostgreSQL will error on `NaN` as a timestamp), causing the DB write to fail and the error to bubble up — but without a clear error message pointing to the timestamp.

**Fix:** Parse and validate: `const ts = new Date(tx.timestamp); if (isNaN(ts.getTime())) throw new Error(...)`.

---

### M13 — Redundant SIGTERM handler in worker module
**File:** `src/workers/index.ts:70–73`

```ts
process.on('SIGTERM', () => {
  stopWorker();
});
```

`src/index.ts:70` also registers a SIGTERM handler that calls `stopWorker()` plus `closeDb()` then `process.exit(0)`. The worker module's extra handler calls `stopWorker()` redundantly. With two handlers registered, `stopWorker()` is called twice on SIGTERM.

**Fix:** Remove the SIGTERM handler from `src/workers/index.ts`; the main entry point's handler is sufficient.

---

## Low Priority (code quality, naming)

### L1 — Indentation inconsistency in `walletScanner.ts`
**File:** `src/scanner/walletScanner.ts:93–95, 125–127`

```ts
    deepScanReasons: [],
  durationMs: Date.now() - startMs,    // ← wrong indentation
      error: `Wallet ${walletId} not found`,
```

The early-return result objects have inconsistent indentation, suggesting copy-paste. No functional impact, but makes the code harder to read.

---

### L2 — Dead config: `optimism` and `polygon` in `ETHERSCAN_CONFIGS` in `etherscan.ts`
**File:** `src/chains/adapters/etherscan.ts:8–13`

`optimism` and `polygon` are listed in `ETHERSCAN_CONFIGS` but `adapterRegistry.ts` routes them to Blockscout (via `isBlockscoutChain`). The Etherscan config entries for these chains are unreachable dead code.

**Fix:** Remove `optimism` and `polygon` from `etherscan.ts`'s `ETHERSCAN_CONFIGS`.

---

### L3 — Duplicate `/**` JSDoc comment block in `rescanOrchestrator.ts`
**File:** `src/scanner/rescanOrchestrator.ts:84–95`

Lines 84–85 open a JSDoc comment that closes immediately with no content, then lines 86–95 open the real comment. This is a leftover artifact from editing.

**Fix:** Remove the empty comment block (lines 84–85).

---

### L4 — `externalProfileId` stored as `text` despite always being numeric
**File:** `src/db/schema/profiles.ts:6`

The column holds Ethos integer profile IDs as strings (e.g., `"12345"`). The raw SQL in `rescanOrchestrator.ts:107` then has to `CAST(external_profile_id AS INTEGER)` with a regex guard `~ '^[0-9]+$'`. Using an integer column would eliminate the cast, the regex guard, and the risk of non-numeric values.

**Fix:** Change column type to `integer('external_profile_id')`. Requires a migration.

---

### L5 — `wallets.profileId` FK has no `notNull()` constraint
**File:** `src/db/schema/wallets.ts:7`

A wallet without a `profileId` is logically orphaned — it can never contribute to profile matching. All code paths that create wallets set a `profileId`. Making the column not null would catch bugs earlier and remove null guards scattered throughout the code.

---

### L6 — `addresChainUnique` constraint in `wallets.ts` has no explicit name
**File:** `src/db/schema/wallets.ts:18`

```ts
addressChainUnique: unique().on(table.address, table.chain),
```

Drizzle generates a long hashed name. Explicit names make migrations and error messages clearer.

**Fix:** `unique('uq_wallets_address_chain').on(table.address, table.chain)`.

---

### L7 — `enqueueJob` in `queue/index.ts` accepts `chain: string` instead of `ChainSlug`
**File:** `src/queue/index.ts:9`

The function signature accepts `chain: string`, losing type safety at the call site. All callers pass a `ChainSlug`.

**Fix:** Change to `chain: ChainSlug` and import the type.

---

## Test Coverage Gaps

| Area | Gap |
|------|-----|
| `WalletTransactionFetcher` | No tests at all — window fetch, deep scan, delta scan, Etherscan path, gap detection, partial flag, page URL reconstruction all untested |
| `EthosApiClient` | No tests — retry logic, pagination, rate limiting, `fetchAddressesBatch` concurrency untested |
| `LabelResolver` | `seedFromStaticList` idempotency test relies on mock behavior that doesn't reflect real DB; no test for Avalanche (non-Blockscout chain); no retry behavior |
| `WalletDriftChecker` | No tests — newly added class with complex pagination and Supabase interaction, completely untested |
| `RescanOrchestrator.syncNewProfiles` | No test for the probe loop logic, consecutive-miss stopping, or the Supabase fast-path |
| `RescanOrchestrator.syncNewProfilesViaSupabase` | No tests |
| `ProfileSyncService.syncProfile` | Not directly tested (only `runFullSync` and `upsertWallets` are tested) |
| `queue/index.ts` | `enqueueJob`, `dequeueNext`, `markDone`, `markFailed`, `getQueueCounts` have no tests |
| Worker loop | `processTick` behavior, job dispatching, shutdown handling not tested |
| API routes | All HTTP routes are completely untested — no integration or unit tests |
| `BlockscoutAdapter` | `getFirstInboundNativeTx` not tested — different from `WalletTransactionFetcher` |
| `EtherscanAdapter` | `getFirstInboundNativeTx` not tested |
| `FirstFunderMatcher.detectDirectFunder` | Test exists but only verifies the wallet match is created — no profile match verification, no cross-chain test |
| `P2PScanner` — profile match creation | Tests verify wallet matches but none specifically verify profile match insertion and update logic |
| `blockTimestamp` edge cases | No test for null `block_number`, Invalid Date timestamp, or pending transactions |

---

## What Is Done Well

1. **Env validation with Zod** (`src/config/env.ts`) — all env vars validated at startup with clear error messages and safe defaults. This is excellent practice.

2. **Dependency injection throughout** — every class accepts an optional `dbFn?: () => Db` parameter. This makes unit testing with mock databases clean and consistent across all scanners, matchers, and sync services.

3. **Idempotency everywhere** — upserts with `ON CONFLICT DO UPDATE`, existence checks before inserts, and `xmax` detection for new-vs-updated rows. The system handles repeated runs cleanly.

4. **`FOR UPDATE SKIP LOCKED` in `dequeueNext`** (`src/queue/index.ts:29–43`) — correct use of Postgres advisory locking for the job queue. Multiple concurrent workers would not double-process jobs.

5. **Clean chain adapter pattern** — `ChainAdapter` interface, `AdapterRegistry`, and `isBlockscoutChain` predicate make it straightforward to add new chains or swap data providers per chain.

6. **Canonical pair ordering** (smaller UUID first) for `walletMatches` and `profileMatches` — prevents duplicate rows for the same pair and is consistently applied in `firstFunderMatcher.ts`, `p2pScanner.ts`, and schema unique constraints.

7. **`xmax` trick for new-row detection** (`src/sync/profileSync.ts:231`) — detecting `xmax = '0'` from `RETURNING xmax` to identify truly new wallet rows (vs. upserted existing ones) and enqueue `new_user` jobs only for new wallets is clever and avoids an extra round-trip.

8. **Graceful shutdown** (`src/index.ts:62–71`) — SIGTERM/SIGINT clears the cron interval, stops the worker, and closes the DB pool before exiting.

9. **Partial scan strategy with deep_scan fallback** — the window-based scan (first N + last M txs) with gap detection and automatic `deep_scan` job queuing is a pragmatic solution to the rate-limit vs. completeness trade-off.

10. **Test quality** — existing tests are well-structured with proper mock DB implementations using the Drizzle `Symbol.for('drizzle:Name')` pattern, avoiding any live DB dependency. The tests for `FirstFunderScanner`, `DepositScanner`, `P2PScanner`, `FirstFunderMatcher`, `ProfileSyncService`, and `SupabaseSync` are comprehensive for the happy paths they cover.

11. **`WalletScanner` single-fetch architecture** — fetching all transactions once then running all three extractors in parallel (`Promise.all`) is efficient and avoids redundant API calls.
