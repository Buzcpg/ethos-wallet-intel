import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FirstFunderMatcher } from '../firstFunderMatcher.js';

// ---------------------------------------------------------------------------
// DB mock
// ---------------------------------------------------------------------------

const DRIZZLE_NAME = Symbol.for('drizzle:Name');
function tableName(t: unknown): string {
  return (t as Record<symbol, string>)[DRIZZLE_NAME] ?? '';
}

interface WalletMatchRow {
  id: string;
  walletAId: string;
  walletBId: string;
  matchType: string;
  chain: string;
  matchKey: string;
  score: string;
}

interface ProfileMatchRow {
  id: string;
  profileAId: string;
  profileBId: string;
  score: string;
  signalCount: number;
}

interface WalletRow {
  id: string;
  profileId: string | null;
  address: string;
  chain: string;
}

type MockRow = Record<string, unknown>;

function makeMockDb(opts: {
  sharedFunderRows?: MockRow[];
  directFunderRows?: MockRow[];
  walletProfileRows?: WalletRow[];
  existingWalletMatches?: WalletMatchRow[];
  existingProfileMatches?: ProfileMatchRow[];
}) {
  const walletMatchStore: WalletMatchRow[] = [...(opts.existingWalletMatches ?? [])];
  const profileMatchStore: ProfileMatchRow[] = [...(opts.existingProfileMatches ?? [])];
  let execCallCount = 0;

  // execute calls are interleaved: call 0 = sharedFunder GROUP query,
  // calls 1..N = existence checks (one per shared funder group, N = sharedFunderRows.length),
  // call N+1 = direct funder query, calls N+2.. = existence checks for direct funder pairs.
  const numSharedGroups = (opts.sharedFunderRows ?? []).length;
  const directFunderCallIdx = 1 + numSharedGroups;

  const db = {
    _walletMatches: walletMatchStore,
    _profileMatches: profileMatchStore,

    execute: vi.fn((_sql: unknown) => {
      const call = execCallCount++;
      if (call === 0) return Promise.resolve({ rows: opts.sharedFunderRows ?? [] });
      if (call === directFunderCallIdx) return Promise.resolve({ rows: opts.directFunderRows ?? [] });
      // All other calls are bulk wallet_match existence checks
      return Promise.resolve({
        rows: walletMatchStore.map((m) => ({
          wallet_a_id: m.walletAId,
          wallet_b_id: m.walletBId,
        })),
      });
    }),

    select: (_fields: unknown) => ({
      from: (table: unknown) => {
        const name = tableName(table);
        return {
          // Used for resolveProfileIds (wallets table, no .limit) and
          // existingProfileMatches (profile_matches table, no .limit)
          where: (_cond: unknown) => {
            if (name === 'wallets') {
              return Promise.resolve(opts.walletProfileRows ?? []);
            }
            if (name === 'profile_matches') {
              return Promise.resolve([...profileMatchStore]);
            }
            return Promise.resolve([]);
          },
        };
      },
    }),

    insert: (_table: unknown) => {
      const name = tableName(_table);
      return {
        values: (vals: unknown) => {
          const valsArray = Array.isArray(vals)
            ? (vals as Record<string, unknown>[])
            : [vals as Record<string, unknown>];
          if (name === 'wallet_matches') {
            for (const v of valsArray) walletMatchStore.push(v as unknown as WalletMatchRow);
          }
          if (name === 'profile_matches') {
            for (const v of valsArray) profileMatchStore.push(v as unknown as ProfileMatchRow);
          }
          return Promise.resolve();
        },
      };
    },

    update: (_table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          if (profileMatchStore.length > 0) {
            const pm = profileMatchStore[0]!;
            if ('score' in vals) pm.score = vals['score'] as string;
            if ('signalCount' in vals) pm.signalCount = vals['signalCount'] as number;
          }
          return Promise.resolve();
        },
      }),
    }),
  };

  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('FirstFunderMatcher', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('detects shared funder group and creates wallet_match pairs', async () => {
    const db = makeMockDb({
      sharedFunderRows: [
        { funder_address: '0xfunder1', wallet_ids: ['w1', 'w2'] },
      ],
      directFunderRows: [],
      walletProfileRows: [
        { id: 'w1', profileId: 'p1', address: '0x111', chain: 'ethereum' },
        { id: 'w2', profileId: 'p2', address: '0x222', chain: 'ethereum' },
      ],
    });

    const matcher = new FirstFunderMatcher(() => db as never);
    const stats = await matcher.detectMatches('ethereum');

    expect(stats.sharedFunderGroups).toBe(1);
    expect(stats.walletMatchesCreated).toBe(1);
    expect(db._walletMatches[0]!.matchType).toBe('shared_first_funder');
    expect(db._walletMatches[0]!.score).toBe('85.00');
  });

  it('does not create duplicate wallet matches on second run', async () => {
    // Pre-populate the existing wallet match — the select.where.limit will return it
    const existingMatch: WalletMatchRow = {
      id: 'wm1',
      walletAId: 'w1',
      walletBId: 'w2',
      matchType: 'shared_first_funder',
      chain: 'ethereum',
      matchKey: '0xfunder1',
      score: '85.00',
    };

    const db = makeMockDb({
      sharedFunderRows: [
        { funder_address: '0xfunder1', wallet_ids: ['w1', 'w2'] },
      ],
      directFunderRows: [],
      walletProfileRows: [],
      existingWalletMatches: [existingMatch],
    });

    const matcher = new FirstFunderMatcher(() => db as never);
    const stats = await matcher.detectMatches('ethereum');

    // walletMatchesCreated should be 0 (already exists)
    expect(stats.walletMatchesCreated).toBe(0);
    expect(db._walletMatches).toHaveLength(1); // no duplicate
  });

  it('creates direct_funder match with score 95', async () => {
    const db = makeMockDb({
      sharedFunderRows: [],
      directFunderRows: [
        { funded_wallet: 'w1', funder_wallet: 'w2', funder_address: '0xfunderaddr' },
      ],
      walletProfileRows: [
        { id: 'w1', profileId: 'p1', address: '0x111', chain: 'ethereum' },
        { id: 'w2', profileId: 'p2', address: '0xfunderaddr', chain: 'ethereum' },
      ],
    });

    const matcher = new FirstFunderMatcher(() => db as never);
    const stats = await matcher.detectMatches('ethereum');

    expect(stats.walletMatchesCreated).toBe(1);
    const wm = db._walletMatches[0]!;
    expect(wm.matchType).toBe('direct_funder');
    expect(wm.score).toBe('95.00');
  });

  it('returns zero stats when funders are unique (no shared groups)', async () => {
    const db = makeMockDb({
      sharedFunderRows: [],
      directFunderRows: [],
    });

    const matcher = new FirstFunderMatcher(() => db as never);
    const stats = await matcher.detectMatches('ethereum');

    expect(stats.sharedFunderGroups).toBe(0);
    expect(stats.walletMatchesCreated).toBe(0);
    expect(stats.profileMatchesCreated).toBe(0);
  });

  it('creates profile match when wallets have different profiles', async () => {
    const db = makeMockDb({
      sharedFunderRows: [
        { funder_address: '0xfunder1', wallet_ids: ['w1', 'w2'] },
      ],
      directFunderRows: [],
      walletProfileRows: [
        { id: 'w1', profileId: 'pA', address: '0x111', chain: 'ethereum' },
        { id: 'w2', profileId: 'pB', address: '0x222', chain: 'ethereum' },
      ],
    });

    const matcher = new FirstFunderMatcher(() => db as never);
    await matcher.detectMatches('ethereum');

    expect(db._profileMatches).toHaveLength(1);
    expect(db._profileMatches[0]!.signalCount).toBe(1);
    expect(parseFloat(db._profileMatches[0]!.score)).toBe(85);
  });
});
