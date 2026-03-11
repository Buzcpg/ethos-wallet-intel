import { eq, and, sql, inArray } from 'drizzle-orm';
import { type Db, db as getDb } from '../db/client.js';
import {
  firstFunderSignals,
  walletMatches,
  profileMatches,
  wallets,
} from '../db/schema/index.js';
import type { ChainSlug } from '../chains/index.js';
import { CHAIN_SLUGS } from '../chains/index.js';

export interface MatchStats {
  chain: ChainSlug;
  sharedFunderGroups: number;
  walletMatchesCreated: number;
  profileMatchesCreated: number;
  profileMatchesUpdated: number;
}

interface FunderGroup {
  funderAddress: string;
  walletIds: string[];
}

export class FirstFunderMatcher {
  private readonly getDbFn: () => Db;

  constructor(dbFn?: () => Db) {
    this.getDbFn = dbFn ?? getDb;
  }

  /**
   * Detect cross-profile matches for a single chain.
   * Creates/updates wallet_matches and profile_matches records.
   */
  async detectMatches(chain: ChainSlug): Promise<MatchStats> {
    const stats: MatchStats = {
      chain,
      sharedFunderGroups: 0,
      walletMatchesCreated: 0,
      profileMatchesCreated: 0,
      profileMatchesUpdated: 0,
    };

    await this.detectSharedFunder(chain, stats);
    await this.detectDirectFunder(chain, stats);

    return stats;
  }

  /**
   * Run for all chains.
   */
  async detectAllChains(): Promise<Record<ChainSlug, MatchStats>> {
    const results = {} as Record<ChainSlug, MatchStats>;
    for (const chain of CHAIN_SLUGS) {
      results[chain] = await this.detectMatches(chain);
    }
    return results;
  }

  // ---------------------------------------------------------------------------
  // Shared funder detection
  // ---------------------------------------------------------------------------

  private async detectSharedFunder(chain: ChainSlug, stats: MatchStats): Promise<void> {
    const database = this.getDbFn();

    // Find funder addresses shared by 2+ wallets on this chain
    const result = await database.execute<{ funder_address: string; wallet_ids: string[] }>(
      sql`
        SELECT funder_address, array_agg(wallet_id::text) AS wallet_ids
        FROM ${firstFunderSignals}
        WHERE chain = ${chain}
        GROUP BY funder_address
        HAVING count(*) >= 2
      `,
    );

    const funderGroups: FunderGroup[] = (result.rows ?? []).map((row) => ({
      funderAddress: row.funder_address,
      walletIds: row.wallet_ids,
    }));

    stats.sharedFunderGroups = funderGroups.length;

    for (const group of funderGroups) {
      await this.processWalletPairs(
        group.walletIds,
        chain,
        'shared_first_funder',
        group.funderAddress,
        85.0,
        stats,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Direct funder detection
  // ---------------------------------------------------------------------------

  private async detectDirectFunder(chain: ChainSlug, stats: MatchStats): Promise<void> {
    const database = this.getDbFn();

    const result = await database.execute<{
      funded_wallet: string;
      funder_wallet: string;
      funder_address: string;
    }>(
      sql`
        SELECT
          ffs.wallet_id AS funded_wallet,
          w.id AS funder_wallet,
          ffs.funder_address
        FROM ${firstFunderSignals} ffs
        JOIN ${wallets} w
          ON lower(w.address) = lower(ffs.funder_address)
          AND w.chain = ffs.chain
        WHERE ffs.chain = ${chain}
          AND ffs.wallet_id != w.id
      `,
    );

    for (const pair of result.rows ?? []) {
      const walletIds = [pair.funded_wallet, pair.funder_wallet];
      await this.processWalletPairs(
        walletIds,
        chain,
        'direct_funder',
        pair.funder_address,
        95.0,
        stats,
      );
    }
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  /**
   * For each pair in walletIds, create a wallet_match row and corresponding profile_match.
   */
  private async processWalletPairs(
    walletIds: string[],
    chain: ChainSlug,
    matchType: string,
    matchKey: string,
    score: number,
    stats: MatchStats,
  ): Promise<void> {
    const database = this.getDbFn();

    // Generate all unique pairs
    const pairs = this.uniquePairs(walletIds);
    // Resolve profile IDs for all wallets in one query
    const profileMap = await this.resolveProfileIds(walletIds, database);

    for (const [walletAId, walletBId] of pairs) {
      // Check if wallet_match already exists
      const existing = await database
        .select({ id: walletMatches.id })
        .from(walletMatches)
        .where(
          and(
            eq(walletMatches.walletAId, walletAId),
            eq(walletMatches.walletBId, walletBId),
            eq(walletMatches.matchType, matchType),
            eq(walletMatches.chain, chain),
            eq(walletMatches.matchKey, matchKey),
          ),
        )
        .limit(1);

      if (existing.length === 0) {
        await database.insert(walletMatches).values({
          walletAId,
          walletBId,
          matchType,
          chain,
          matchKey,
          score: score.toFixed(2),
        });
        stats.walletMatchesCreated++;
      }

      // Profile match
      const profileAId = profileMap.get(walletAId);
      const profileBId = profileMap.get(walletBId);

      if (!profileAId || !profileBId || profileAId === profileBId) {
        continue;
      }

      // Canonical ordering: smaller UUID first
      const [canonA, canonB] =
        profileAId < profileBId ? [profileAId, profileBId] : [profileBId, profileAId];

      await this.upsertProfileMatch(canonA, canonB, score, database, stats);
    }
  }

  private async upsertProfileMatch(
    profileAId: string,
    profileBId: string,
    score: number,
    database: Db,
    stats: MatchStats,
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
        score: score.toFixed(2),
        signalCount: 1,
        status: 'new',
      });
      stats.profileMatchesCreated++;
    } else {
      const current = existing[0]!;
      const currentScore = parseFloat(current.score ?? '0');
      const newScore = Math.max(currentScore, score);
      const newSignalCount = (current.signalCount ?? 0) + 1;

      await database
        .update(profileMatches)
        .set({
          score: newScore.toFixed(2),
          signalCount: newSignalCount,
          updatedAt: new Date(),
        })
        .where(eq(profileMatches.id, current.id));

      stats.profileMatchesUpdated++;
    }
  }

  private async resolveProfileIds(
    walletIds: string[],
    database: Db,
  ): Promise<Map<string, string>> {
    const map = new Map<string, string>();
    if (walletIds.length === 0) return map;

    const rows = await database
      .select({ id: wallets.id, profileId: wallets.profileId })
      .from(wallets)
      .where(inArray(wallets.id, walletIds));

    for (const row of rows) {
      if (row.profileId) {
        map.set(row.id, row.profileId);
      }
    }

    return map;
  }

  /** Generate all unique unordered pairs from an array of IDs. */
  private uniquePairs(ids: string[]): Array<[string, string]> {
    const pairs: Array<[string, string]> = [];
    for (let i = 0; i < ids.length; i++) {
      for (let j = i + 1; j < ids.length; j++) {
        const a = ids[i]!;
        const b = ids[j]!;
        if (a < b) {
          pairs.push([a, b]);
        } else {
          pairs.push([b, a]);
        }
      }
    }
    return pairs;
  }
}
