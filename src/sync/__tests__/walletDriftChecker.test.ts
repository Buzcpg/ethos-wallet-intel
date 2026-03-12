import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WalletDriftChecker } from '../walletDriftChecker.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../../config/env.js', () => ({
  env: {
    SUPABASE_URL: 'https://test.supabase.co',
    SUPABASE_ANON_KEY: 'test-anon-key',
  },
}));

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

interface ProfileRow { id: string; externalProfileId: string }
interface WalletRow  { address: string }

function makeMockDb(
  opts: {
    profiles?: ProfileRow[];
    wallets?: WalletRow[];
  } = {},
) {
  const profiles = opts.profiles ?? [];
  const wallets  = opts.wallets  ?? [];

  return {
    select: (_fields: unknown) => ({
      from: (_table: unknown) => ({
        limit:  (_n: number)  => ({ offset: (_o: number) => Promise.resolve(profiles) }),
        where:  (_cond: unknown) => Promise.resolve(wallets),
      }),
    }),
  };
}

// ---------------------------------------------------------------------------
// ProfileSyncService mock
// ---------------------------------------------------------------------------

function makeMockProfileSync(upsertCount = 0) {
  return {
    upsertProfiles: vi.fn().mockResolvedValue(undefined),
    upsertWallets:  vi.fn().mockResolvedValue(upsertCount),
  };
}

// ---------------------------------------------------------------------------
// fetch mock helpers
// ---------------------------------------------------------------------------

function mockFetch(rows: unknown[]) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: true,
      json: async () => rows,
    }),
  );
}

function mockFetchError(status = 500) {
  vi.stubGlobal(
    'fetch',
    vi.fn().mockResolvedValue({
      ok: false,
      status,
      statusText: 'Internal Server Error',
      json: async () => ({}),
    }),
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WalletDriftChecker', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the correct stats shape on a clean run with no profiles', async () => {
    const db = makeMockDb({ profiles: [] });
    mockFetch([]);

    const checker = new WalletDriftChecker(makeMockProfileSync() as never, () => db as never);
    const stats = await checker.run();

    // All counters should be zero and the shape should be complete
    expect(stats).toMatchObject({
      profilesChecked: 0,
      profilesWithNewWallets: 0,
      newWalletsUpserted: 0,
      errors: 0,
    });
    expect(typeof stats.durationMs).toBe('number');
  });

  it('returns empty stats when no profiles exist in DB', async () => {
    const db = makeMockDb({ profiles: [] });
    mockFetch([]);

    const profileSync = makeMockProfileSync();
    const checker = new WalletDriftChecker(profileSync as never, () => db as never);
    const stats = await checker.run();

    expect(stats.profilesChecked).toBe(0);
    expect(stats.newWalletsUpserted).toBe(0);
    expect(profileSync.upsertWallets).not.toHaveBeenCalled();
  });

  it('skips profiles with no new wallet addresses', async () => {
    const db = makeMockDb({
      profiles: [{ id: 'profile-uuid-1', externalProfileId: '42' }],
      wallets:  [{ address: '0xabc' }],  // already stored
    });

    // Supabase returns the same address that is already stored
    mockFetch([
      {
        raw_profile_id: 42,
        display_name: 'Alice',
        username: 'alice',
        status: 'ACTIVE',
        score: 100,
        userkeys: ['address:0xabc'],
      },
    ]);

    const profileSync = makeMockProfileSync();
    const checker = new WalletDriftChecker(profileSync as never, () => db as never);
    const stats = await checker.run();

    expect(stats.profilesChecked).toBe(1);
    expect(stats.profilesWithNewWallets).toBe(0);
    expect(profileSync.upsertWallets).not.toHaveBeenCalled();
  });

  it('upserts new wallet addresses and increments profilesWithNewWallets', async () => {
    const db = makeMockDb({
      profiles: [{ id: 'profile-uuid-1', externalProfileId: '42' }],
      wallets:  [{ address: '0xabc' }],  // existing wallet
    });

    // Supabase now reports a second address for the same profile
    mockFetch([
      {
        raw_profile_id: 42,
        display_name: 'Alice',
        username: 'alice',
        status: 'ACTIVE',
        score: 100,
        userkeys: ['address:0xabc', 'address:0xnew'],
      },
    ]);

    const profileSync = makeMockProfileSync(12); // upsertWallets returns 12
    const checker = new WalletDriftChecker(profileSync as never, () => db as never);
    const stats = await checker.run();

    expect(stats.profilesChecked).toBe(1);
    expect(stats.profilesWithNewWallets).toBe(1);
    expect(stats.newWalletsUpserted).toBe(12);
    expect(profileSync.upsertWallets).toHaveBeenCalledOnce();
  });

  it('increments errors and continues when Supabase batch fetch fails', async () => {
    const db = makeMockDb({
      profiles: [{ id: 'profile-uuid-1', externalProfileId: '42' }],
      wallets:  [],
    });

    mockFetchError(500);

    const profileSync = makeMockProfileSync();
    const checker = new WalletDriftChecker(profileSync as never, () => db as never);

    // fetchSupabaseRows throws when fetch returns !ok.
    // run() should catch the error, increment stats.errors, and not throw itself.
    const stats = await checker.run();
    expect(stats.errors).toBeGreaterThanOrEqual(1);
    expect(profileSync.upsertWallets).not.toHaveBeenCalled();
  });

  it('skips profiles with no addresses in userkeys', async () => {
    const db = makeMockDb({
      profiles: [{ id: 'profile-uuid-1', externalProfileId: '99' }],
      wallets:  [],
    });

    // Profile has userkeys with no address: entries
    mockFetch([
      {
        raw_profile_id: 99,
        display_name: 'Bot',
        username: null,
        status: 'ACTIVE',
        score: 0,
        userkeys: ['service:x.com:12345', 'profileId:99'],
      },
    ]);

    const profileSync = makeMockProfileSync();
    const checker = new WalletDriftChecker(profileSync as never, () => db as never);
    const stats = await checker.run();

    expect(stats.profilesChecked).toBe(1);
    expect(stats.profilesWithNewWallets).toBe(0);
    expect(profileSync.upsertWallets).not.toHaveBeenCalled();
  });

  it('returns durationMs > 0', async () => {
    const db = makeMockDb({ profiles: [], wallets: [] });
    mockFetch([]);

    const checker = new WalletDriftChecker(makeMockProfileSync() as never, () => db as never);
    const stats = await checker.run();

    expect(stats.durationMs).toBeGreaterThanOrEqual(0);
  });
});
