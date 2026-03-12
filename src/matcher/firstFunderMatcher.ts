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
   * H4 — For each pair in walletIds: collect all candidates, do ONE bulk existence
   * check, then bulk-insert new wallet_match rows. Same for profile matches.
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
    if (pairs.length === 0) return;

    // Resolve profile IDs for all wallets in one query
    const profileMap = await this.resolveProfileIds(walletIds, database);

    // H4 — Bulk existence check for wallet_matches
    // Build a tuple array for a WHERE (a, b, type, chain, key) IN (...) style check
    const existingWalletMatches = await database.execute<{
      wallet_a_id: string;
      wallet_b_id: string;
    }>(
      sql`
        SELECT wallet_a_id, wallet_b_id
        FROM ${walletMatches}
        WHERE chain = ${chain}
          AND match_type = ${matchType}
          AND match_key = ${matchKey}
          AND (wallet_a_id, wallet_b_id) IN (
            ${sql.join(
              pairs.map(([a, b]) => sql`(${a}, ${b})`),
              sql`, `,
            )}
          )
      `,
    );

    const existingSet = new Set(
      (existingWalletMatches.rows ?? []).map(
        (r) => `${r.wallet_a_id}:${r.wallet_b_id}`,
      ),
    );

    // Bulk-insert new wallet_match rows
    const newPairs = pairs.filter(([a, b]) => !existingSet.has(`${a}:${b}`));
    if (newPairs.length > 0) {
      await database.insert(walletMatches).values(
        newPairs.map(([walletAId, walletBId]) => ({
          walletAId,
          walletBId,
          matchType,
          chain,
          matchKey,
          score: score.toFixed(2),
        })),
      );
      stats.walletMatchesCreated += newPairs.length;
    }

    // Collect profile pairs for upsert
    const profilePairs: Array<[string, string]> = [];
    for (const [walletAId, walletBId] of pairs) {
      const profileAId = profileMap.get(walletAId);
      const profileBId = profileMap.get(walletBId);

      if (!profileAId || !profileBId || profileAId === profileBId) continue;

      // Canonical ordering: smaller UUID first
      const [canonA, canonB] =
        profileAId < profileBId ? [profileAId, profileBId] : [profileBId, profileAId];

      profilePairs.push([canonA, canonB]);
    }

    // H4 — Profile matches: upsert one at a time (profile match upsert needs score comparison)
    // We still collect and query in bulk for existence, then update only what needs updating.
    if (profilePairs.length === 0) return;

    const existingProfileMatches = await database
      .select({
        id: profileMatches.id,
        profileAId: profileMatches.profileAId,
        profileBId: profileMatches.profileBId,
        score: profileMatches.score,
        signalCount: profileMatches.signalCount,
      })
      .from(profileMatches)
      .where(
        sql`(${profileMatches.profileAId}, ${profileMatches.profileBId}) IN (
          ${sql.join(
            profilePairs.map(([a, b]) => sql`(${a}, ${b})`),
            sql`, `,
          )}
        )`,
      );

    const existingByKey = new Map(
      existingProfileMatches.map((r) => [`${r.profileAId}:${r.profileBId}`, r]),
    );

    const toCreate: Array<[string, string]> = [];

    for (const [canonA, canonB] of profilePairs) {
      const key = `${canonA}:${canonB}`;
      const existing = existingByKey.get(key);

      if (!existing) {
        toCreate.push([canonA, canonB]);
      } else {
        const currentScore = parseFloat(existing.score ?? '0');
        const newScore = Math.max(currentScore, score);
        const newSignalCount = (existing.signalCount ?? 0) + 1;

        await database
          .update(profileMatches)
          .set({
            score: newScore.toFixed(2),
            signalCount: newSignalCount,
            updatedAt: new Date(),
          })
          .where(eq(profileMatches.id, existing.id));

        stats.profileMatchesUpdated++;
      }
    }

    if (toCreate.length > 0) {
      await database.insert(profileMatches).values(
        toCreate.map(([profileAId, profileBId]) => ({
          profileAId,
          profileBId,
          score: score.toFixed(2),
          signalCount: 1,
          status: 'new',
        })),
      );
      stats.profileMatchesCreated += toCreate.length;
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
