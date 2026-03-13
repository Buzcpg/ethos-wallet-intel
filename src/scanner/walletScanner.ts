import { eq, and, isNull, lt, or, sql, count } from 'drizzle-orm';
import { type Db, db as getDb } from '../db/client.js';
import { wallets } from '../db/schema/index.js';
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
  /** Fetch ALL transactions — no page cap. Used for deep_scan jobs. */
  deepScan?: boolean;
}

export interface WalletScanResult {
  walletId: string;
  chain: ChainSlug;
  transactionsFetched: number;
  firstFunderFound: boolean;
  depositEvidenceFound: number;
  p2pMatchesFound: number;
  partial: boolean;
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
   * Full scan: fetch transactions (windowed or deep), run all three extractors in parallel.
   * Idempotent — all extractors use upsert/conflict handling.
   */
  async scanWallet(walletId: string, chain: ChainSlug, opts?: WalletScanOptions): Promise<WalletScanResult> {
    const startMs = Date.now();
    const database = this.getDbFn();

    try {
      const [wallet] = await database
        .select({ address: wallets.address })
        .from(wallets)
        .where(eq(wallets.id, walletId))
        .limit(1);

      if (!wallet) {
        return {
          walletId, chain,
          transactionsFetched: 0, firstFunderFound: false,
          depositEvidenceFound: 0, p2pMatchesFound: 0,
          partial: false, durationMs: Date.now() - startMs,
          error: `Wallet ${walletId} not found`,
        };
      }

      const fetcher = new WalletTransactionFetcher(chain);
      const fetchResult = await fetcher.fetchAll(wallet.address, opts?.deepScan ? { deepScan: true } : undefined);
      const { transactions } = fetchResult;

      const [firstFunderResult, depositResult, p2pResult] = await Promise.all([
        this.firstFunderScanner
          .extractFromTransactions(walletId, wallet.address, transactions, chain)
          .catch((err) => {
            console.error(`[WalletScanner] firstFunder error for ${walletId}:`, err);
            return { walletId, chain, found: false, error: String(err) };
          }),
        this.depositScanner
          .scanTransactions(walletId, transactions, chain)
          .catch((err) => {
            console.error(`[WalletScanner] deposit error for ${walletId}:`, err);
            return { walletId, chain, depositsFound: 0, evidenceIds: [] };
          }),
        this.p2pScanner
          .scanTransactions(walletId, wallet.address, transactions, chain)
          .catch((err) => {
            console.error(`[WalletScanner] p2p error for ${walletId}:`, err);
            return { walletId, chain, matchesFound: 0 };
          }),
      ]);

      await database
        .update(wallets)
        .set({
          lastScannedAt: new Date(),
          ...(fetchResult.toBlock !== undefined ? { lastScannedBlock: fetchResult.toBlock } : {}),
        })
        .where(eq(wallets.id, walletId));

      return {
        walletId, chain,
        transactionsFetched: fetchResult.totalFetched,
        partial: fetchResult.partial,
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
        walletId, chain,
        transactionsFetched: 0, firstFunderFound: false,
        depositEvidenceFound: 0, p2pMatchesFound: 0,
        partial: false, durationMs: Date.now() - startMs,
        error: message,
      };
    }
  }

  /**
   * Delta scan: fetch only transactions since lastScannedBlock.
   * Falls back to full scan if wallet has never been scanned.
   */
  async deltaScanWallet(walletId: string, chain: ChainSlug): Promise<WalletScanResult> {
    const startMs = Date.now();
    const database = this.getDbFn();

    try {
      const [wallet] = await database
        .select({ address: wallets.address, lastScannedBlock: wallets.lastScannedBlock })
        .from(wallets)
        .where(eq(wallets.id, walletId))
        .limit(1);

      if (!wallet) {
        return {
          walletId, chain,
          transactionsFetched: 0, firstFunderFound: false,
          depositEvidenceFound: 0, p2pMatchesFound: 0,
          partial: false, durationMs: Date.now() - startMs,
          error: `Wallet ${walletId} not found`,
        };
      }

      if (wallet.lastScannedBlock === null) {
        return this.scanWallet(walletId, chain);
      }

      const fromBlock = BigInt(wallet.lastScannedBlock) + 1n;
      const fetcher = new WalletTransactionFetcher(chain);
      const fetchResult = await fetcher.fetchAll(wallet.address, { fromBlock });

      // Always update lastScannedAt — even zero-tx delta marks the wallet as checked
      await database
        .update(wallets)
        .set({
          lastScannedAt: new Date(),
          ...(fetchResult.toBlock !== undefined ? { lastScannedBlock: fetchResult.toBlock } : {}),
        })
        .where(eq(wallets.id, walletId));

      if (fetchResult.transactions.length === 0) {
        return {
          walletId, chain,
          transactionsFetched: 0, firstFunderFound: false,
          depositEvidenceFound: 0, p2pMatchesFound: 0,
          partial: false, durationMs: Date.now() - startMs,
        };
      }

      const { transactions } = fetchResult;

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

      return {
        walletId, chain,
        transactionsFetched: fetchResult.totalFetched,
        partial: false,
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
        walletId, chain,
        transactionsFetched: 0, firstFunderFound: false,
        depositEvidenceFound: 0, p2pMatchesFound: 0,
        partial: false, durationMs: Date.now() - startMs,
        error: message,
      };
    }
  }

  async deltaScanBatch(walletIds: string[], chain: ChainSlug, opts?: { concurrency?: number }): Promise<BatchScanResult> {
    return this._runBatch(walletIds, chain, opts?.concurrency, (id) => this.deltaScanWallet(id, chain));
  }

  async scanBatch(walletIds: string[], chain: ChainSlug, opts?: { concurrency?: number }): Promise<BatchScanResult> {
    return this._runBatch(walletIds, chain, opts?.concurrency, (id) => this.scanWallet(id, chain));
  }

  private async _runBatch(
    walletIds: string[],
    chain: ChainSlug,
    concurrency = env.SCANNER_CONCURRENCY,
    scan: (id: string) => Promise<WalletScanResult>,
  ): Promise<BatchScanResult> {
    const startMs = Date.now();
    const results: WalletScanResult[] = [];
    let scanned = 0, skipped = 0, errors = 0;
    let totalTxs = 0, totalFirstFunders = 0, totalDeposits = 0, totalP2P = 0;

    for (let i = 0; i < walletIds.length; i += concurrency) {
      const chunk = walletIds.slice(i, i + concurrency);
      const chunkResults = await Promise.all(chunk.map(scan));

      for (const result of chunkResults) {
        results.push(result);
        if (result.error) errors++;
        else if (result.transactionsFetched === 0) skipped++;
        else scanned++;
        totalTxs += result.transactionsFetched;
        if (result.firstFunderFound) totalFirstFunders++;
        totalDeposits += result.depositEvidenceFound;
        totalP2P += result.p2pMatchesFound;
      }
    }

    return {
      chain, scanned, skipped, errors,
      totalTransactionsFetched: totalTxs,
      totalFirstFundersFound: totalFirstFunders,
      totalDepositEvidenceFound: totalDeposits,
      totalP2PMatchesFound: totalP2P,
      durationMs: Date.now() - startMs,
      results,
    };
  }

  async getUnscannedWallets(chain: ChainSlug, limit: number): Promise<string[]> {
    const rows = await this.getDbFn()
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.chain, chain), isNull(wallets.lastScannedAt)))
      .limit(limit);
    return rows.map((r) => r.id);
  }

  async getWalletsDueForRescan(chain: ChainSlug, intervalHours: number, limit = 10000): Promise<string[]> {
    const cutoff = new Date(Date.now() - intervalHours * 60 * 60 * 1000);
    const rows = await this.getDbFn()
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.chain, chain), or(isNull(wallets.lastScannedAt), lt(wallets.lastScannedAt, cutoff))))
      .orderBy(sql`${wallets.lastScannedAt} ASC NULLS FIRST`)
      .limit(limit);
    return rows.map((r) => r.id);
  }

  async countWalletsDueForRescan(chain: ChainSlug, intervalHours: number): Promise<number> {
    const cutoff = new Date(Date.now() - intervalHours * 60 * 60 * 1000);
    const result = await this.getDbFn()
      .select({ value: count() })
      .from(wallets)
      .where(and(eq(wallets.chain, chain), or(isNull(wallets.lastScannedAt), lt(wallets.lastScannedAt, cutoff))));
    return result[0]?.value ?? 0;
  }
}
