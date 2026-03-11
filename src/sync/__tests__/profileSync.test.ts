import { describe, it, expect, beforeEach } from 'vitest';
import { ProfileSyncService } from '../profileSync.js';
import { SUPPORTED_CHAINS } from '../../chains/index.js';
import type { IEthosApiClient, EthosProfile, EthosAddressData } from '../../ethos/client.js';
import type { Db } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const DRIZZLE_NAME = Symbol.for('drizzle:Name');

function tableName(table: unknown): string {
  return (table as Record<symbol, string>)[DRIZZLE_NAME] ?? '';
}

function makeProfile(overrides?: Partial<EthosProfile>): EthosProfile {
  return {
    id: 42,
    displayName: 'Test User',
    username: 'testuser',
    status: 'ACTIVE',
    score: 100,
    userkeys: [],
    ...overrides,
  };
}

function makeAddressData(overrides?: Partial<EthosAddressData>): EthosAddressData {
  return {
    primaryAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
    allAddresses: [
      '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
      '0x1111111111111111111111111111111111111111',
    ],
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// In-memory mock db — uses Symbol.for('drizzle:Name') to identify tables
// ---------------------------------------------------------------------------

interface InsertedWallet {
  id: string;
  profileId: string;
  address: string;
  chain: string;
  isPrimary: boolean;
  walletSource: string;
  firstSeenAt: Date;
  lastSeenAt: Date;
}

interface InsertedProfile {
  externalProfileId: string;
  displayName: string;
  slug: string | null | undefined;
  status: string;
}

function makeMockDb() {
  const insertedWallets: InsertedWallet[] = [];
  const insertedProfiles: InsertedProfile[] = [];

  const mockDb = {
    _wallets: insertedWallets,
    _profiles: insertedProfiles,

    insert: (table: unknown) => {
      const name = tableName(table);

      return {
        values: (vals: Record<string, unknown>) => ({
          onConflictDoUpdate: (_opts: unknown) => {
            if (name === 'wallets') {
              insertedWallets.push(vals as unknown as InsertedWallet);
            } else if (name === 'profiles') {
              const p = vals as unknown as InsertedProfile;
              const idx = insertedProfiles.findIndex(
                (x) => x.externalProfileId === p.externalProfileId,
              );
              if (idx >= 0) {
                insertedProfiles[idx] = p;
              } else {
                insertedProfiles.push(p);
              }
            }
            return Promise.resolve();
          },
        }),
      };
    },

    select: (_cols: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: unknown) => Promise.resolve([{ id: 'mock-profile-uuid-42' }]),
        }),
      }),
    }),
  };

  return mockDb;
}

// ---------------------------------------------------------------------------
// Mock Ethos API client — satisfies IEthosApiClient
// ---------------------------------------------------------------------------

function makeMockClient(
  profileList: EthosProfile[],
  addressMap: Map<number, EthosAddressData>,
): IEthosApiClient {
  return {
    async *listAllProfiles() {
      for (const p of profileList) yield p;
    },
    async getProfileAddresses(id: number): Promise<EthosAddressData | null> {
      return addressMap.get(id) ?? null;
    },
    async getProfile(id: number): Promise<EthosProfile | null> {
      return profileList.find((p) => p.id === id) ?? null;
    },
    async fetchAddressesBatch(ids: number[]): Promise<Map<number, EthosAddressData>> {
      const result = new Map<number, EthosAddressData>();
      for (const id of ids) {
        const data = addressMap.get(id);
        if (data) result.set(id, data);
      }
      return result;
    },
  };
}

const NUM_CHAINS = Object.keys(SUPPORTED_CHAINS).length; // 6

// ---------------------------------------------------------------------------
// upsertWallets unit tests
// ---------------------------------------------------------------------------

describe('ProfileSyncService — upsertWallets', () => {
  let mockDb: ReturnType<typeof makeMockDb>;
  let service: ProfileSyncService;

  beforeEach(() => {
    mockDb = makeMockDb();
    const dummyClient = makeMockClient([], new Map());
    service = new ProfileSyncService(dummyClient, () => mockDb as unknown as Db);
  });

  it('creates one wallet row per (address, chain) — 6 chains × N addresses', async () => {
    const addressData = makeAddressData(); // 2 addresses
    await service.upsertWallets('mock-profile-uuid-42', addressData, 'ethos_api');

    const expected = NUM_CHAINS * addressData.allAddresses.length; // 6 × 2 = 12
    expect(mockDb._wallets).toHaveLength(expected);
  });

  it('normalises all addresses to lowercase', async () => {
    const addressData = makeAddressData({
      primaryAddress: '0xABCDEF1234567890ABCDEF1234567890ABCDEF12',
      allAddresses: ['0xABCDEF1234567890ABCDEF1234567890ABCDEF12'],
    });

    await service.upsertWallets('mock-profile-uuid-42', addressData, 'ethos_api');

    for (const w of mockDb._wallets) {
      expect(w.address).toBe(w.address.toLowerCase());
      expect(w.address).toBe('0xabcdef1234567890abcdef1234567890abcdef12');
    }
  });

  it('sets isPrimary=true only for the primary address, false for all others', async () => {
    const primary = '0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA';
    const secondary = '0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB';

    const addressData = makeAddressData({
      primaryAddress: primary,
      allAddresses: [primary, secondary],
    });

    await service.upsertWallets('mock-profile-uuid-42', addressData, 'ethos_api');

    const primaryRows = mockDb._wallets.filter((w) => w.address === primary.toLowerCase());
    const secondaryRows = mockDb._wallets.filter((w) => w.address === secondary.toLowerCase());

    expect(primaryRows).toHaveLength(NUM_CHAINS);
    expect(primaryRows.every((w) => w.isPrimary)).toBe(true);

    expect(secondaryRows).toHaveLength(NUM_CHAINS);
    expect(secondaryRows.every((w) => !w.isPrimary)).toBe(true);
  });

  it('is idempotent — each call produces the same count (onConflictDoUpdate)', async () => {
    const addressData = makeAddressData({
      allAddresses: ['0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    });

    const countFirst = await service.upsertWallets(
      'mock-profile-uuid-42',
      addressData,
      'ethos_api',
    );
    const countSecond = await service.upsertWallets(
      'mock-profile-uuid-42',
      addressData,
      'ethos_api',
    );

    // Both calls return the same count — deterministic upsert behaviour
    expect(countFirst).toBe(NUM_CHAINS);
    expect(countSecond).toBe(NUM_CHAINS);
  });

  it('handles empty allAddresses gracefully — returns 0, inserts nothing', async () => {
    const addressData: EthosAddressData = {
      primaryAddress: null,
      allAddresses: [],
    };

    const count = await service.upsertWallets('mock-profile-uuid-42', addressData, 'ethos_api');

    expect(count).toBe(0);
    expect(mockDb._wallets).toHaveLength(0);
  });

  it('covers all 6 supported chains for a single address', async () => {
    const address = '0xCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCCC';
    const addressData = makeAddressData({
      primaryAddress: address,
      allAddresses: [address],
    });

    await service.upsertWallets('mock-profile-uuid-42', addressData, 'ethos_api');

    const chains = mockDb._wallets.map((w) => w.chain).sort();
    const expectedChains = Object.keys(SUPPORTED_CHAINS).sort();

    expect(chains).toEqual(expectedChains);
  });
});

// ---------------------------------------------------------------------------
// runFullSync integration tests (mock client + mock db)
// ---------------------------------------------------------------------------

describe('ProfileSyncService — runFullSync', () => {
  it('processes all profiles and counts wallets correctly', async () => {
    const profile = makeProfile({ id: 1 });
    const addressData = makeAddressData({
      allAddresses: ['0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    });

    const client = makeMockClient([profile], new Map([[1, addressData]]));
    const mockDb = makeMockDb();
    const service = new ProfileSyncService(client, () => mockDb as unknown as Db);

    const stats = await service.runFullSync();

    expect(stats.profilesProcessed).toBe(1);
    expect(stats.profilesUpserted).toBe(1);
    expect(stats.walletsUpserted).toBe(NUM_CHAINS); // 1 address × 6 chains
    expect(stats.errors).toBe(0);
    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('counts walletsSkipped when profile has no addresses', async () => {
    const profile = makeProfile({ id: 99 });
    const client = makeMockClient([profile], new Map());
    const mockDb = makeMockDb();
    const service = new ProfileSyncService(client, () => mockDb as unknown as Db);

    const stats = await service.runFullSync();

    expect(stats.profilesProcessed).toBe(1);
    expect(stats.walletsSkipped).toBe(1);
    expect(stats.walletsUpserted).toBe(0);
  });

  it('dryRun mode does not write to the database', async () => {
    const profile = makeProfile({ id: 2 });
    const addressData = makeAddressData({
      allAddresses: ['0xBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB'],
    });

    const client = makeMockClient([profile], new Map([[2, addressData]]));
    const mockDb = makeMockDb();
    const service = new ProfileSyncService(client, () => mockDb as unknown as Db);

    const stats = await service.runFullSync({ dryRun: true });

    expect(mockDb._wallets).toHaveLength(0);
    expect(mockDb._profiles).toHaveLength(0);
    expect(stats.walletsUpserted).toBe(NUM_CHAINS);
  });
});
