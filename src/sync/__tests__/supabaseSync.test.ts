import { describe, it, expect, vi, beforeEach } from 'vitest';
import { parseAddressesFromUserkeys, toEthosProfile, SupabaseSync } from '../supabaseSync.js';
import type { SupabaseProfileRow } from '../supabaseSync.js';
import type { ProfileSyncService } from '../profileSync.js';

// ---------------------------------------------------------------------------
// parseAddressesFromUserkeys
// ---------------------------------------------------------------------------

describe('parseAddressesFromUserkeys', () => {
  it('extracts address entries from userkeys', () => {
    const result = parseAddressesFromUserkeys([
      'address:0xABC',
      'address:0xDEF',
      'service:x.com:12345',
      'profileId:42',
    ]);
    expect(result.allAddresses).toEqual(['0xABC', '0xDEF']);
    expect(result.primaryAddress).toBe('0xABC');
  });

  it('returns empty when no address entries', () => {
    const result = parseAddressesFromUserkeys(['service:x.com:123', 'profileId:1']);
    expect(result.allAddresses).toEqual([]);
    expect(result.primaryAddress).toBeNull();
  });

  it('handles null/undefined userkeys gracefully', () => {
    expect(parseAddressesFromUserkeys(null).allAddresses).toEqual([]);
    expect(parseAddressesFromUserkeys(undefined).allAddresses).toEqual([]);
    expect(parseAddressesFromUserkeys([]).allAddresses).toEqual([]);
  });

  it('strips exactly the "address:" prefix', () => {
    const result = parseAddressesFromUserkeys(['address:0x0000000000000000000000000000000000000001']);
    expect(result.allAddresses[0]).toBe('0x0000000000000000000000000000000000000001');
  });
});

// ---------------------------------------------------------------------------
// toEthosProfile
// ---------------------------------------------------------------------------

describe('toEthosProfile', () => {
  it('maps row fields to EthosProfile shape', () => {
    const row: SupabaseProfileRow = {
      raw_profile_id: 42,
      display_name: 'Alice',
      username: 'alice99',
      status: 'ACTIVE',
      score: 1234,
      userkeys: ['address:0xABC', 'profileId:42'],
    };
    const p = toEthosProfile(row);
    expect(p.id).toBe(42);
    expect(p.displayName).toBe('Alice');
    expect(p.username).toBe('alice99');
    expect(p.status).toBe('ACTIVE');
    expect(p.score).toBe(1234);
    expect(p.userkeys).toEqual(row.userkeys);
  });

  it('uses sensible defaults for null fields', () => {
    const row: SupabaseProfileRow = {
      raw_profile_id: 1,
      display_name: null,
      username: null,
      status: null,
      score: null,
      userkeys: null,
    };
    const p = toEthosProfile(row);
    expect(p.displayName).toBe('');
    expect(p.username).toBeNull();
    expect(p.status).toBe('ACTIVE');
    expect(p.score).toBe(0);
    expect(p.userkeys).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// SupabaseSync.ingestBatch
// ---------------------------------------------------------------------------

const makeRow = (id: number, addresses: string[]): SupabaseProfileRow => ({
  raw_profile_id: id,
  display_name: `User ${id}`,
  username: `user${id}`,
  status: 'ACTIVE',
  score: 100,
  userkeys: [...addresses.map((a) => `address:${a}`), `profileId:${id}`],
});

describe('SupabaseSync.ingestBatch', () => {
  let mockProfileSync: Partial<ProfileSyncService>;
  let sync: SupabaseSync;

  beforeEach(() => {
    mockProfileSync = {
      upsertProfiles: vi.fn().mockResolvedValue(undefined),
      getInternalProfileId: vi.fn().mockImplementation((id: string) =>
        Promise.resolve(`internal-${id}`),
      ),
      upsertWallets: vi.fn().mockResolvedValue(6), // 1 address × 6 chains
    };
    sync = new SupabaseSync(mockProfileSync as ProfileSyncService);
  });

  it('returns zeroed stats for empty batch', async () => {
    const stats = await sync.ingestBatch([]);
    expect(stats).toEqual({ profilesUpserted: 0, walletsUpserted: 0, skipped: 0, errors: 0 });
    expect(mockProfileSync.upsertProfiles).not.toHaveBeenCalled();
  });

  it('upserts profiles then wallets for each row', async () => {
    const rows = [makeRow(1, ['0xAAA']), makeRow(2, ['0xBBB', '0xCCC'])];
    const stats = await sync.ingestBatch(rows);

    expect(mockProfileSync.upsertProfiles).toHaveBeenCalledOnce();
    expect(mockProfileSync.getInternalProfileId).toHaveBeenCalledTimes(2);
    expect(mockProfileSync.upsertWallets).toHaveBeenCalledTimes(2);
    expect(stats.profilesUpserted).toBe(2);
    expect(stats.walletsUpserted).toBe(12); // 6 per profile (mocked)
    expect(stats.skipped).toBe(0);
    expect(stats.errors).toBe(0);
  });

  it('skips profiles with no addresses in userkeys', async () => {
    const rows = [makeRow(1, []), makeRow(2, ['0xBBB'])];
    const stats = await sync.ingestBatch(rows);

    expect(stats.skipped).toBe(1);
    expect(stats.profilesUpserted).toBe(1);
  });

  it('counts error when getInternalProfileId returns null', async () => {
    mockProfileSync.getInternalProfileId = vi.fn().mockResolvedValue(null);
    const rows = [makeRow(1, ['0xAAA'])];
    const stats = await sync.ingestBatch(rows);

    expect(stats.errors).toBe(1);
    expect(stats.profilesUpserted).toBe(0);
    expect(mockProfileSync.upsertWallets).not.toHaveBeenCalled();
  });

  it('counts error when upsertWallets throws', async () => {
    mockProfileSync.upsertWallets = vi.fn().mockRejectedValue(new Error('DB error'));
    const rows = [makeRow(1, ['0xAAA'])];
    const stats = await sync.ingestBatch(rows);

    expect(stats.errors).toBe(1);
    expect(stats.profilesUpserted).toBe(0);
  });

  it('passes correct addressData to upsertWallets', async () => {
    const rows = [makeRow(99, ['0x111', '0x222'])];
    await sync.ingestBatch(rows);

    expect(mockProfileSync.upsertWallets).toHaveBeenCalledWith(
      'internal-99',
      { primaryAddress: '0x111', allAddresses: ['0x111', '0x222'] },
      'supabase',
    );
  });
});
