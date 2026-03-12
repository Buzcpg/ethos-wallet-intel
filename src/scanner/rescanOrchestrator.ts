import { db as getDb, type Db } from '../db/client.js';
import type { ChainSlug } from '../chains/index.js';
import { CHAIN_SLUGS } from '../chains/index.js';
import { WalletScanner } from './walletScanner.js';
import { env } from '../config/env.js';
import { enqueueJob } from '../queue/index.js';
import { ProfileSyncService } from '../sync/profileSync.js';
import { SupabaseSync, type SupabaseProfileRow } from '../sync/supabaseSync.js';
import { EthosApiClient, createLimiter } from '../ethos/client.js';
import { sql } from 'drizzle-orm';
import { profiles } from '../db/schema/index.js';

// ---------------------------------------------------------------------------
// RescanOrchestrator
// ---------------------------------------------------------------------------

export class RescanOrchestrator {
  private readonly getDbFn: () => Db;
  private readonly walletScanner: WalletScanner;
  private readonly profileSync: ProfileSyncService;
  private readonly supabaseSync: SupabaseSync;

  constructor(dbFn?: () => Db) {
    this.getDbFn = dbFn ?? getDb;
    this.walletScanner = new WalletScanner(dbFn);
    this.profileSync = new ProfileSyncService(undefined, dbFn);
    this.supabaseSync = new SupabaseSync(this.profileSync, dbFn);
  }

  /**
   * Enqueue delta scan jobs for all wallets on a chain that haven't been
   * scanned in the last RESCAN_INTERVAL_HOURS hours.
   *
   * opts.force=true: enqueue all wallets regardless of last_scanned_at.
   */
  async scheduleRescan(
    chain: ChainSlug,
    opts?: { force?: boolean },
  ): Promise<{ enqueued: number }> {
    const intervalHours = opts?.force ? 0 : env.RESCAN_INTERVAL_HOURS;
    const walletIds = await this.walletScanner.getWalletsDueForRescan(chain, intervalHours);

    let enqueued = 0;
    for (const walletId of walletIds) {
      try {
        await enqueueJob(walletId, chain, 'delta', {});
        enqueued++;
      } catch (err) {
        console.warn(
          `[RescanOrchestrator] failed to enqueue delta for wallet ${walletId} on ${chain}:`,
          err,
        );
      }
    }

    console.info(
      `[RescanOrchestrator] scheduleRescan(${chain}): enqueued ${enqueued} delta jobs` +
      (opts?.force ? ' (force=true)' : ` (interval=${intervalHours}h)`),
    );

    return { enqueued };
  }

  /**
   * Schedule rescan for all supported chains.
   * Returns a map of chain → enqueued count.
   */
  async scheduleAllChains(opts?: { force?: boolean }): Promise<Record<ChainSlug, number>> {
    const results = {} as Record<ChainSlug, number>;

    for (const chain of CHAIN_SLUGS) {
      const { enqueued } = await this.scheduleRescan(chain, opts);
      results[chain] = enqueued;
    }

    return results;
  }

  /**
   * Forward-probe for new Ethos profiles since our last known profile ID.
   *
   * Strategy:
   * 1. Get highest external_profile_id from our profiles table
   * 2. Probe IDs from (highestSeen + 1) upward in concurrent batches
   * 3. Stop after NEW_USER_PROBE_MAX_MISSES consecutive misses (IDs have gaps)
   * 4. For each found profile: upsert profile + wallets → new_user job auto-enqueued
   *
   * Designed to run every 30 minutes. Fast and cheap — only hits the delta.
   */
  async syncNewProfiles(): Promise<{
    newProfiles: number;
    newWallets: number;
    jobsEnqueued: number;
    highestIdProbed: number;
  }> {
    const db = this.getDbFn();
    const ethosClient = new EthosApiClient();

    // Get highest profile ID we've seen (L4: column is integer — no CAST or regex needed)
    const result = await db.execute(sql`SELECT MAX(external_profile_id) as max_id FROM profiles`);
    const rows = result.rows as Array<{ max_id: number | null }>;
    const highestSeen = rows[0]?.max_id ?? 0;

    console.info(`[RescanOrchestrator] syncNewProfiles: probing from profile ID ${highestSeen + 1}`);

    // Fast path: if Supabase creds are available, fetch exact new profile IDs from
    // profiles_v2 table instead of probing blindly. Supabase PostgREST supports
    // ?raw_profile_id=gt.{N}&select=raw_profile_id&order=raw_profile_id.asc
    if (env.SUPABASE_URL && env.SUPABASE_ANON_KEY) {
      return this.syncNewProfilesViaSupabase(highestSeen);
    }

    const maxMisses = env.NEW_USER_PROBE_MAX_MISSES;
    const concurrency = env.ETHOS_API_CONCURRENCY;
    let consecutiveMisses = 0;
    let currentId = highestSeen + 1;
    let newProfiles = 0;
    let newWallets = 0;
    let highestIdProbed = highestSeen;

    const limit = createLimiter(concurrency);

    while (consecutiveMisses < maxMisses) {
      // Build a batch of IDs to probe
      const batchSize = Math.min(concurrency, maxMisses - consecutiveMisses + 1);
      const batchIds = Array.from({ length: batchSize }, (_, i) => currentId + i);
      currentId += batchSize;

      const results = await Promise.allSettled(
        batchIds.map((id) => limit(() => ethosClient.getProfileAddresses(id).then((data) => ({ id, data }))))
      );

      let batchHadHit = false;
      for (const result of results) {
        if (result.status === 'rejected') continue;
        const { id, data } = result.value;
        highestIdProbed = Math.max(highestIdProbed, id);

        if (!data || data.allAddresses.length === 0) {
          consecutiveMisses++;
          continue;
        }

        // Found a new profile — reset miss counter
        consecutiveMisses = 0;
        batchHadHit = true;

        try {
          const syncResult = await this.profileSync.syncProfile(id);
          newProfiles++;
          newWallets += syncResult.walletsUpserted; // actual new rows, not estimated
        } catch (err) {
          console.warn(`[RescanOrchestrator] syncNewProfiles: failed to sync profile ${id}:`, err);
        }
      }

      if (!batchHadHit && consecutiveMisses >= maxMisses) break;
    }

    console.info(
      `[RescanOrchestrator] syncNewProfiles: found ${newProfiles} new profiles, ` +
      `highest ID probed: ${highestIdProbed}, stopped after ${consecutiveMisses} consecutive misses`
    );

    return {
      newProfiles,
      newWallets,
      jobsEnqueued: newProfiles, // new_user jobs auto-enqueued by ProfileSyncService
      highestIdProbed,
    };
  }

  /**
   * Supabase fast-path for new profile discovery.
   *
   * Fetches profiles_v2 rows with raw_profile_id > highestSeen, including
   * userkeys (wallet addresses). Passes rows directly to SupabaseSync.ingestBatch —
   * no Ethos API calls needed at all.
   *
   * Returns counts of new profiles, new wallets, and jobs enqueued.
   * new_user scan jobs are auto-enqueued by upsertWallets for genuinely new wallets.
   */
  private async syncNewProfilesViaSupabase(
    highestSeen: number,
  ): Promise<{ newProfiles: number; newWallets: number; jobsEnqueued: number; highestIdProbed: number }> {
    const pageSize = 1000;
    let offset = 0;
    let newProfiles = 0;
    let newWallets = 0;
    let highestIdProbed = highestSeen;

    console.info(`[RescanOrchestrator] syncNewProfiles: Supabase fast-path from ID ${highestSeen + 1}`);

    while (true) {
      const url = new URL(`${env.SUPABASE_URL}/rest/v1/profiles_v2`);
      url.searchParams.set(
        'select',
        'raw_profile_id,display_name,username,status,score,userkeys',
      );
      url.searchParams.set('raw_profile_id', `gt.${highestSeen}`);
      url.searchParams.set('order', 'raw_profile_id.asc');
      url.searchParams.set('limit', String(pageSize));
      url.searchParams.set('offset', String(offset));

      const res = await fetch(url.toString(), {
        headers: {
          apikey: env.SUPABASE_ANON_KEY!,
          Authorization: `Bearer ${env.SUPABASE_ANON_KEY}`,
        },
      });

      if (!res.ok) {
        console.warn(`[RescanOrchestrator] Supabase fetch failed: ${res.status} ${res.statusText}`);
        break;
      }

      const rows = (await res.json()) as SupabaseProfileRow[];
      if (rows.length === 0) break;

      highestIdProbed = Math.max(highestIdProbed, ...rows.map((r) => r.raw_profile_id));

      // Ingest via SupabaseSync — no Ethos API calls, addresses come from userkeys
      const batchStats = await this.supabaseSync.ingestBatch(rows);
      newProfiles += batchStats.profilesUpserted;
      newWallets += batchStats.walletsUpserted;

      if (rows.length < pageSize) break;
      offset += pageSize;
    }

    console.info(
      `[RescanOrchestrator] syncNewProfiles (Supabase): ` +
        `found ${newProfiles} new profiles, highest ID: ${highestIdProbed}`,
    );
    return { newProfiles, newWallets, jobsEnqueued: newProfiles, highestIdProbed };
  }

  /**
   * Count of wallets due for rescan per chain.
   */
  async getDueCounts(): Promise<Record<ChainSlug, number>> {
    const result = {} as Record<ChainSlug, number>;

    // M5: countWalletsDueForRescan issues COUNT(*) only — no ID fetch
    for (const chain of CHAIN_SLUGS) {
      result[chain] = await this.walletScanner.countWalletsDueForRescan(
        chain,
        env.RESCAN_INTERVAL_HOURS,
      );
    }

    return result;
  }
}
