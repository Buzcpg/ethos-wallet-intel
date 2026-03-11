import { randomUUID } from 'crypto';
import { eq } from 'drizzle-orm';
import { db as getDb, type Db } from '../db/client.js';
import { profiles, wallets } from '../db/schema/index.js';
import { SUPPORTED_CHAINS } from '../chains/index.js';
import type { ChainSlug } from '../chains/index.js';
import { EthosApiClient } from '../ethos/client.js';
import type { IEthosApiClient, EthosProfile, EthosAddressData } from '../ethos/client.js';
import { env } from '../config/env.js';

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

    const internalId = await this.getInternalProfileId(profileId.toString());
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
    if (!dryRun) {
      await this.upsertProfiles(batch);
    }

    const profileIds = batch.map((p) => p.id);
    const addressMap = await this.client.fetchAddressesBatch(profileIds);

    for (const profile of batch) {
      try {
        const addressData = addressMap.get(profile.id);

        if (!addressData) {
          stats.walletsSkipped++;
          continue;
        }

        if (!dryRun) {
          const internalId = await this.getInternalProfileId(profile.id.toString());
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

  private async upsertProfiles(batch: EthosProfile[]): Promise<void> {
    const database = this.getDbFn();

    for (const profile of batch) {
      await database
        .insert(profiles)
        .values({
          externalProfileId: profile.id.toString(),
          displayName: profile.displayName,
          slug: profile.username,
          status: profile.status,
        })
        .onConflictDoUpdate({
          target: profiles.externalProfileId,
          set: {
            displayName: profile.displayName,
            slug: profile.username,
            status: profile.status,
            updatedAt: new Date(),
          },
        });
    }
  }

  private async getInternalProfileId(externalId: string): Promise<string | null> {
    const database = this.getDbFn();
    const [row] = await database
      .select({ id: profiles.id })
      .from(profiles)
      .where(eq(profiles.externalProfileId, externalId))
      .limit(1);
    return row?.id ?? null;
  }

  /**
   * Upsert wallet rows: one row per (address, chain) pair across all supported chains.
   * All addresses stored lowercase.
   * Uses onConflictDoUpdate on (address, chain) — safe to call multiple times (idempotent).
   * Returns the number of rows attempted.
   */
  async upsertWallets(
    internalProfileId: string,
    addressData: EthosAddressData,
    source: 'ethos_api',
  ): Promise<number> {
    const database = this.getDbFn();
    const { primaryAddress, allAddresses } = addressData;
    const chains = Object.keys(SUPPORTED_CHAINS) as ChainSlug[];
    let count = 0;

    for (const chain of chains) {
      for (const address of allAddresses) {
        const normalised = address.toLowerCase();
        const isPrimary = normalised === (primaryAddress?.toLowerCase() ?? '');

        await database
          .insert(wallets)
          .values({
            id: randomUUID(),
            profileId: internalProfileId,
            address: normalised,
            chain,
            isPrimary,
            walletSource: source,
            firstSeenAt: new Date(),
            lastSeenAt: new Date(),
          })
          .onConflictDoUpdate({
            target: [wallets.address, wallets.chain],
            set: {
              profileId: internalProfileId,
              isPrimary,
              lastSeenAt: new Date(),
            },
          });

        count++;
      }
    }

    return count;
  }
}
