/**
 * WalletDriftChecker — detects wallet changes on profiles we already track.
 *
 * Ethos users can add/remove wallets over time. The Supabase fast-path only
 * picks up *new* profiles (raw_profile_id > highestSeen). This checker handles
 * drift on existing profiles by re-reading profiles_v2.userkeys for all known
 * profile IDs and diffing against what we already have stored.
 *
 * Intended to run as a nightly background job.
 *
 * Flow:
 *   1. Page through all profiles in our DB (external_profile_id values)
 *   2. Fetch matching profiles_v2 rows from Supabase in batches
 *   3. For each profile: compare userkeys addresses against stored wallets
 *   4. New addresses → upserted (new_user scan jobs auto-enqueued)
 *   5. (Removed addresses are NOT deleted — historical wallet data is preserved)
 */

import { eq, asc } from 'drizzle-orm';
import { db as getDb, type Db } from '../db/client.js';
import { profiles, wallets } from '../db/schema/index.js';
import { env } from '../config/env.js';
import { ProfileSyncService } from './profileSync.js';
import { parseAddressesFromPrimary, toEthosProfile, type SupabaseProfileRow } from './supabaseSync.js';

export interface DriftCheckStats {
  profilesChecked: number;
  profilesWithNewWallets: number;
  newWalletsUpserted: number;
  errors: number;
  durationMs: number;
}

const BATCH_SIZE = 500;

// H5 — sub-batch size for Supabase URL to avoid URL-length overflow with 500 IDs
const SUPABASE_SUB_BATCH = 100;

export class WalletDriftChecker {
  private readonly getDbFn: () => Db;
  private readonly profileSync: ProfileSyncService;

  constructor(profileSync?: ProfileSyncService, dbFn?: () => Db) {
    this.getDbFn = dbFn ?? getDb;
    this.profileSync = profileSync ?? new ProfileSyncService(undefined, this.getDbFn);
  }

  /**
   * Run a full drift check across all tracked profiles.
   * Returns stats — does not throw on partial failure.
   */
  async run(): Promise<DriftCheckStats> {
    if (!env.SUPABASE_URL || !env.SUPABASE_ANON_KEY) {
      console.info('[WalletDriftChecker] Supabase not configured — skipping drift check');
      return {
        profilesChecked: 0,
        profilesWithNewWallets: 0,
        newWalletsUpserted: 0,
        errors: 0,
        durationMs: 0,
      };
    }

    const start = Date.now();
    const stats: DriftCheckStats = {
      profilesChecked: 0,
      profilesWithNewWallets: 0,
      newWalletsUpserted: 0,
      errors: 0,
      durationMs: 0,
    };

    const db = this.getDbFn();

    // Page through our known profiles in batches
    let offset = 0;

    while (true) {
      // H6 — ORDER BY profiles.id for stable, deterministic pagination
      const knownProfiles = await db
        .select({ id: profiles.id, externalProfileId: profiles.externalProfileId })
        .from(profiles)
        .orderBy(asc(profiles.id))
        .limit(BATCH_SIZE)
        .offset(offset);

      if (knownProfiles.length === 0) break;

      // Map external_profile_id (integer) → internal UUID
      const idMap = new Map<number, string>(); // raw_profile_id → internal UUID
      for (const p of knownProfiles) {
        // L4: externalProfileId is integer — no parseInt/isNaN needed
        if (p.externalProfileId !== null) idMap.set(p.externalProfileId, p.id);
      }

      const rawIds = Array.from(idMap.keys());

      // H5 — paginate fetchSupabaseRows into sub-batches of 100 to avoid URL overflow
      let supabaseRows: SupabaseProfileRow[];
      try {
        supabaseRows = await this.fetchSupabaseRows(rawIds);
      } catch (err) {
        console.warn('[WalletDriftChecker] Supabase batch fetch failed — aborting run:', err);
        stats.errors++;
        break;
      }

      for (const row of supabaseRows) {
        try {
          stats.profilesChecked++;
          const internalId = idMap.get(row.raw_profile_id);
          if (!internalId) continue;

          const addressData = parseAddressesFromPrimary(row.primary_address);
          if (addressData.allAddresses.length === 0) continue;

          // Get addresses already stored for this profile
          const stored = await db
            .select({ address: wallets.address })
            .from(wallets)
            .where(eq(wallets.profileId, internalId));

          const storedSet = new Set(stored.map((w) => w.address.toLowerCase()));

          const newAddresses = addressData.allAddresses.filter(
            (a) => !storedSet.has(a.toLowerCase()),
          );

          if (newAddresses.length === 0) continue;

          // New wallets found — upsert them (new_user jobs auto-enqueued)
          const count = await this.profileSync.upsertWallets(internalId, addressData, 'supabase');
          stats.newWalletsUpserted += count;
          stats.profilesWithNewWallets++;

          console.info(
            `[WalletDriftChecker] profile ${row.raw_profile_id}: +${newAddresses.length} new address(es)`,
          );
        } catch (err) {
          console.warn(`[WalletDriftChecker] error checking profile ${row.raw_profile_id}:`, err);
          stats.errors++;
        }
      }

      if (knownProfiles.length < BATCH_SIZE) break;
      offset += BATCH_SIZE;
    }

    stats.durationMs = Date.now() - start;

    console.info(
      `[WalletDriftChecker] done: checked=${stats.profilesChecked} ` +
        `withNewWallets=${stats.profilesWithNewWallets} ` +
        `newWallets=${stats.newWalletsUpserted} ` +
        `errors=${stats.errors} ` +
        `duration=${stats.durationMs}ms`,
    );

    return stats;
  }

  /**
   * H5 — Fetch profiles_v2 rows from Supabase for the given raw_profile_ids.
   * Paginates rawIds into sub-batches of SUPABASE_SUB_BATCH (100) before building
   * URLs to avoid URL-length overflow with large ID lists.
   * Fires sub-batches sequentially and concatenates results.
   */
  private async fetchSupabaseRows(rawIds: number[]): Promise<SupabaseProfileRow[]> {
    if (rawIds.length === 0) return [];

    const allRows: SupabaseProfileRow[] = [];

    // Split into sub-batches of 100
    for (let i = 0; i < rawIds.length; i += SUPABASE_SUB_BATCH) {
      const subBatch = rawIds.slice(i, i + SUPABASE_SUB_BATCH);

      const url = new URL(`${env.SUPABASE_URL}/rest/v1/profiles_v2`);
      url.searchParams.set('select', 'raw_profile_id,display_name,username,status,score,primary_address');
      url.searchParams.set('raw_profile_id', `in.(${subBatch.join(',')})`);

      const res = await fetch(url.toString(), {
        headers: {
          apikey: env.SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
        },
      });

      if (!res.ok) {
        throw new Error(`Supabase fetch failed: ${res.status} ${res.statusText}`);
      }

      const rows = (await res.json()) as SupabaseProfileRow[];
      allRows.push(...rows);
    }

    return allRows;
  }
}
