import { eq, and } from 'drizzle-orm';
import { type Db, db as getDb } from '../db/client.js';
import { firstFunderSignals } from '../db/schema/index.js';
import type { ChainSlug } from '../chains/index.js';
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

// ---------------------------------------------------------------------------
// Etherscan cross-verification
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// TODO(M11): HTML scraping is fragile. Replace with official API when available.
async function scrapeFundedBy(htmlUrl: string): Promise<string | null> {
  try {
    const resp = await fetch(htmlUrl, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; wallet-intel/1.0; +https://github.com/Buzcpg/ethos-wallet-intel)',
        Accept: 'text/html',
      },
    });
    if (!resp.ok) return null;
    const html = await resp.text();

    const match = /[Ff]unded\s+[Bb]y\s*<a[^>]+href="\/address\/(0x[0-9a-fA-F]{40})"/.exec(html);
    if (match?.[1]) return match[1].toLowerCase();

    const matchPlain = /[Ff]unded\s+[Bb]y[^0-9a-fA-F]+(0x[0-9a-fA-F]{40})/.exec(html);
    if (matchPlain?.[1]) return matchPlain[1].toLowerCase();

    return null;
  } catch {
    return null;
  }
}

async function crossVerifyFunder(
  computedFunder: string,
  walletAddress: string,
  chain: ChainSlug,
): Promise<{ confidence: number; source: string }> {
  const blockscoutOnlyChains: ChainSlug[] = ['base', 'arbitrum', 'optimism', 'polygon'];
  if ((blockscoutOnlyChains as string[]).includes(chain)) {
    return { confidence: 0.9, source: 'computed' };
  }

  if (chain !== 'ethereum') {
    return { confidence: 0.9, source: 'computed' };
  }

  await sleep(500);
  const fundedBy = await scrapeFundedBy(`https://etherscan.io/address/${walletAddress}`);

  if (fundedBy === null) return { confidence: 0.9, source: 'computed' };

  if (fundedBy === computedFunder.toLowerCase()) {
    return { confidence: 1.0, source: 'etherscan_verified' };
  }

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
   * Extract first funder from pre-fetched transactions.
   * Idempotent — skips if signal already exists.
   * Wallet state (lastScannedAt, lastScannedBlock) is managed by WalletScanner.
   */
  async extractFromTransactions(
    walletId: string,
    walletAddress: string,
    transactions: RawTransaction[],
    chain: ChainSlug,
  ): Promise<ScanResult> {
    const database = this.getDbFn();

    try {
      // Idempotency check
      const existing = await database
        .select({ id: firstFunderSignals.id, funderAddress: firstFunderSignals.funderAddress })
        .from(firstFunderSignals)
        .where(
          and(
            eq(firstFunderSignals.walletId, walletId),
            eq(firstFunderSignals.chain, chain),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        return { walletId, chain, found: true, skipped: true, funderAddress: existing[0].funderAddress ?? undefined };
      }

      // Find earliest inbound native tx from a different address
      const sorted = [...transactions].sort((a, b) =>
        a.blockNumber < b.blockNumber ? -1 : a.blockNumber > b.blockNumber ? 1 : 0,
      );

      const firstInbound = sorted.find(
        (tx) =>
          tx.isInbound &&
          !tx.tokenContractAddress &&
          tx.valueWei !== '0' &&
          tx.fromAddress !== walletAddress.toLowerCase(),
      );

      if (firstInbound) {
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

        return {
          walletId,
          chain,
          found: true,
          funderAddress: firstInbound.fromAddress,
          txHash: firstInbound.txHash,
          blockNumber: firstInbound.blockNumber,
        };
      }

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
}
