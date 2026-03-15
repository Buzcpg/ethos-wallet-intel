import { inArray, and, eq, inArray as inArrayAlias } from 'drizzle-orm';
import { type Db, db as getDb } from '../db/client.js';
import { depositTransferEvidence, addressLabels } from '../db/schema/index.js';
import type { ChainSlug } from '../chains/index.js';
import type { RawTransaction } from '../chains/transactionFetcher.js';
import { CEX_SEED_LABELS } from '../labels/seedData.js';

// ---------------------------------------------------------------------------
// In-memory CEX address cache — loaded once from DB, refreshed every 30 min
// Falls back to CEX_SEED_LABELS if DB is empty or unreachable
// ---------------------------------------------------------------------------

interface CexCache {
  byChain: Map<string, Set<string>>;
  loadedAt: number;
}

let _cache: CexCache | null = null;
const CACHE_TTL_MS = 30 * 60 * 1000;

async function getCexAddresses(chain: ChainSlug, database: Db): Promise<Set<string>> {
  const now = Date.now();

  if (_cache && now - _cache.loadedAt < CACHE_TTL_MS) {
    return _cache.byChain.get(chain) ?? new Set();
  }

  // Reload from DB
  try {
    const rows = await database
      .select({ chain: addressLabels.chain, address: addressLabels.address })
      .from(addressLabels)
      .where(eq(addressLabels.labelKind, 'exchange_hot_wallet'));

    const byChain = new Map<string, Set<string>>();

    // Seed with hardcoded bootstrap first
    for (const label of CEX_SEED_LABELS) {
      if (!byChain.has(label.chain)) byChain.set(label.chain, new Set());
      byChain.get(label.chain)!.add(label.address.toLowerCase());
    }

    // Overlay with DB labels (may have more)
    for (const row of rows) {
      if (!byChain.has(row.chain)) byChain.set(row.chain, new Set());
      byChain.get(row.chain)!.add(row.address.toLowerCase());
    }

    _cache = { byChain, loadedAt: now };

    const total = [...byChain.values()].reduce((sum, s) => sum + s.size, 0);
    console.log(`[DepositScanner] cache refreshed — ${total} CEX addresses across ${byChain.size} chains`);
  } catch (err) {
    console.error('[DepositScanner] cache load failed, using hardcoded fallback:', err);

    // Fallback to hardcoded only
    const byChain = new Map<string, Set<string>>();
    for (const label of CEX_SEED_LABELS) {
      if (!byChain.has(label.chain)) byChain.set(label.chain, new Set());
      byChain.get(label.chain)!.add(label.address.toLowerCase());
    }
    _cache = { byChain, loadedAt: now };
  }

  return _cache.byChain.get(chain) ?? new Set();
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface DepositScanResult {
  walletId: string;
  chain: ChainSlug;
  depositsFound: number;
  evidenceIds: string[];
}

// ---------------------------------------------------------------------------
// DepositScanner
// ---------------------------------------------------------------------------

export class DepositScanner {
  private readonly getDbFn: () => Db;

  constructor(dbFn?: () => Db) {
    this.getDbFn = dbFn ?? getDb;
  }

  /**
   * Scan a wallet's outbound transactions for deposits to known CEX hot wallets.
   * Takes pre-fetched transactions — no additional API calls.
   * CEX address list is loaded from address_labels DB (refreshed every 30min),
   * with CEX_SEED_LABELS as hardcoded fallback.
   */
  async scanTransactions(
    walletId: string,
    transactions: RawTransaction[],
    chain: ChainSlug,
  ): Promise<DepositScanResult> {
    const database = this.getDbFn();
    const evidenceIds: string[] = [];

    const cexAddresses = await getCexAddresses(chain, database);
    if (cexAddresses.size === 0) {
      return { walletId, chain, depositsFound: 0, evidenceIds: [] };
    }

    const cexTxs = transactions.filter(
      (tx) => !tx.isInbound && cexAddresses.has(tx.toAddress.toLowerCase()),
    );

    if (cexTxs.length === 0) {
      return { walletId, chain, depositsFound: 0, evidenceIds: [] };
    }

    const txHashes = cexTxs.map((tx) => tx.txHash);

    const existingRows = await database
      .select({ txHash: depositTransferEvidence.txHash, id: depositTransferEvidence.id })
      .from(depositTransferEvidence)
      .where(
        and(
          inArray(depositTransferEvidence.txHash, txHashes),
          eq(depositTransferEvidence.chain, chain),
        ),
      );

    const existingByHash = new Map(existingRows.map((r) => [r.txHash, r.id]));
    const toInsert = cexTxs.filter((tx) => !existingByHash.has(tx.txHash));

    if (toInsert.length > 0) {
      const inserted = await database
        .insert(depositTransferEvidence)
        .values(
          toInsert.map((tx) => ({
            walletId,
            chain,
            recipientAddress: tx.toAddress,
            txHash: tx.txHash,
            transferType: (tx.tokenContractAddress ? 'erc20' : 'native') as 'erc20' | 'native',
            tokenSymbol: tx.tokenSymbol ?? null,
            amountRaw: tx.tokenValueRaw ?? tx.valueWei,
            blockNumber: tx.blockNumber,
            blockTimestamp: tx.blockTimestamp,
          })),
        )
        .returning({ id: depositTransferEvidence.id, txHash: depositTransferEvidence.txHash });

      for (const row of inserted) evidenceIds.push(row.id);
    }

    for (const tx of cexTxs) {
      const existingId = existingByHash.get(tx.txHash);
      if (existingId) evidenceIds.push(existingId);
    }

    return { walletId, chain, depositsFound: evidenceIds.length, evidenceIds };
  }
}
