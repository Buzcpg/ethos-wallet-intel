import { describe, it, expect, vi, beforeEach } from 'vitest';
import { P2PScanner } from '../p2pScanner.js';
import type { RawTransaction } from '../../chains/transactionFetcher.js';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

const DRIZZLE_NAME = Symbol.for('drizzle:Name');
function tableName(t: unknown): string {
  return (t as Record<symbol, string>)[DRIZZLE_NAME] ?? '';
}

interface WalletRow {
  id: string;
  address: string;
  profileId: string | null;
  chain: string;
}

interface WalletMatchRow {
  id: string;
  walletAId: string;
  walletBId: string;
  matchType: string;
  chain: string;
  matchKey: string;
  score: string;
  evidenceJson?: unknown;
}

interface ProfileMatchRow {
  id: string;
  profileAId: string;
  profileBId: string;
  score: string;
  signalCount: number;
}

function makeMockDb(opts: {
  trackedWallets?: WalletRow[];
  selfWallet?: WalletRow;
  existingMatches?: WalletMatchRow[];
  existingProfileMatches?: ProfileMatchRow[];
}) {
  const trackedWallets: WalletRow[] = opts.trackedWallets ?? [];
  const selfWallet: WalletRow | undefined = opts.selfWallet;
  const walletMatches: WalletMatchRow[] = [...(opts.existingMatches ?? [])];
  const profileMatches: ProfileMatchRow[] = [...(opts.existingProfileMatches ?? [])];
  let nextId = 1;

  const db = {
    _walletMatches: walletMatches,
    _profileMatches: profileMatches,

    select: (_fields: unknown) => ({
      from: (table: unknown) => {
        const name = tableName(table);
        return {
          where: (_cond: unknown) => {
            // .where().limit() — used for self wallet lookup and idempotency checks
            return {
              limit: (_n: number) => {
                if (name === 'wallets' && selfWallet) {
                  return Promise.resolve([{ profileId: selfWallet.profileId }]);
                }
                if (name === 'wallet_matches') {
                  return Promise.resolve(
                    walletMatches.length > 0 ? [walletMatches[walletMatches.length - 1]] : [],
                  );
                }
                if (name === 'profile_matches') {
                  return Promise.resolve(
                    profileMatches.length > 0
                      ? [profileMatches[profileMatches.length - 1]]
                      : [],
                  );
                }
                return Promise.resolve([]);
              },
              // .where() without .limit() — used for inArray (tracked wallet lookup)
              then: (resolve: (v: WalletRow[]) => unknown) => {
                resolve(trackedWallets);
                return Promise.resolve(trackedWallets);
              },
            };
          },
        };
      },
    }),

    insert: (table: unknown) => {
      const name = tableName(table);
      return {
        values: (vals: Record<string, unknown>) => {
          if (name === 'wallet_matches') {
            walletMatches.push({ id: `wm-${nextId++}`, ...(vals as Omit<WalletMatchRow, 'id'>) });
          }
          if (name === 'profile_matches') {
            profileMatches.push({ id: `pm-${nextId++}`, ...(vals as Omit<ProfileMatchRow, 'id'>) });
          }
          return Promise.resolve();
        },
      };
    },

    update: (_table: unknown) => ({
      set: (_vals: unknown) => ({
        where: (_cond: unknown) => Promise.resolve(),
      }),
    }),
  };

  return db;
}

// ---------------------------------------------------------------------------
// Test data
// ---------------------------------------------------------------------------

const WALLET_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const WALLET_ADDR = '0xmywallet';
const COUNTERPARTY_ID = 'bbbbbbbb-0000-0000-0000-000000000002';
const COUNTERPARTY_ADDR = '0xcounterparty';
const CHAIN = 'ethereum' as const;

function makeTx(overrides: Partial<RawTransaction> = {}): RawTransaction {
  return {
    txHash: '0xtx1',
    fromAddress: '0xcounterparty',
    toAddress: '0xmywallet',
    blockNumber: 1000n,
    blockTimestamp: new Date('2024-01-01'),
    valueWei: '1000000000000000000',
    isInbound: true,
    chain: CHAIN,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('P2PScanner', () => {
  beforeEach(() => vi.clearAllMocks());

  it('detects inbound tx from tracked wallet and creates match', async () => {
    const trackedWallet: WalletRow = {
      id: COUNTERPARTY_ID,
      address: COUNTERPARTY_ADDR,
      profileId: 'profile-b',
      chain: CHAIN,
    };
    const selfWallet: WalletRow = {
      id: WALLET_ID,
      address: WALLET_ADDR,
      profileId: 'profile-a',
      chain: CHAIN,
    };

    const db = makeMockDb({
      trackedWallets: [trackedWallet],
      selfWallet,
      existingMatches: [],
    });

    // Override select to handle inArray (no limit) and single lookup (with limit) separately
    let selectCallCount = 0;
    // eslint-disable-next-line
    // @ts-ignore
    db.select = (_: unknown) => ({
      from: (table: unknown) => {
        const name = tableName(table);
        return {
          where: (_cond: unknown) => {
            selectCallCount++;
            if (name === 'wallets') {
              // First call: inArray lookup for counterparties → return trackedWallet
              // Second call: self wallet lookup (with limit)
              return {
                then: (resolve: (v: WalletRow[]) => unknown) => {
                  resolve([trackedWallet]);
                  return Promise.resolve([trackedWallet]);
                },
                limit: (_n: number) => Promise.resolve([{ profileId: selfWallet.profileId }]),
              };
            }
            if (name === 'wallet_matches') {
              return { limit: (_n: number) => Promise.resolve([]) }; // no existing match
            }
            if (name === 'profile_matches') {
              return { limit: (_n: number) => Promise.resolve([]) };
            }
            return { limit: (_n: number) => Promise.resolve([]) };
          },
        };
      },
    });

    const p2p = new P2PScanner(() => db as never);
    const tx = makeTx({ isInbound: true, fromAddress: COUNTERPARTY_ADDR, toAddress: WALLET_ADDR });
    const result = await p2p.scanTransactions(WALLET_ID, WALLET_ADDR, [tx], CHAIN);

    expect(result.matchesFound).toBe(1);
    expect(db._walletMatches).toHaveLength(1);
    expect(db._walletMatches[0]!.matchType).toBe('direct_wallet_interaction');
  });

  it('detects outbound tx to tracked wallet', async () => {
    const trackedWallet: WalletRow = {
      id: COUNTERPARTY_ID,
      address: COUNTERPARTY_ADDR,
      profileId: 'profile-b',
      chain: CHAIN,
    };

    const db = makeMockDb({ trackedWallets: [trackedWallet], existingMatches: [] });

    // eslint-disable-next-line
    // @ts-ignore
    db.select = (_: unknown) => ({
      from: (table: unknown) => {
        const name = tableName(table);
        return {
          where: (_cond: unknown) => ({
            then: (resolve: (v: WalletRow[]) => unknown) => {
              resolve(name === 'wallets' ? [trackedWallet] : []);
              return Promise.resolve(name === 'wallets' ? [trackedWallet] : []);
            },
            limit: (_n: number) => Promise.resolve([]),
          }),
        };
      },
    });

    const p2p = new P2PScanner(() => db as never);
    const tx = makeTx({
      isInbound: false,
      fromAddress: WALLET_ADDR,
      toAddress: COUNTERPARTY_ADDR,
    });
    const result = await p2p.scanTransactions(WALLET_ID, WALLET_ADDR, [tx], CHAIN);

    expect(result.matchesFound).toBe(1);
  });

  it('is idempotent — existing match is not duplicated', async () => {
    const trackedWallet: WalletRow = {
      id: COUNTERPARTY_ID,
      address: COUNTERPARTY_ADDR,
      profileId: null,
      chain: CHAIN,
    };
    const existingMatch: WalletMatchRow = {
      id: 'wm-existing',
      walletAId: WALLET_ID < COUNTERPARTY_ID ? WALLET_ID : COUNTERPARTY_ID,
      walletBId: WALLET_ID < COUNTERPARTY_ID ? COUNTERPARTY_ID : WALLET_ID,
      matchType: 'direct_wallet_interaction',
      chain: CHAIN,
      matchKey: COUNTERPARTY_ADDR,
      score: '70.00',
    };

    const db = makeMockDb({ trackedWallets: [trackedWallet], existingMatches: [existingMatch] });
    // eslint-disable-next-line
    // @ts-ignore
    db.select = (_: unknown) => ({
      from: (table: unknown) => {
        const name = tableName(table);
        return {
          where: (_cond: unknown) => ({
            then: (resolve: (v: WalletRow[]) => unknown) => {
              resolve(name === 'wallets' ? [trackedWallet] : []);
              return Promise.resolve(name === 'wallets' ? [trackedWallet] : []);
            },
            limit: (_n: number) => {
              if (name === 'wallet_matches') return Promise.resolve([existingMatch]);
              return Promise.resolve([]);
            },
          }),
        };
      },
    });

    const p2p = new P2PScanner(() => db as never);
    const tx = makeTx({ isInbound: true, fromAddress: COUNTERPARTY_ADDR });

    await p2p.scanTransactions(WALLET_ID, WALLET_ADDR, [tx], CHAIN);
    await p2p.scanTransactions(WALLET_ID, WALLET_ADDR, [tx], CHAIN);

    // Still only the original match, no new inserts
    expect(db._walletMatches).toHaveLength(1);
  });

  it('returns zero matches when counterparty is not tracked', async () => {
    const db = makeMockDb({ trackedWallets: [] }); // no tracked wallets
    // eslint-disable-next-line
    // @ts-ignore
    db.select = (_: unknown) => ({
      from: (_t: unknown) => ({
        where: (_c: unknown) => ({
          then: (resolve: (v: WalletRow[]) => unknown) => {
            resolve([]);
            return Promise.resolve([]);
          },
          limit: (_n: number) => Promise.resolve([]),
        }),
      }),
    });

    const p2p = new P2PScanner(() => db as never);
    const tx = makeTx({ fromAddress: '0xuntracked', toAddress: WALLET_ADDR });
    const result = await p2p.scanTransactions(WALLET_ID, WALLET_ADDR, [tx], CHAIN);

    expect(result.matchesFound).toBe(0);
    expect(db._walletMatches).toHaveLength(0);
  });

  it('handles empty transaction list gracefully', async () => {
    const db = makeMockDb({});
    const p2p = new P2PScanner(() => db as never);
    const result = await p2p.scanTransactions(WALLET_ID, WALLET_ADDR, [], CHAIN);
    expect(result.matchesFound).toBe(0);
  });
});
