import { inArray, and, eq } from 'drizzle-orm';
import { type Db, db as getDb } from '../db/client.js';
import { depositTransferEvidence } from '../db/schema/index.js';
import type { ChainSlug } from '../chains/index.js';
import type { RawTransaction } from '../chains/transactionFetcher.js';
import { LabelResolver } from '../labels/labelResolver.js';

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
  private readonly labelResolver: LabelResolver;

  constructor(dbFn?: () => Db, labelResolver?: LabelResolver) {
    this.getDbFn = dbFn ?? getDb;
    this.labelResolver = labelResolver ?? new LabelResolver(dbFn);
  }

  /**
   * Scan a wallet's outbound transactions for CEX deposit address interactions.
   * Takes pre-fetched transactions to avoid redundant API calls.
   */
  async scanTransactions(
    walletId: string,
    transactions: RawTransaction[],
    chain: ChainSlug,
  ): Promise<DepositScanResult> {
    const database = this.getDbFn();
    const evidenceIds: string[] = [];
    let depositsFound = 0;

    // Only look at outbound transactions
    const outbound = transactions.filter((tx) => !tx.isInbound);

    // Resolve unique counterparty addresses first (batch label lookups)
    const uniqueRecipients = [...new Set(outbound.map((tx) => tx.toAddress).filter(Boolean))];
    const labelCache = new Map<string, boolean>();

    for (const recipient of uniqueRecipients) {
      const label = await this.labelResolver.resolveLabel(recipient, chain);
      const isCex =
        label !== null &&
        (label.labelKind === 'cex_deposit' || label.labelKind === 'exchange_hot_wallet');
      labelCache.set(recipient, isCex);
    }

    // H3 — identify CEX-touching transactions first, then do ONE bulk existence check
    const cexTxs = outbound.filter((tx) => tx.toAddress && labelCache.get(tx.toAddress));

    if (cexTxs.length === 0) {
      return { walletId, chain, depositsFound: 0, evidenceIds: [] };
    }

    const txHashes = cexTxs.map((tx) => tx.txHash);

    // One bulk WHERE txHash = ANY(…) AND chain = … check
    const existingRows =
      txHashes.length > 0
        ? await database
            .select({ txHash: depositTransferEvidence.txHash, id: depositTransferEvidence.id })
            .from(depositTransferEvidence)
            .where(
              and(
                inArray(depositTransferEvidence.txHash, txHashes),
                eq(depositTransferEvidence.chain, chain),
              ),
            )
        : [];

    const existingByHash = new Map(existingRows.map((r) => [r.txHash, r.id]));

    // Bulk-insert only the new ones in a single statement
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

      for (const row of inserted) {
        evidenceIds.push(row.id);
        depositsFound++;
      }
    }

    // Include already-existing evidence in the result
    for (const tx of cexTxs) {
      const existingId = existingByHash.get(tx.txHash);
      if (existingId) {
        evidenceIds.push(existingId);
        depositsFound++;
      }
    }

    return { walletId, chain, depositsFound, evidenceIds };
  }
}
