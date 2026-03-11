import { describe, it, expect, vi, beforeEach } from 'vitest';
import { FirstFunderScanner } from '../firstFunderScanner.js';
import type { ChainAdapter, FirstInboundTx } from '../../chains/adapter.js';

// ---------------------------------------------------------------------------
// Mock the adapter registry
// ---------------------------------------------------------------------------

vi.mock('../../chains/adapterRegistry.js', () => ({
  getAdapter: vi.fn(),
}));

// Mock env
vi.mock('../../config/env.js', () => ({
  env: {
    SCANNER_CONCURRENCY: 5,
    SCANNER_DELAY_MS: 0,
  },
}));

import { getAdapter } from '../../chains/adapterRegistry.js';

// ---------------------------------------------------------------------------
// DB mock helpers
// ---------------------------------------------------------------------------

const DRIZZLE_NAME = Symbol.for('drizzle:Name');
function tableName(t: unknown): string {
  return (t as Record<symbol, string>)[DRIZZLE_NAME] ?? '';
}

interface Signal {
  id: string;
  walletId: string;
  chain: string;
  funderAddress: string;
  txHash: string;
  blockNumber: bigint;
  blockTimestamp: Date;
  source: string;
  confidence: string;
}

interface WalletRow {
  id: string;
  address: string;
  lastScannedAt: Date | null;
  lastScannedBlock: bigint | null;
}

function makeMockDb(initialSignals: Signal[] = [], initialWallets: WalletRow[] = []) {
  const signals: Signal[] = [...initialSignals];
  const walletRows: WalletRow[] = [...initialWallets];
  const updates: Array<{ table: string; values: Record<string, unknown>; where: string }> = [];

  const db = {
    _signals: signals,
    _walletRows: walletRows,
    _updates: updates,

    select: (_fields: unknown) => ({
      from: (table: unknown) => {
        const name = tableName(table);
        return {
          where: (_cond: unknown) => ({
            limit: (_n: number) => {
              if (name === 'first_funder_signals') {
                return Promise.resolve(signals.length > 0 ? [signals[0]] : []);
              }
              if (name === 'wallets') {
                return Promise.resolve(walletRows.length > 0 ? [walletRows[0]] : []);
              }
              return Promise.resolve([]);
            },
          }),
        };
      },
    }),

    insert: (table: unknown) => {
      const name = tableName(table);
      return {
        values: (vals: Record<string, unknown>) => {
          if (name === 'first_funder_signals') {
            signals.push(vals as unknown as Signal);
          }
          return Promise.resolve();
        },
      };
    },

    update: (table: unknown) => {
      const name = tableName(table);
      return {
        set: (vals: Record<string, unknown>) => ({
          where: (_cond: unknown) => {
            updates.push({ table: name, values: vals, where: '' });
            if (name === 'wallets' && walletRows.length > 0) {
              const w = walletRows[0]!;
              if ('lastScannedAt' in vals) w.lastScannedAt = vals['lastScannedAt'] as Date;
              if ('lastScannedBlock' in vals) w.lastScannedBlock = vals['lastScannedBlock'] as bigint;
            }
            return Promise.resolve();
          },
        }),
      };
    },
  };

  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

const WALLET_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const WALLET_ADDRESS = '0xdeadbeef';
const CHAIN = 'ethereum' as const;

const mockTx: FirstInboundTx = {
  txHash: '0xtxhash1',
  fromAddress: '0xfunder1',
  blockNumber: 100n,
  blockTimestamp: new Date('2023-01-01'),
  valueWei: '1000000000000000000',
  chain: CHAIN,
};

function makeAdapter(tx: FirstInboundTx | null): ChainAdapter {
  return {
    chain: CHAIN,
    getFirstInboundNativeTx: vi.fn().mockResolvedValue(tx),
  };
}

describe('FirstFunderScanner', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('finds first funder and inserts signal', async () => {
    const walletRow: WalletRow = { id: WALLET_ID, address: WALLET_ADDRESS, lastScannedAt: null, lastScannedBlock: null };
    const db = makeMockDb([], [walletRow]);
    vi.mocked(getAdapter).mockReturnValue(makeAdapter(mockTx));

    const scanner = new FirstFunderScanner(() => db as never);
    const result = await scanner.scanWallet(WALLET_ID, CHAIN);

    expect(result.found).toBe(true);
    expect(result.funderAddress).toBe('0xfunder1');
    expect(result.txHash).toBe('0xtxhash1');
    expect(result.skipped).toBeUndefined();
    expect(db._signals).toHaveLength(1);
    expect(db._signals[0]!.funderAddress).toBe('0xfunder1');
  });

  it('returns found=false when no tx found', async () => {
    const walletRow: WalletRow = { id: WALLET_ID, address: WALLET_ADDRESS, lastScannedAt: null, lastScannedBlock: null };
    const db = makeMockDb([], [walletRow]);
    vi.mocked(getAdapter).mockReturnValue(makeAdapter(null));

    const scanner = new FirstFunderScanner(() => db as never);
    const result = await scanner.scanWallet(WALLET_ID, CHAIN);

    expect(result.found).toBe(false);
    expect(result.funderAddress).toBeUndefined();
    expect(db._signals).toHaveLength(0);
    // lastScannedAt should be updated
    expect(db._updates.some((u) => u.table === 'wallets')).toBe(true);
  });

  it('is idempotent — skips if signal already exists', async () => {
    const existingSignal: Signal = {
      id: 'sig-1',
      walletId: WALLET_ID,
      chain: CHAIN,
      funderAddress: '0xfunder1',
      txHash: '0xtxhash1',
      blockNumber: 100n,
      blockTimestamp: new Date(),
      source: 'EtherscanAdapter',
      confidence: '1.0',
    };
    const walletRow: WalletRow = { id: WALLET_ID, address: WALLET_ADDRESS, lastScannedAt: null, lastScannedBlock: null };
    const db = makeMockDb([existingSignal], [walletRow]);
    const adapter = makeAdapter(mockTx);
    vi.mocked(getAdapter).mockReturnValue(adapter);

    const scanner = new FirstFunderScanner(() => db as never);
    const result = await scanner.scanWallet(WALLET_ID, CHAIN);

    expect(result.skipped).toBe(true);
    expect(result.found).toBe(true);
    // Adapter should NOT have been called
    expect(adapter.getFirstInboundNativeTx).not.toHaveBeenCalled();
    // No new signals inserted
    expect(db._signals).toHaveLength(1);
  });

  it('returns error gracefully when wallet not found in DB', async () => {
    const db = makeMockDb([], []); // no wallets
    vi.mocked(getAdapter).mockReturnValue(makeAdapter(mockTx));

    const scanner = new FirstFunderScanner(() => db as never);
    const result = await scanner.scanWallet(WALLET_ID, CHAIN);

    expect(result.found).toBe(false);
    expect(result.error).toContain(WALLET_ID);
  });

  it('scanBatch processes multiple wallets', async () => {
    const w1: WalletRow = { id: 'w1', address: '0x111', lastScannedAt: null, lastScannedBlock: null };
    const w2: WalletRow = { id: 'w2', address: '0x222', lastScannedAt: null, lastScannedBlock: null };

    // Build a db that returns the right wallet per call
    let callCount = 0;
    const walletRows = [w1, w2];
    const signals: Signal[] = [];

    const db = {
      _signals: signals,
      select: (_fields: unknown) => ({
        from: (table: unknown) => {
          const name = tableName(table);
          return {
            where: (_cond: unknown) => ({
              limit: (_n: number) => {
                if (name === 'first_funder_signals') return Promise.resolve([]);
                if (name === 'wallets') {
                  const row = walletRows[callCount % walletRows.length];
                  callCount++;
                  return Promise.resolve(row ? [row] : []);
                }
                return Promise.resolve([]);
              },
            }),
          };
        },
      }),
      insert: (_table: unknown) => ({
        values: (vals: Record<string, unknown>) => {
          signals.push(vals as unknown as Signal);
          return Promise.resolve();
        },
      }),
      update: (_table: unknown) => ({
        set: (_vals: unknown) => ({
          where: (_cond: unknown) => Promise.resolve(),
        }),
      }),
    };

    vi.mocked(getAdapter).mockReturnValue(makeAdapter(mockTx));

    const scanner = new FirstFunderScanner(() => db as never);
    const result = await scanner.scanBatch(['w1', 'w2'], CHAIN, { concurrency: 2 });

    expect(result.scanned).toBe(2);
    expect(result.found).toBe(2);
    expect(result.errors).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// Cross-verification and extractFromTransactions tests
// ---------------------------------------------------------------------------

describe('FirstFunderScanner.extractFromTransactions', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: no HTML cross-verify (stub fetch to return no "Funded By")
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: false,
      text: async () => '',
    }));
  });

  it('extracts first inbound native tx from pre-fetched list', async () => {
    const walletRow: WalletRow = {
      id: WALLET_ID,
      address: WALLET_ADDRESS,
      lastScannedAt: null,
      lastScannedBlock: null,
    };
    const db = makeMockDb([], [walletRow]);

    const txs: import('../../chains/transactionFetcher.js').RawTransaction[] = [
      {
        txHash: '0xtxhash-inbound',
        fromAddress: '0xfunder1',
        toAddress: WALLET_ADDRESS.toLowerCase(),
        blockNumber: 50n,
        blockTimestamp: new Date('2023-06-01'),
        valueWei: '500000000000000000',
        isInbound: true,
        chain: CHAIN,
      },
    ];

    const scanner = new FirstFunderScanner(() => db as never);
    const result = await scanner.extractFromTransactions(WALLET_ID, WALLET_ADDRESS, txs, CHAIN);

    expect(result.found).toBe(true);
    expect(result.funderAddress).toBe('0xfunder1');
    expect(result.txHash).toBe('0xtxhash-inbound');
    expect(db._signals).toHaveLength(1);
    expect(db._signals[0]!.confidence).toBe('0.90'); // no HTML match → computed
  });

  it('ignores ERC20 transfers when finding first native funder', async () => {
    const walletRow: WalletRow = {
      id: WALLET_ID,
      address: WALLET_ADDRESS,
      lastScannedAt: null,
      lastScannedBlock: null,
    };
    const db = makeMockDb([], [walletRow]);

    const txs: import('../../chains/transactionFetcher.js').RawTransaction[] = [
      {
        txHash: '0xtxhash-erc20',
        fromAddress: '0xerc20sender',
        toAddress: WALLET_ADDRESS.toLowerCase(),
        blockNumber: 50n,
        blockTimestamp: new Date('2023-01-01'),
        valueWei: '0',
        isInbound: true,
        chain: CHAIN,
        tokenContractAddress: '0xtokenaddr',
        tokenSymbol: 'USDC',
        tokenValueRaw: '1000000',
      },
      {
        txHash: '0xtxhash-native',
        fromAddress: '0xnativefunder',
        toAddress: WALLET_ADDRESS.toLowerCase(),
        blockNumber: 100n,
        blockTimestamp: new Date('2023-02-01'),
        valueWei: '1000000000000000000',
        isInbound: true,
        chain: CHAIN,
      },
    ];

    const scanner = new FirstFunderScanner(() => db as never);
    const result = await scanner.extractFromTransactions(WALLET_ID, WALLET_ADDRESS, txs, CHAIN);

    expect(result.found).toBe(true);
    // Should pick the native tx, not the ERC20
    expect(result.funderAddress).toBe('0xnativefunder');
  });

  it('returns found=false when no native inbound txs in list', async () => {
    const walletRow: WalletRow = {
      id: WALLET_ID,
      address: WALLET_ADDRESS,
      lastScannedAt: null,
      lastScannedBlock: null,
    };
    const db = makeMockDb([], [walletRow]);

    const scanner = new FirstFunderScanner(() => db as never);
    const result = await scanner.extractFromTransactions(WALLET_ID, WALLET_ADDRESS, [], CHAIN);

    expect(result.found).toBe(false);
    expect(db._signals).toHaveLength(0);
  });

  it('is idempotent — skips if signal already exists', async () => {
    const existingSignal: Signal = {
      id: 'sig-existing',
      walletId: WALLET_ID,
      chain: CHAIN,
      funderAddress: '0xfunder-old',
      txHash: '0xtxhash-old',
      blockNumber: 10n,
      blockTimestamp: new Date(),
      source: 'computed',
      confidence: '0.9',
    };
    const walletRow: WalletRow = {
      id: WALLET_ID,
      address: WALLET_ADDRESS,
      lastScannedAt: null,
      lastScannedBlock: null,
    };
    const db = makeMockDb([existingSignal], [walletRow]);

    const txs: import('../../chains/transactionFetcher.js').RawTransaction[] = [
      {
        txHash: '0xtxhash-new',
        fromAddress: '0xnewfunder',
        toAddress: WALLET_ADDRESS.toLowerCase(),
        blockNumber: 200n,
        blockTimestamp: new Date(),
        valueWei: '1000000000000000000',
        isInbound: true,
        chain: CHAIN,
      },
    ];

    const scanner = new FirstFunderScanner(() => db as never);
    const result = await scanner.extractFromTransactions(WALLET_ID, WALLET_ADDRESS, txs, CHAIN);

    expect(result.skipped).toBe(true);
    expect(db._signals).toHaveLength(1); // no new signal
  });

  it('sets confidence=1.0 and source=etherscan_verified when Etherscan confirms funder', async () => {
    const walletRow: WalletRow = {
      id: WALLET_ID,
      address: WALLET_ADDRESS,
      lastScannedAt: null,
      lastScannedBlock: null,
    };
    const db = makeMockDb([], [walletRow]);

    // Must be a full 40-char hex address to match the Etherscan HTML regex
    const funder = '0xabcdef1234567890abcdef1234567890abcdef12';

    // Mock Etherscan HTML response with matching "Funded by" link
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        `<html>Funded by <a href="/address/${funder}">Short Tag</a></html>`,
    }));

    const txs: import('../../chains/transactionFetcher.js').RawTransaction[] = [
      {
        txHash: '0xtxhash-verified',
        fromAddress: funder,
        toAddress: WALLET_ADDRESS.toLowerCase(),
        blockNumber: 100n,
        blockTimestamp: new Date(),
        valueWei: '1000000000000000000',
        isInbound: true,
        chain: CHAIN,
      },
    ];

    const scanner = new FirstFunderScanner(() => db as never);
    const result = await scanner.extractFromTransactions(WALLET_ID, WALLET_ADDRESS, txs, CHAIN);

    expect(result.found).toBe(true);
    expect(db._signals[0]!.confidence).toBe('1.00');
    expect(db._signals[0]!.source).toBe('etherscan_verified');
  });

  it('sets confidence=0.7 and source=etherscan_conflict on funder mismatch', async () => {
    const walletRow: WalletRow = {
      id: WALLET_ID,
      address: WALLET_ADDRESS,
      lastScannedAt: null,
      lastScannedBlock: null,
    };
    const db = makeMockDb([], [walletRow]);

    // Both must be full 40-char hex to satisfy the regex + comparison
    const computedFunder = '0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const etherscanFunder = '0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      text: async () =>
        `<html>Funded by <a href="/address/${etherscanFunder}">Short</a></html>`,
    }));

    const txs: import('../../chains/transactionFetcher.js').RawTransaction[] = [
      {
        txHash: '0xtxhash-conflict',
        fromAddress: computedFunder,
        toAddress: WALLET_ADDRESS.toLowerCase(),
        blockNumber: 100n,
        blockTimestamp: new Date(),
        valueWei: '1000000000000000000',
        isInbound: true,
        chain: CHAIN,
      },
    ];

    const scanner = new FirstFunderScanner(() => db as never);
    const result = await scanner.extractFromTransactions(WALLET_ID, WALLET_ADDRESS, txs, CHAIN);

    expect(result.found).toBe(true);
    expect(db._signals[0]!.confidence).toBe('0.70');
    expect(db._signals[0]!.source).toBe('etherscan_conflict');
  });
});
