import { eq, and } from 'drizzle-orm';
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

    // Insert one evidence row per qualifying outbound transaction
    for (const tx of outbound) {
      if (!tx.toAddress) continue;
      if (!labelCache.get(tx.toAddress)) continue;

      // Idempotency check: unique on (txHash, chain)
      const existing = await database
        .select({ id: depositTransferEvidence.id })
        .from(depositTransferEvidence)
        .where(
          and(
            eq(depositTransferEvidence.txHash, tx.txHash),
            eq(depositTransferEvidence.chain, chain),
          ),
        )
        .limit(1);

      if (existing.length > 0) {
        evidenceIds.push(existing[0]!.id);
        depositsFound++;
        continue;
      }

      const transferType = tx.tokenContractAddress ? 'erc20' : 'native';

      const inserted = await database
        .insert(depositTransferEvidence)
        .values({
          walletId,
          chain,
          recipientAddress: tx.toAddress,
          txHash: tx.txHash,
          transferType,
          tokenSymbol: tx.tokenSymbol ?? null,
          amountRaw: tx.tokenValueRaw ?? tx.valueWei,
          blockNumber: tx.blockNumber,
          blockTimestamp: tx.blockTimestamp,
        })
        .returning({ id: depositTransferEvidence.id });

      if (inserted.length > 0) {
        evidenceIds.push(inserted[0]!.id);
        depositsFound++;
      }
    }

    return { walletId, chain, depositsFound, evidenceIds };
  }
}
