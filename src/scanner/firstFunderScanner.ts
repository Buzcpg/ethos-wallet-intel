import { eq, and, isNull } from 'drizzle-orm';
import { type Db, db as getDb } from '../db/client.js';
import { wallets, firstFunderSignals } from '../db/schema/index.js';
import type { ChainSlug } from '../chains/index.js';
import { getAdapter } from '../chains/adapterRegistry.js';
import { env } from '../config/env.js';

export interface ScanResult {
  walletId: string;
  chain: ChainSlug;
  found: boolean;
  funderAddress?: string;
  txHash?: string;
  blockNumber?: bigint;
  skipped?: boolean;
  error?: string;
}

export interface BatchScanResult {
  scanned: number;
  found: number;
  skipped: number;
  errors: number;
  results: ScanResult[];
}

export class FirstFunderScanner {
  private readonly getDbFn: () => Db;

  constructor(dbFn?: () => Db) {
    this.getDbFn = dbFn ?? getDb;
  }

  /**
   * Scan a single wallet for its first funder on a given chain.
   * Idempotent — skips wallets that already have a signal for this chain.
   */
  async scanWallet(walletId: string, chain: ChainSlug): Promise<ScanResult> {
    const database = this.getDbFn();

    try {
      // 1. Check for existing signal (idempotency)
      const existing = await database
        .select({ id: firstFunderSignals.id })
        .from(firstFunderSignals)
        .where(
          and(
            eq(firstFunderSignals.walletId, walletId),
            eq(firstFunderSignals.chain, chain),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        return { walletId, chain, found: true, skipped: true };
      }

      // 2. Get wallet address from DB
      const [wallet] = await database
        .select({ address: wallets.address })
        .from(wallets)
        .where(eq(wallets.id, walletId))
        .limit(1);

      if (!wallet) {
        return { walletId, chain, found: false, error: `Wallet ${walletId} not found` };
      }

      // 3. Fetch first inbound native tx via chain adapter
      const adapter = getAdapter(chain);
      const tx = await adapter.getFirstInboundNativeTx(wallet.address);

      const now = new Date();

      // 4. If found: insert signal, update scan state
      if (tx) {
        await database.insert(firstFunderSignals).values({
          walletId,
          chain,
          funderAddress: tx.fromAddress,
          txHash: tx.txHash,
          blockNumber: tx.blockNumber,
          blockTimestamp: tx.blockTimestamp,
          source: adapter.constructor.name,
          confidence: '1.0',
        });

        await database
          .update(wallets)
          .set({
            lastScannedAt: now,
            lastScannedBlock: tx.blockNumber,
          })
          .where(eq(wallets.id, walletId));

        return {
          walletId,
          chain,
          found: true,
          funderAddress: tx.fromAddress,
          txHash: tx.txHash,
          blockNumber: tx.blockNumber,
        };
      }

      // 5. Not found: still mark as scanned
      await database
        .update(wallets)
        .set({ lastScannedAt: now })
        .where(eq(wallets.id, walletId));

      return { walletId, chain, found: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[FirstFunderScanner] Error scanning wallet ${walletId} on ${chain}:`, err);
      return { walletId, chain, found: false, error: message };
    }
  }

  /**
   * Scan a batch of wallets with configurable concurrency.
   */
  async scanBatch(
    walletIds: string[],
    chain: ChainSlug,
    opts?: { concurrency?: number },
  ): Promise<BatchScanResult> {
    const concurrency = opts?.concurrency ?? env.SCANNER_CONCURRENCY;
    const results: ScanResult[] = [];
    let scanned = 0;
    let found = 0;
    let skipped = 0;
    let errors = 0;

    // Process in chunks of `concurrency`
    for (let i = 0; i < walletIds.length; i += concurrency) {
      const chunk = walletIds.slice(i, i + concurrency);
      const chunkResults = await Promise.all(
        chunk.map((id) => this.scanWallet(id, chain)),
      );

      for (const result of chunkResults) {
        results.push(result);
        if (result.skipped) {
          skipped++;
        } else if (result.error) {
          errors++;
          scanned++;
        } else {
          scanned++;
          if (result.found) found++;
        }
      }
    }

    return { scanned, found, skipped, errors, results };
  }

  /**
   * Fetch next N wallet IDs that haven't been scanned on this chain yet.
   */
  async getUnscannedWallets(chain: ChainSlug, limit: number): Promise<string[]> {
    const database = this.getDbFn();

    // Wallets with no lastScannedAt and no existing signal for this chain
    const rows = await database
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.chain, chain), isNull(wallets.lastScannedAt)))
      .limit(limit);

    return rows.map((r) => r.id);
  }
}
