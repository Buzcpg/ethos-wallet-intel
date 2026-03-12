import { describe, it, expect, beforeEach, vi } from 'vitest';
import { ProfileSyncService } from '../profileSync.js';
import { SUPPORTED_CHAINS } from '../../chains/index.js';
import type { IEthosApiClient, EthosProfile, EthosAddressData } from '../../ethos/client.js';
import type { Db } from '../../db/client.js';

// ---------------------------------------------------------------------------
// Mock enqueueJob — new-user fast path calls this for new wallet rows
// ---------------------------------------------------------------------------

vi.mock('../../queue/index.js', () => ({
  enqueueJob: vi.fn().mockResolvedValue({ id: 'mock-job-id' }),
}));

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
  externalProfileId: number;
  displayName: string;
  slug: string | null | undefined;
  status: string;
}

function makeMockDb(opts?: { existingWallets?: boolean }) {
  const insertedWallets: InsertedWallet[] = [];
  const insertedProfiles: InsertedProfile[] = [];
  // Simulate whether the wallet already existed (xmax > 0) or is new (xmax = 0)
  const existingWallets = opts?.existingWallets ?? false;

  const mockDb = {
    _wallets: insertedWallets,
    _profiles: insertedProfiles,

    insert: (table: unknown) => {
      const name = tableName(table);

      return {
        values: (vals: Record<string, unknown> | Record<string, unknown>[]) => {
          const valsArray = Array.isArray(vals) ? vals : [vals];

          const onConflictDoUpdate = (_opts: unknown) => {
            // Side effect for profiles: push now (profiles upsert doesn't call .returning())
            if (name === 'profiles') {
              for (const v of valsArray) {
                const p = v as unknown as InsertedProfile;
                const idx = insertedProfiles.findIndex(
                  (x) => x.externalProfileId === p.externalProfileId,
                );
                if (idx >= 0) {
                  insertedProfiles[idx] = p;
                } else {
                  insertedProfiles.push(p);
                }
              }
            }

            // Return a Promise (for upsertProfiles which awaits without .returning())
            // plus a .returning() method (for upsertWallets which chains .returning())
            const base = Promise.resolve([] as unknown[]);
            return Object.assign(base, {
              returning: (_cols: unknown): Promise<unknown[]> => {
                if (name === 'wallets') {
                  for (const v of valsArray) {
                    insertedWallets.push(v as unknown as InsertedWallet);
                  }
                  return Promise.resolve(
                    valsArray.map((v) => ({
                      id: v['id'] as string,
                      chain: v['chain'] as string,
                      xmax: existingWallets ? '1' : '0',
                    })),
                  );
                }
                return Promise.resolve([]);
              },
            });
          };

          return { onConflictDoUpdate };
        },
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
    vi.clearAllMocks();
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

  it('enqueues new_user job for new wallet rows (xmax=0)', async () => {
    const { enqueueJob } = await import('../../queue/index.js');
    const addressData = makeAddressData({
      allAddresses: ['0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    });

    await service.upsertWallets('mock-profile-uuid-42', addressData, 'ethos_api');

    // xmax=0 (new row) → new_user job enqueued for each chain
    expect(enqueueJob).toHaveBeenCalledTimes(NUM_CHAINS);
    expect(vi.mocked(enqueueJob).mock.calls[0]?.[2]).toBe('new_user');
  });

  it('does not enqueue new_user job for existing wallet rows (xmax>0)', async () => {
    const { enqueueJob } = await import('../../queue/index.js');
    // Use a mock DB that simulates existing rows
    const existingDb = makeMockDb({ existingWallets: true });
    const existingService = new ProfileSyncService(
      makeMockClient([], new Map()),
      () => existingDb as unknown as Db,
    );

    const addressData = makeAddressData({
      allAddresses: ['0xAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'],
    });

    await existingService.upsertWallets('mock-profile-uuid-42', addressData, 'ethos_api');

    // xmax='1' (existing row) → no new_user jobs
    expect(enqueueJob).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// runFullSync integration tests (mock client + mock db)
// ---------------------------------------------------------------------------

describe('ProfileSyncService — runFullSync', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

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
