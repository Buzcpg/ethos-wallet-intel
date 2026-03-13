import { eq, and, isNull } from 'drizzle-orm';
import { type Db, db as getDb } from '../db/client.js';
import { wallets, firstFunderSignals } from '../db/schema/index.js';
import type { ChainSlug } from '../chains/index.js';

import { env } from '../config/env.js';
import type { RawTransaction } from '../chains/transactionFetcher.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

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

interface CrossVerifyResult {
  confidence: number;
  source: string;
}

// ---------------------------------------------------------------------------
// Etherscan HTML cross-verification
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// TODO(M11): HTML scraping is fragile — Etherscan can change its markup at any time and
// silently break cross-verification. Replace with an official API call when available
// (e.g. Etherscan v3 /account/fundingtx endpoint). Monitor for breakage in production.

/**
 * Scrape Etherscan/Snowtrace HTML to extract the "Funded By" address.
 * Returns the funding address (lowercase) or null if not present / on error.
 */
async function scrapeFundedBy(
  htmlUrl: string,
): Promise<string | null> {
  try {
    const resp = await fetch(htmlUrl, {
      headers: {
        // Mimic a browser request to avoid trivial bot blocking
        'User-Agent':
          'Mozilla/5.0 (compatible; wallet-intel/1.0; +https://github.com/Buzcpg/ethos-wallet-intel)',
        Accept: 'text/html',
      },
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    // Pattern: Funded by <a href="/address/0x...">0x...</a>
    // Etherscan renders this as a link with class or within a dt/dd block.
    // We match the href attribute value to extract the address robustly.
    const match = /[Ff]unded\s+[Bb]y\s*<a[^>]+href="\/address\/(0x[0-9a-fA-F]{40})"/.exec(html);
    if (match?.[1]) return match[1].toLowerCase();

    // Alternate pattern: sometimes rendered as plain text
    const matchPlain = /[Ff]unded\s+[Bb]y[^0-9a-fA-F]+(0x[0-9a-fA-F]{40})/.exec(html);
    if (matchPlain?.[1]) return matchPlain[1].toLowerCase();

    return null;
  } catch {
    return null;
  }
}

/**
 * Cross-verify the computed first funder address against Etherscan's "Funded By" field.
 *
 * - ethereum:  Fetch etherscan.io HTML — full cross-verification
 * - avalanche: Fetch snowtrace.io HTML — best-effort, skip on failure
 * - others:    Blockscout v2 has no funded-by field → return confidence 0.9
 */
async function crossVerifyFunder(
  computedFunder: string,
  walletAddress: string,
  chain: ChainSlug,
): Promise<CrossVerifyResult> {
  // Blockscout chains: no independent funded-by source available
  const blockscoutOnlyChains: ChainSlug[] = ['base', 'arbitrum', 'optimism', 'polygon'];
  if ((blockscoutOnlyChains as string[]).includes(chain)) {
    return { confidence: 0.9, source: 'computed' };
  }

  let htmlUrl: string;
  if (chain === 'ethereum') {
    htmlUrl = `https://etherscan.io/address/${walletAddress}`;
  } else {
    return { confidence: 0.9, source: 'computed' };
  }

  // Rate-limit: 500ms delay before HTML fetch to avoid getting blocked
  await sleep(500);

  const fundedBy = await scrapeFundedBy(htmlUrl);

  if (fundedBy === null) {
    // Page had no "Funded By" field (self-funded, contract deploy, or fetch failed)
    return { confidence: 0.9, source: 'computed' };
  }

  if (fundedBy === computedFunder.toLowerCase()) {
    return { confidence: 1.0, source: 'etherscan_verified' };
  }

  // Mismatch: log and return lower confidence
  console.warn(
    `[FirstFunderScanner] cross-verify conflict on ${chain} for ${walletAddress}: ` +
      `computed=${computedFunder} etherscan=${fundedBy}`,
  );
  return { confidence: 0.7, source: 'etherscan_conflict' };
}

// ---------------------------------------------------------------------------
// FirstFunderScanner
// ---------------------------------------------------------------------------

export class FirstFunderScanner {
  private readonly getDbFn: () => Db;

  constructor(dbFn?: () => Db) {
    this.getDbFn = dbFn ?? getDb;
  }

  /**
   * Scan a single wallet for its first funder on a given chain.
   * Idempotent — skips wallets that already have a signal for this chain.
   * Performs Etherscan HTML cross-verification for Ethereum (best-effort).
   */
  async scanWallet(walletId: string, chain: ChainSlug): Promise<ScanResult> {
    const database = this.getDbFn();

    try {
      // 1. Idempotency check
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

      // 2. Get wallet address
      const [wallet] = await database
        .select({ address: wallets.address })
        .from(wallets)
        .where(eq(wallets.id, walletId))
        .limit(1);

      if (!wallet) {
        return { walletId, chain, found: false, error: `Wallet ${walletId} not found` };
      }

      // 3. Legacy adapter path removed — use extractFromTransactions via WalletScanner.
      // getAdapter (blockscout/etherscan) has been replaced by alchemyFetcher.
      // This method is preserved for API compat only; return not-found immediately.
      await database
        .update(wallets)
        .set({ lastScannedAt: new Date() })
        .where(eq(wallets.id, walletId));
      return { walletId, chain, found: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[FirstFunderScanner] Error scanning wallet ${walletId} on ${chain}:`, err);
      return { walletId, chain, found: false, error: message };
    }
  }

  /**
   * Extract first funder from pre-fetched transactions.
   * Used by WalletScanner to avoid a redundant API call when all txs are already fetched.
   *
   * Applies the same Etherscan cross-verification logic as scanWallet().
   * Idempotent — skips if signal already exists.
   */
  async extractFromTransactions(
    walletId: string,
    walletAddress: string,
    transactions: RawTransaction[],
    chain: ChainSlug,
  ): Promise<ScanResult> {
    const database = this.getDbFn();

    try {
      // 1. Idempotency check
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

      // 2. Find first inbound native tx with non-zero value from pre-fetched data
      // Sort ascending by blockNumber then filter inbound + non-zero native value
      const sorted = [...transactions].sort((a, b) =>
        a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0,
      );

      const firstInbound = sorted.find(
        (tx) =>
          tx.isInbound &&
          !tx.tokenContractAddress && // native only
          tx.valueWei !== '0' &&
          tx.fromAddress !== walletAddress.toLowerCase(),
      );

      const now = new Date();

      if (firstInbound) {
        // 3. Cross-verify against Etherscan / Snowtrace HTML
        const verification = await crossVerifyFunder(
          firstInbound.fromAddress,
          walletAddress,
          chain,
        );

        await database.insert(firstFunderSignals).values({
          walletId,
          chain,
          funderAddress: firstInbound.fromAddress,
          txHash: firstInbound.txHash,
          blockNumber: firstInbound.blockNumber,
          blockTimestamp: firstInbound.blockTimestamp,
          source: verification.source,
          confidence: verification.confidence.toFixed(2),
        });

        await database
          .update(wallets)
          .set({ lastScannedAt: now, lastScannedBlock: firstInbound.blockNumber })
          .where(eq(wallets.id, walletId));

        return {
          walletId,
          chain,
          found: true,
          funderAddress: firstInbound.fromAddress,
          txHash: firstInbound.txHash,
          blockNumber: firstInbound.blockNumber,
        };
      }

      // 4. No qualifying tx found — mark scanned
      await database
        .update(wallets)
        .set({ lastScannedAt: now })
        .where(eq(wallets.id, walletId));

      return { walletId, chain, found: false };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(
        `[FirstFunderScanner] extractFromTransactions error for wallet ${walletId} on ${chain}:`,
        err,
      );
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

    for (let i = 0; i < walletIds.length; i += concurrency) {
      const chunk = walletIds.slice(i, i + concurrency);
      const chunkResults = await Promise.all(chunk.map((id) => this.scanWallet(id, chain)));

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

    const rows = await database
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.chain, chain), isNull(wallets.lastScannedAt)))
      .limit(limit);

    return rows.map((r) => r.id);
  }
}
