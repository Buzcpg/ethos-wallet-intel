/**
 * SupabaseSync — ingests profile + wallet data directly from the Ethos-Webapp
 * Supabase DB (profiles_v2 table), bypassing the Ethos API entirely.
 *
 * profiles_v2.userkeys is the canonical wallet list:
 *   ["address:0xABC...", "address:0xDEF...", "service:x.com:123", "profileId:456"]
 *
 * Addresses are parsed from "address:" prefixed entries. The first entry is
 * treated as primary (matches Ethos API behaviour).
 *
 * This is the fast-path for bulk ingestion. ProfileSyncService (Ethos API)
 * is kept for targeted individual syncs.
 */

import type { EthosProfile, EthosAddressData } from '../ethos/client.js';
import { ProfileSyncService } from './profileSync.js';
import type { Db } from '../db/client.js';
import { db as getDb } from '../db/client.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface SupabaseProfileRow {
  raw_profile_id: number;
  display_name: string | null;
  username: string | null;
  status: string | null;
  score: number | null;
  primary_address?: string | null;
}

export interface SupabaseSyncStats {
  profilesUpserted: number;
  walletsUpserted: number;
  skipped: number;    // rows with no addresses in userkeys
  errors: number;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build EthosAddressData from profiles_v2.primary_address alone.
 * No userkeys needed — primary_address is the single source of truth.
 */
export function parseAddressesFromPrimary(primaryAddress?: string | null): EthosAddressData {
  if (!primaryAddress) return { primaryAddress: null, allAddresses: [] };
  return { primaryAddress: primaryAddress.toLowerCase(), allAddresses: [primaryAddress.toLowerCase()] };
}

// Legacy alias — kept for walletDriftChecker compatibility
export const parseAddressesFromUserkeys = (
  _userkeys: unknown,
  primaryAddress?: string | null,
) => parseAddressesFromPrimary(primaryAddress);

/**
 * Map a Supabase profiles_v2 row to the EthosProfile shape expected by
 * ProfileSyncService.upsertProfiles.
 */
export function toEthosProfile(row: SupabaseProfileRow): EthosProfile {
  return {
    id: row.raw_profile_id,
    displayName: row.display_name ?? '',
    username: row.username ?? null,
    status: (row.status as EthosProfile['status']) ?? 'ACTIVE',
    score: row.score ?? 0,
    userkeys: [],
  };
}

// ---------------------------------------------------------------------------
// SupabaseSync
// ---------------------------------------------------------------------------

export class SupabaseSync {
  private readonly profileSync: ProfileSyncService;
  private readonly getDbFn: () => Db;

  constructor(profileSync?: ProfileSyncService, dbFn?: () => Db) {
    this.getDbFn = dbFn ?? getDb;
    this.profileSync = profileSync ?? new ProfileSyncService(undefined, this.getDbFn);
  }

  /**
   * Ingest a batch of profiles_v2 rows into our DB.
   *
   * - Upserts profile metadata
   * - Upserts wallets (one row per address x chain)
   * - new_user scan jobs are auto-enqueued by upsertWallets for genuinely new wallets
   *
   * Safe to call multiple times — all upserts are idempotent.
   */
  async ingestBatch(rows: SupabaseProfileRow[]): Promise<SupabaseSyncStats> {
    const stats: SupabaseSyncStats = {
      profilesUpserted: 0,
      walletsUpserted: 0,
      skipped: 0,
      errors: 0,
    };

    if (rows.length === 0) return stats;

    // Upsert all profile metadata in one pass
    const profileShapes = rows.map(toEthosProfile);
    await this.profileSync.upsertProfiles(profileShapes);

    // Upsert wallets per profile
    for (const row of rows) {
      try {
        const addressData = parseAddressesFromPrimary(row.primary_address);

        if (!addressData.primaryAddress) {
          stats.skipped++;
          continue;
        }

        const internalId = await this.profileSync.getInternalProfileId(row.raw_profile_id);
        if (!internalId) {
          console.warn('[SupabaseSync] no internal profile row for raw_profile_id=' + row.raw_profile_id);
          stats.errors++;
          continue;
        }

        const count = await this.profileSync.upsertWallets(internalId, addressData, 'supabase');
        stats.walletsUpserted += count;
        stats.profilesUpserted++;
      } catch (err) {
        console.warn('[SupabaseSync] error ingesting profile ' + row.raw_profile_id + ':', err);
        stats.errors++;
      }
    }

    return stats;
  }
}
