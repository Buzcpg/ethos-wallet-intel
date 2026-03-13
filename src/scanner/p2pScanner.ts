import { eq, and, inArray, sql } from 'drizzle-orm';
import { type Db, db as getDb } from '../db/client.js';
import { wallets, walletMatches, profileMatches } from '../db/schema/index.js';
import type { ChainSlug } from '../chains/index.js';
import type { RawTransaction } from '../chains/transactionFetcher.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface P2PScanResult {
  walletId: string;
  chain: ChainSlug;
  matchesFound: number;
}

interface WalletRow {
  id: string;
  address: string;
  profileId: string | null;
}

// ---------------------------------------------------------------------------
// P2PScanner
// ---------------------------------------------------------------------------

export class P2PScanner {
  private readonly getDbFn: () => Db;

  constructor(dbFn?: () => Db) {
    this.getDbFn = dbFn ?? getDb;
  }

  /**
   * Detect direct wallet-to-wallet interactions with other tracked Ethos wallets.
   * Takes pre-fetched transactions — no additional API calls.
   */
  async scanTransactions(
    walletId: string,
    walletAddress: string,
    transactions: RawTransaction[],
    chain: ChainSlug,
  ): Promise<P2PScanResult> {
    const database = this.getDbFn();
    const selfAddr = walletAddress.toLowerCase();
    let matchesFound = 0;

    if (transactions.length === 0) {
      return { walletId, chain, matchesFound: 0 };
    }

    // Collect all unique counterparty addresses (excluding self)
    const counterparties = new Set<string>();
    for (const tx of transactions) {
      if (tx.fromAddress && tx.fromAddress !== selfAddr) counterparties.add(tx.fromAddress);
      if (tx.toAddress && tx.toAddress !== selfAddr) counterparties.add(tx.toAddress);
    }

    if (counterparties.size === 0) {
      return { walletId, chain, matchesFound: 0 };
    }

    // Single DB query: find which counterparties are tracked wallets on this chain
    const counterpartyList = [...counterparties];
    const trackedWallets = await database
      .select({
        id: wallets.id,
        address: wallets.address,
        profileId: wallets.profileId,
      })
      .from(wallets)
      .where(
        and(
          inArray(wallets.address, counterpartyList),
          eq(wallets.chain, chain),
        ),
      );

    if (trackedWallets.length === 0) {
      return { walletId, chain, matchesFound: 0 };
    }

    // Build address → wallet lookup
    const trackedByAddress = new Map<string, WalletRow>();
    for (const w of trackedWallets) {
      trackedByAddress.set(w.address.toLowerCase(), w);
    }

    // Get the scanning wallet's profileId for profile match updates
    const [selfWallet] = await database
      .select({ profileId: wallets.profileId })
      .from(wallets)
      .where(eq(wallets.id, walletId))
      .limit(1);

    const selfProfileId = selfWallet?.profileId ?? null;

    // Process each transaction that touches a tracked wallet
    const processedPairs = new Set<string>(); // avoid duplicate match inserts per scan

    for (const tx of transactions) {
      const counterpartyAddr = tx.isInbound
        ? tx.fromAddress
        : tx.toAddress;

      if (!counterpartyAddr || counterpartyAddr === selfAddr) continue;

      const trackedWallet = trackedByAddress.get(counterpartyAddr);
      if (!trackedWallet) continue;

      // Canonical pair ordering: smaller UUID first
      const [walletAId, walletBId] =
        walletId < trackedWallet.id
          ? [walletId, trackedWallet.id]
          : [trackedWallet.id, walletId];

      const matchKey = counterpartyAddr; // match per counterparty address
      const pairKey = `${walletAId}:${walletBId}:${matchKey}`;

      if (processedPairs.has(pairKey)) continue;
      processedPairs.add(pairKey);

      // Idempotency: check existing wallet match
      const existingMatch = await database
        .select({ id: walletMatches.id })
        .from(walletMatches)
        .where(
          and(
            eq(walletMatches.walletAId, walletAId),
            eq(walletMatches.walletBId, walletBId),
            eq(walletMatches.matchType, 'direct_wallet_interaction'),
            eq(walletMatches.chain, chain),
            eq(walletMatches.matchKey, matchKey),
          ),
        )
        .limit(1);

      if (existingMatch.length === 0) {
        await database.insert(walletMatches).values({
          walletAId,
          walletBId,
          matchType: 'direct_wallet_interaction',
          chain,
          matchKey,
          score: '70.00',
          evidenceJson: {
            txHash: tx.txHash,
            direction: tx.isInbound ? 'inbound' : 'outbound',
            valueWei: tx.valueWei,
            blockNumber: tx.blockNumber.toString(),
            tokenSymbol: tx.tokenSymbol ?? null,
          },
        });
        matchesFound++;
      } else {
        matchesFound++;
      }

      // Update profile match if both wallets belong to different profiles
      const counterpartyProfileId = trackedWallet.profileId;
      if (selfProfileId && counterpartyProfileId && selfProfileId !== counterpartyProfileId) {
        const [canonProfileA, canonProfileB] =
          selfProfileId < counterpartyProfileId
            ? [selfProfileId, counterpartyProfileId]
            : [counterpartyProfileId, selfProfileId];

        await this.upsertProfileMatch(canonProfileA, canonProfileB, 70.0, database);
      }
    }

    return { walletId, chain, matchesFound };
  }

  // ---------------------------------------------------------------------------
  // Profile match upsert (mirrors firstFunderMatcher pattern)
  // ---------------------------------------------------------------------------

  private async upsertProfileMatch(
    profileAId: string,
    profileBId: string,
    score: number,
    database: Db,
    matchType = 'direct_wallet_interaction',
    matchKey = 'p2p',
  ): Promise<void> {
    const existing = await database
      .select({
        id: profileMatches.id,
        score: profileMatches.score,
        signalCount: profileMatches.signalCount,
      })
      .from(profileMatches)
      .where(
        and(
          eq(profileMatches.profileAId, profileAId),
          eq(profileMatches.profileBId, profileBId),
        ),
      )
      .limit(1);

    if (existing.length === 0) {
      await database.insert(profileMatches).values({
        profileAId,
        profileBId,
        matchType,
        matchKey,
        score: score.toFixed(2),
        signalCount: 1,
        status: 'new',
      });
    } else {
      const current = existing[0]!;
      const currentScore = parseFloat(current.score ?? '0');
      const newScore = Math.max(currentScore, score);

      await database
        .update(profileMatches)
        .set({
          score: newScore.toFixed(2),
          signalCount: sql`${profileMatches.signalCount} + 1`,
          updatedAt: new Date(),
        })
        .where(eq(profileMatches.id, current.id));
    }
  }
}
