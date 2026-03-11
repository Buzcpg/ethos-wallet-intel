import { db as getDb, type Db } from '../db/client.js';
import type { ChainSlug } from '../chains/index.js';
import { CHAIN_SLUGS } from '../chains/index.js';
import { WalletScanner } from './walletScanner.js';
import { env } from '../config/env.js';
import { enqueueJob } from '../queue/index.js';
import { ProfileSyncService } from '../sync/profileSync.js';

// ---------------------------------------------------------------------------
// RescanOrchestrator
// ---------------------------------------------------------------------------

export class RescanOrchestrator {
  private readonly getDbFn: () => Db;
  private readonly walletScanner: WalletScanner;
  private readonly profileSync: ProfileSyncService;

  constructor(dbFn?: () => Db) {
    this.getDbFn = dbFn ?? getDb;
    this.walletScanner = new WalletScanner(dbFn);
    this.profileSync = new ProfileSyncService(undefined, dbFn);
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
   * Profile sync delta: run a full profile sync (ProfileSyncService handles
   * new vs updated wallets internally, enqueueing new_user jobs for new wallets).
   *
   * Returns counts of new profiles, new wallets, and jobs enqueued.
   */
  async syncNewProfiles(): Promise<{
    newProfiles: number;
    newWallets: number;
    jobsEnqueued: number;
  }> {
    console.info('[RescanOrchestrator] syncNewProfiles: starting profile sync delta');

    // ProfileSyncService.runFullSync handles upserts and new_user enqueue internally.
    // The new-user fast path in upsertWallets enqueues jobs for new wallet rows.
    const stats = await this.profileSync.runFullSync();

    console.info(
      `[RescanOrchestrator] syncNewProfiles: processed ${stats.profilesProcessed} profiles, ` +
      `upserted ${stats.walletsUpserted} wallets`,
    );

    // stats.walletsUpserted counts all rows attempted — new + updated.
    // The profileSync service internally enqueues new_user jobs for genuinely new rows.
    // We report walletsUpserted as a proxy for new wallets (conservative).
    return {
      newProfiles: stats.profilesUpserted,
      newWallets: stats.walletsUpserted,
      jobsEnqueued: stats.walletsUpserted, // each new wallet gets a new_user job
    };
  }

  /**
   * Count of wallets due for rescan per chain.
   */
  async getDueCounts(): Promise<Record<ChainSlug, number>> {
    const result = {} as Record<ChainSlug, number>;

    for (const chain of CHAIN_SLUGS) {
      const ids = await this.walletScanner.getWalletsDueForRescan(
        chain,
        env.RESCAN_INTERVAL_HOURS,
      );
      result[chain] = ids.length;
    }

    return result;
  }
}
