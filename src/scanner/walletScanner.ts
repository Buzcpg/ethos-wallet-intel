import { eq, and, isNull, lt, or, sql } from 'drizzle-orm';
import { type Db, db as getDb } from '../db/client.js';
import { wallets, firstFunderSignals } from '../db/schema/index.js';
import type { ChainSlug } from '../chains/index.js';
import { WalletTransactionFetcher } from '../chains/transactionFetcher.js';
import { FirstFunderScanner } from './firstFunderScanner.js';
import { DepositScanner } from './depositScanner.js';
import { P2PScanner } from './p2pScanner.js';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface WalletScanOptions {
  /** If true, fetch ALL transactions (overrides window strategy). Used by deep_scan jobs. */
  deepScan?: boolean;
}

export type DeepScanReason =
  | 'gap_in_history'          // first+last window has an uncovered middle
  | 'no_deposits_in_window';  // no CEX deposits found in window — may be in the middle

export interface WalletScanResult {
  walletId: string;
  chain: ChainSlug;
  transactionsFetched: number;
  firstFunderFound: boolean;
  depositEvidenceFound: number;
  p2pMatchesFound: number;
  /** true if a deep_scan job should be queued for this wallet */
  partial: boolean;
  /** reasons why a deep_scan was flagged (empty if partial=false) */
  deepScanReasons: DeepScanReason[];
  durationMs: number;
  error?: string;
}

export interface BatchScanResult {
  chain: ChainSlug;
  scanned: number;
  skipped: number;
  errors: number;
  totalTransactionsFetched: number;
  totalFirstFundersFound: number;
  totalDepositEvidenceFound: number;
  totalP2PMatchesFound: number;
  durationMs: number;
  results: WalletScanResult[];
}

// ---------------------------------------------------------------------------
// WalletScanner
// ---------------------------------------------------------------------------

export class WalletScanner {
  private readonly getDbFn: () => Db;
  private readonly firstFunderScanner: FirstFunderScanner;
  private readonly depositScanner: DepositScanner;
  private readonly p2pScanner: P2PScanner;

  constructor(dbFn?: () => Db) {
    this.getDbFn = dbFn ?? getDb;
    this.firstFunderScanner = new FirstFunderScanner(dbFn);
    this.depositScanner = new DepositScanner(dbFn);
    this.p2pScanner = new P2PScanner(dbFn);
  }

  /**
   * Full scan: fetch all transactions once, run all three extractors in parallel.
   */
  async scanWallet(walletId: string, chain: ChainSlug, opts?: WalletScanOptions): Promise<WalletScanResult> {
    const startMs = Date.now();
    const database = this.getDbFn();

    try {
      // 1. Get wallet address
      const [wallet] = await database
        .select({ address: wallets.address, lastScannedAt: wallets.lastScannedAt })
        .from(wallets)
        .where(eq(wallets.id, walletId))
        .limit(1);

      if (!wallet) {
        return {
          walletId,
          chain,
          transactionsFetched: 0,
          firstFunderFound: false,
          depositEvidenceFound: 0,
          p2pMatchesFound: 0,
          partial: false,
        deepScanReasons: [],
      durationMs: Date.now() - startMs,
          error: `Wallet ${walletId} not found`,
        };
      }

      // 2. Check if all signals already exist (first funder signal as proxy)
      //    Full skip only if first-funder signal exists AND wallet has been scanned.
      //    Deposit + P2P are idempotent internally, so we don't short-circuit them.
      const existingSignal = await database
        .select({ id: firstFunderSignals.id })
        .from(firstFunderSignals)
        .where(
          and(
            eq(firstFunderSignals.walletId, walletId),
            eq(firstFunderSignals.chain, chain),
          ),
        )
        .limit(1);

      const alreadyFullyScanned =
        existingSignal.length > 0 && wallet.lastScannedAt !== null;

      if (alreadyFullyScanned) {
        return {
          walletId,
          chain,
          transactionsFetched: 0,
          firstFunderFound: true,
          depositEvidenceFound: 0,
          p2pMatchesFound: 0,
          partial: false,
        deepScanReasons: [],
      durationMs: Date.now() - startMs,
        };
      }

      // 3. Fetch ALL transactions (single pass)
      const fetcher = new WalletTransactionFetcher(chain);
      const fetchResult = await fetcher.fetchAll(wallet.address);
      const { transactions } = fetchResult;

      // 4. Run all three extractors in parallel on the same data
      const [firstFunderResult, depositResult, p2pResult] = await Promise.all([
        this.firstFunderScanner
          .extractFromTransactions(walletId, wallet.address, transactions, chain)
          .catch((err) => {
            console.error(`[WalletScanner] firstFunder extractor error for ${walletId}:`, err);
            return { walletId, chain, found: false, error: String(err) };
          }),
        this.depositScanner
          .scanTransactions(walletId, transactions, chain)
          .catch((err) => {
            console.error(`[WalletScanner] deposit extractor error for ${walletId}:`, err);
            return { walletId, chain, depositsFound: 0, evidenceIds: [] };
          }),
        this.p2pScanner
          .scanTransactions(walletId, wallet.address, transactions, chain)
          .catch((err) => {
            console.error(`[WalletScanner] p2p extractor error for ${walletId}:`, err);
            return { walletId, chain, matchesFound: 0 };
          }),
      ]);

      // 5. Update wallet scan state
      //    (firstFunderScanner.extractFromTransactions already updates lastScannedAt,
      //     but we ensure it's set even if first funder wasn't found)
      await database
        .update(wallets)
        .set({
          lastScannedAt: new Date(),
          ...(fetchResult.toBlock !== undefined
            ? { lastScannedBlock: fetchResult.toBlock }
            : {}),
        })
        .where(eq(wallets.id, walletId));

      // Determine reasons for deep_scan recommendation
      const deepScanReasons: DeepScanReason[] = [];
      if (fetchResult.partial) {
        deepScanReasons.push('gap_in_history');
      }
      if (fetchResult.partial && depositResult.depositsFound === 0) {
        deepScanReasons.push('no_deposits_in_window');
      }

      // Auto-enqueue deep_scan if needed and this is not already a deep scan
      if (deepScanReasons.length > 0 && !opts?.deepScan) {
        const { enqueueJob } = await import('../queue/index.js');
        await enqueueJob(walletId, chain, 'deep_scan', {}).catch((err: unknown) => {
          console.warn(`[WalletScanner] failed to enqueue deep_scan for ${walletId}:`, err);
        });
        console.info(
          `[WalletScanner] deep_scan queued for ${walletId} on ${chain} — reasons: ${deepScanReasons.join(', ')}`,
        );
      }

      return {
        walletId,
        chain,
        transactionsFetched: fetchResult.totalFetched,
        partial: fetchResult.partial,
        deepScanReasons,
        firstFunderFound: firstFunderResult.found,
        depositEvidenceFound: depositResult.depositsFound,
        p2pMatchesFound: p2pResult.matchesFound,
        durationMs: Date.now() - startMs,
        ...(firstFunderResult.error !== undefined ? { error: firstFunderResult.error } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[WalletScanner] scanWallet error for ${walletId} on ${chain}:`, err);
      return {
        walletId,
        chain,
        transactionsFetched: 0,
        firstFunderFound: false,
        depositEvidenceFound: 0,
        p2pMatchesFound: 0,
        partial: false,
        deepScanReasons: [],
        durationMs: Date.now() - startMs,
        error: message,
      };
    }
  }

  /**
   * Delta scan: fetch only transactions since lastScannedBlock, run all three
   * extractors on the new data, update scan state.
   *
   * Falls back to a full scan if lastScannedBlock is null (wallet never scanned).
   */
  async deltaScanWallet(walletId: string, chain: ChainSlug): Promise<WalletScanResult> {
    const startMs = Date.now();
    const database = this.getDbFn();

    try {
      // 1. Load wallet — need address and lastScannedBlock
      const [wallet] = await database
        .select({
          address: wallets.address,
          lastScannedBlock: wallets.lastScannedBlock,
        })
        .from(wallets)
        .where(eq(wallets.id, walletId))
        .limit(1);

      if (!wallet) {
        return {
          walletId,
          chain,
          transactionsFetched: 0,
          firstFunderFound: false,
          depositEvidenceFound: 0,
          p2pMatchesFound: 0,
          partial: false,
          deepScanReasons: [],
          durationMs: Date.now() - startMs,
          error: `Wallet ${walletId} not found`,
        };
      }

      // 2. If never scanned before, fall through to full scan
      if (wallet.lastScannedBlock === null) {
        console.info(`[WalletScanner] deltaScanWallet: no lastScannedBlock for ${walletId}, falling back to full scan`);
        return this.scanWallet(walletId, chain);
      }

      // 3. Fetch only new transactions since lastScannedBlock + 1
      const fromBlock = BigInt(wallet.lastScannedBlock) + 1n;
      const fetcher = new WalletTransactionFetcher(chain);
      const fetchResult = await fetcher.fetchAll(wallet.address, { fromBlock });

      // 4. Early return if no new transactions
      if (fetchResult.transactions.length === 0) {
        console.info(`[WalletScanner] deltaScanWallet: no new txs for ${walletId} since block ${wallet.lastScannedBlock}`);
        return {
          walletId,
          chain,
          transactionsFetched: 0,
          firstFunderFound: false,
          depositEvidenceFound: 0,
          p2pMatchesFound: 0,
          partial: false,
          deepScanReasons: [],
          durationMs: Date.now() - startMs,
        };
      }

      const { transactions } = fetchResult;

      // 5. Run all three extractors on new transactions
      const [firstFunderResult, depositResult, p2pResult] = await Promise.all([
        this.firstFunderScanner
          .extractFromTransactions(walletId, wallet.address, transactions, chain)
          .catch((err) => {
            console.error(`[WalletScanner] deltaScan firstFunder error for ${walletId}:`, err);
            return { walletId, chain, found: false, error: String(err) };
          }),
        this.depositScanner
          .scanTransactions(walletId, transactions, chain)
          .catch((err) => {
            console.error(`[WalletScanner] deltaScan deposit error for ${walletId}:`, err);
            return { walletId, chain, depositsFound: 0, evidenceIds: [] };
          }),
        this.p2pScanner
          .scanTransactions(walletId, wallet.address, transactions, chain)
          .catch((err) => {
            console.error(`[WalletScanner] deltaScan p2p error for ${walletId}:`, err);
            return { walletId, chain, matchesFound: 0 };
          }),
      ]);

      // 6. Update lastScannedAt and lastScannedBlock to the highest block seen
      await database
        .update(wallets)
        .set({
          lastScannedAt: new Date(),
          ...(fetchResult.toBlock !== undefined
            ? { lastScannedBlock: fetchResult.toBlock }
            : {}),
        })
        .where(eq(wallets.id, walletId));

      return {
        walletId,
        chain,
        transactionsFetched: fetchResult.totalFetched,
        partial: false, // delta scans don't produce partials
        deepScanReasons: [],
        firstFunderFound: firstFunderResult.found,
        depositEvidenceFound: depositResult.depositsFound,
        p2pMatchesFound: p2pResult.matchesFound,
        durationMs: Date.now() - startMs,
        ...(firstFunderResult.error !== undefined ? { error: firstFunderResult.error } : {}),
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[WalletScanner] deltaScanWallet error for ${walletId} on ${chain}:`, err);
      return {
        walletId,
        chain,
        transactionsFetched: 0,
        firstFunderFound: false,
        depositEvidenceFound: 0,
        p2pMatchesFound: 0,
        partial: false,
        deepScanReasons: [],
        durationMs: Date.now() - startMs,
        error: message,
      };
    }
  }

  /**
   * Batch delta scan with configurable concurrency.
   */
  async deltaScanBatch(
    walletIds: string[],
    chain: ChainSlug,
    opts?: { concurrency?: number },
  ): Promise<BatchScanResult> {
    const concurrency = opts?.concurrency ?? env.SCANNER_CONCURRENCY;
    const startMs = Date.now();
    const results: WalletScanResult[] = [];
    let scanned = 0;
    let skipped = 0;
    let errors = 0;
    let totalTxs = 0;
    let totalFirstFunders = 0;
    let totalDeposits = 0;
    let totalP2P = 0;

    for (let i = 0; i < walletIds.length; i += concurrency) {
      const chunk = walletIds.slice(i, i + concurrency);
      const chunkResults = await Promise.all(chunk.map((id) => this.deltaScanWallet(id, chain)));

      for (const result of chunkResults) {
        results.push(result);
        if (result.error) {
          errors++;
        } else if (result.transactionsFetched === 0) {
          skipped++; // up to date or no new txs
        } else {
          scanned++;
        }
        totalTxs += result.transactionsFetched;
        if (result.firstFunderFound) totalFirstFunders++;
        totalDeposits += result.depositEvidenceFound;
        totalP2P += result.p2pMatchesFound;
      }
    }

    return {
      chain,
      scanned,
      skipped,
      errors,
      totalTransactionsFetched: totalTxs,
      totalFirstFundersFound: totalFirstFunders,
      totalDepositEvidenceFound: totalDeposits,
      totalP2PMatchesFound: totalP2P,
      durationMs: Date.now() - startMs,
      results,
    };
  }

  /**
   * Batch scan with configurable concurrency.
   */
  async scanBatch(
    walletIds: string[],
    chain: ChainSlug,
    opts?: { concurrency?: number },
  ): Promise<BatchScanResult> {
    const concurrency = opts?.concurrency ?? env.SCANNER_CONCURRENCY;
    const startMs = Date.now();
    const results: WalletScanResult[] = [];
    let scanned = 0;
    let skipped = 0;
    let errors = 0;
    let totalTxs = 0;
    let totalFirstFunders = 0;
    let totalDeposits = 0;
    let totalP2P = 0;

    for (let i = 0; i < walletIds.length; i += concurrency) {
      const chunk = walletIds.slice(i, i + concurrency);
      const chunkResults = await Promise.all(chunk.map((id) => this.scanWallet(id, chain)));

      for (const result of chunkResults) {
        results.push(result);
        if (result.error) {
          errors++;
        } else if (result.transactionsFetched === 0 && result.firstFunderFound) {
          skipped++; // already fully scanned
        } else {
          scanned++;
        }
        totalTxs += result.transactionsFetched;
        if (result.firstFunderFound) totalFirstFunders++;
        totalDeposits += result.depositEvidenceFound;
        totalP2P += result.p2pMatchesFound;
      }
    }

    return {
      chain,
      scanned,
      skipped,
      errors,
      totalTransactionsFetched: totalTxs,
      totalFirstFundersFound: totalFirstFunders,
      totalDepositEvidenceFound: totalDeposits,
      totalP2PMatchesFound: totalP2P,
      durationMs: Date.now() - startMs,
      results,
    };
  }

  /**
   * Get wallet IDs not yet fully scanned on this chain.
   */
  async getUnscannedWallets(chain: ChainSlug, limit: number): Promise<string[]> {
    const database = this.getDbFn();

    const rows = await database
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.chain, chain), isNull(wallets.lastScannedAt)))
      .limit(limit);

    return rows.map((r) => r.id);
  }

  /**
   * Get wallet IDs due for rescan on this chain (not scanned within interval).
   */
  async getWalletsDueForRescan(chain: ChainSlug, intervalHours: number, limit = 10000): Promise<string[]> {
    const database = this.getDbFn();
    const cutoff = new Date(Date.now() - intervalHours * 60 * 60 * 1000);

    const rows = await database
      .select({ id: wallets.id })
      .from(wallets)
      .where(
        and(
          eq(wallets.chain, chain),
          or(
            isNull(wallets.lastScannedAt),
            lt(wallets.lastScannedAt, cutoff),
          ),
        ),
      )
      .orderBy(sql`${wallets.lastScannedAt} ASC NULLS FIRST`)
      .limit(limit);

    return rows.map((r) => r.id);
  }
}
