import { randomUUID } from 'crypto';
import { eq, sql } from 'drizzle-orm';
import { db as getDb, type Db } from '../db/client.js';
import { profiles, wallets } from '../db/schema/index.js';
import { SUPPORTED_CHAINS } from '../chains/index.js';
import type { ChainSlug } from '../chains/index.js';
import { EthosApiClient } from '../ethos/client.js';
import type { IEthosApiClient, EthosProfile, EthosAddressData } from '../ethos/client.js';
import { env } from '../config/env.js';
import { enqueueJob } from '../queue/index.js';

export interface SyncStats {
  profilesProcessed: number;
  profilesUpserted: number;
  walletsUpserted: number;
  walletsSkipped: number;
  errors: number;
  durationMs: number;
}

export interface FullSyncOptions {
  batchSize?: number;
  dryRun?: boolean;
}

export class ProfileSyncService {
  private readonly client: IEthosApiClient;
  private readonly getDbFn: () => Db;

  constructor(client?: IEthosApiClient, dbFn?: () => Db) {
    this.client =
      client ??
      new EthosApiClient({
        maxConcurrent: env.ETHOS_API_CONCURRENCY,
        sleepMs: env.ETHOS_API_SLEEP_MS,
        maxRetries: env.ETHOS_API_MAX_RETRIES,
      });
    this.getDbFn = dbFn ?? getDb;
  }

  /**
   * Full sync: paginate all Ethos profiles → upsert profiles + wallets.
   */
  async runFullSync(options?: FullSyncOptions): Promise<SyncStats> {
    const batchSize = options?.batchSize ?? env.ETHOS_API_BATCH_SIZE;
    const dryRun = options?.dryRun ?? false;
    const start = Date.now();

    const stats: SyncStats = {
      profilesProcessed: 0,
      profilesUpserted: 0,
      walletsUpserted: 0,
      walletsSkipped: 0,
      errors: 0,
      durationMs: 0,
    };

    let batch: EthosProfile[] = [];

    for await (const profile of this.client.listAllProfiles()) {
      batch.push(profile);
      stats.profilesProcessed++;

      if (batch.length >= batchSize) {
        await this.processBatch(batch, stats, dryRun);
        batch = [];
      }
    }

    if (batch.length > 0) {
      await this.processBatch(batch, stats, dryRun);
    }

    stats.durationMs = Date.now() - start;
    return stats;
  }

  /**
   * Sync a single profile by Ethos profile ID.
   */
  async syncProfile(profileId: number): Promise<{ walletsUpserted: number }> {
    const profileData = await this.client.getProfile(profileId);
    if (!profileData) {
      throw new Error(`[ProfileSyncService] Ethos profile ${profileId} not found`);
    }

    await this.upsertProfiles([profileData]);

    const addressData = await this.client.getProfileAddresses(profileId);
    if (!addressData) {
      return { walletsUpserted: 0 };
    }

    const internalId = await this.getInternalProfileId(profileId);
    if (!internalId) {
      throw new Error(
        `[ProfileSyncService] No internal profile row for Ethos profile ${profileId}`,
      );
    }

    const count = await this.upsertWallets(internalId, addressData, 'ethos_api');
    return { walletsUpserted: count };
  }

  private async processBatch(
    batch: EthosProfile[],
    stats: SyncStats,
    dryRun: boolean,
  ): Promise<void> {
    // H2 / M8 — bulk upsert entire batch in one statement; errors are isolated below.
    if (!dryRun) {
      try {
        await this.upsertProfiles(batch);
      } catch (err) {
        console.error('[ProfileSyncService] bulk upsertProfiles failed:', err);
        // Continue — wallets for already-existing profiles may still be upsertable
      }
    }

    const profileIds = batch.map((p) => p.id);
    const addressMap = await this.client.fetchAddressesBatch(profileIds);

    for (const profile of batch) {
      // M8 — per-profile try/catch so one bad profile doesn't block the rest
      try {
        const addressData = addressMap.get(profile.id);

        if (!addressData) {
          stats.walletsSkipped++;
          continue;
        }

        if (!dryRun) {
          const internalId = await this.getInternalProfileId(profile.id);
          if (internalId) {
            const count = await this.upsertWallets(internalId, addressData, 'ethos_api');
            stats.walletsUpserted += count;
          }
        } else {
          // Dry run: count what would be upserted without writing
          stats.walletsUpserted +=
            addressData.allAddresses.length * Object.keys(SUPPORTED_CHAINS).length;
        }

        stats.profilesUpserted++;
      } catch (err) {
        console.error(`[ProfileSyncService] Error processing profile ${profile.id}:`, err);
        stats.errors++;
      }
    }
  }

  /**
   * H2 — Bulk upsert: single INSERT ... ON CONFLICT DO UPDATE for the entire batch.
   */
  async upsertProfiles(batch: EthosProfile[]): Promise<void> {
    if (batch.length === 0) return;
    const database = this.getDbFn();

    await database
      .insert(profiles)
      .values(
        batch.map((profile) => ({
          externalProfileId: profile.id,
          displayName: profile.displayName,
          slug: profile.username,
          status: profile.status,
        })),
      )
      .onConflictDoUpdate({
        target: profiles.externalProfileId,
        set: {
          displayName: sql`excluded.display_name`,
          slug: sql`excluded.slug`,
          status: sql`excluded.status`,
          updatedAt: new Date(),
        },
      });
  }

  async getInternalProfileId(externalId: number): Promise<string | null> {
    const database = this.getDbFn();
    const [row] = await database
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.externalProfileId, externalId))
      .limit(1);
    return row?.id ?? null;
  }

  /**
   * H2 — Bulk upsert wallets: single INSERT ... ON CONFLICT DO UPDATE RETURNING.
   * Replaces N×6 sequential round-trips with one statement.
   * xmax=0 → new row inserted → enqueue new_user scan job immediately.
   *
   * Returns the number of rows attempted.
   */
  async upsertWallets(
    internalProfileId: string,
    addressData: EthosAddressData,
    source: 'ethos_api' | 'supabase',
  ): Promise<number> {
    const database = this.getDbFn();
    const { primaryAddress, allAddresses } = addressData;
    const chains = Object.keys(SUPPORTED_CHAINS) as ChainSlug[];

    const valueTuples = chains.flatMap((chain) =>
      allAddresses.map((address) => {
        const normalised = address.toLowerCase();
        const isPrimary = normalised === (primaryAddress?.toLowerCase() ?? '');
        return {
          id: randomUUID(),
          profileId: internalProfileId,
          address: normalised,
          chain,
          isPrimary,
          walletSource: source,
          firstSeenAt: new Date(),
          lastSeenAt: new Date(),
        };
      }),
    );

    if (valueTuples.length === 0) return 0;

    const result = await database
      .insert(wallets)
      .values(valueTuples)
      .onConflictDoUpdate({
        target: [wallets.address, wallets.chain],
        set: {
          profileId: internalProfileId,
          isPrimary: sql`excluded.is_primary`,
          lastSeenAt: new Date(),
        },
      })
      .returning({
        id: wallets.id,
        chain: wallets.chain,
        xmax: sql<string>`xmax`,
      });

    // Enqueue new_user jobs for genuinely new wallet rows (xmax='0' means INSERT, not UPDATE)
    for (const row of result) {
      if (row.xmax === '0') {
        await enqueueJob(row.id, row.chain as ChainSlug, 'new_user', {}).catch((err) => {
          console.warn(
            `[ProfileSyncService] failed to enqueue new_user job for wallet ${row.id} on ${row.chain}:`,
            err,
          );
        });
      }
    }

    return result.length;
  }
}
