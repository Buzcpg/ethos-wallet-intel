import { describe, it, expect, vi, beforeEach } from 'vitest';
import { WalletScanner } from '../walletScanner.js';

// ---------------------------------------------------------------------------
// Mock all sub-components
// ---------------------------------------------------------------------------

vi.mock('../../chains/transactionFetcher.js', () => ({
  WalletTransactionFetcher: vi.fn(),
}));

vi.mock('../firstFunderScanner.js', () => ({
  FirstFunderScanner: vi.fn(),
}));

vi.mock('../depositScanner.js', () => ({
  DepositScanner: vi.fn(),
}));

vi.mock('../p2pScanner.js', () => ({
  P2PScanner: vi.fn(),
}));

vi.mock('../../config/env.js', () => ({
  env: { SCANNER_CONCURRENCY: 5 },
}));

import { WalletTransactionFetcher } from '../../chains/transactionFetcher.js';
import { FirstFunderScanner } from '../firstFunderScanner.js';
import { DepositScanner } from '../depositScanner.js';
import { P2PScanner } from '../p2pScanner.js';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

const DRIZZLE_NAME = Symbol.for('drizzle:Name');
function tableName(t: unknown): string {
  return (t as Record<symbol, string>)[DRIZZLE_NAME] ?? '';
}

const WALLET_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const WALLET_ADDR = '0xmywallet';
const CHAIN = 'ethereum' as const;

function makeMockDb(opts: {
  walletFound?: boolean;
  lastScannedAt?: Date | null;
  lastScannedBlock?: bigint | null;
  existingSignal?: boolean;
}) {
  const db = {
    select: (_: unknown) => ({
      from: (table: unknown) => {
        const name = tableName(table);
        return {
          where: (_c: unknown) => ({
            limit: (_n: number) => {
              if (name === 'wallets') {
                if (!opts.walletFound) return Promise.resolve([]);
                return Promise.resolve([
                  {
                    address: WALLET_ADDR,
                    lastScannedAt: opts.lastScannedAt ?? null,
                    lastScannedBlock: opts.lastScannedBlock ?? null,
                  },
                ]);
              }
              if (name === 'first_funder_signals') {
                return Promise.resolve(opts.existingSignal ? [{ id: 'sig-1' }] : []);
              }
              return Promise.resolve([]);
            },
          }),
          orderBy: (_c: unknown) => ({
            limit: (_n: number) => Promise.resolve([]),
          }),
        };
      },
    }),

    update: (_: unknown) => ({
      set: (_vals: unknown) => ({
        where: (_c: unknown) => Promise.resolve(),
      }),
    }),
  };
  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WalletScanner', () => {
  let mockFetcher: { fetchAll: ReturnType<typeof vi.fn> };
  let mockFirstFunder: { extractFromTransactions: ReturnType<typeof vi.fn> };
  let mockDeposit: { scanTransactions: ReturnType<typeof vi.fn> };
  let mockP2P: { scanTransactions: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();

    mockFetcher = {
      fetchAll: vi.fn().mockResolvedValue({
        transactions: [],
        totalFetched: 5,
        chain: CHAIN,
        address: WALLET_ADDR,
        toBlock: 9999n,
      }),
    };
    mockFirstFunder = {
      extractFromTransactions: vi.fn().mockResolvedValue({
        walletId: WALLET_ID,
        chain: CHAIN,
        found: true,
      }),
    };
    mockDeposit = {
      scanTransactions: vi.fn().mockResolvedValue({
        walletId: WALLET_ID,
        chain: CHAIN,
        depositsFound: 2,
        evidenceIds: ['e1', 'e2'],
      }),
    };
    mockP2P = {
      scanTransactions: vi.fn().mockResolvedValue({
        walletId: WALLET_ID,
        chain: CHAIN,
        matchesFound: 1,
      }),
    };

    vi.mocked(WalletTransactionFetcher).mockImplementation(() => mockFetcher as never);
    vi.mocked(FirstFunderScanner).mockImplementation(() => mockFirstFunder as never);
    vi.mocked(DepositScanner).mockImplementation(() => mockDeposit as never);
    vi.mocked(P2PScanner).mockImplementation(() => mockP2P as never);
  });

  // -------------------------------------------------------------------------
  // Full scan tests (existing)
  // -------------------------------------------------------------------------

  it('runs all three extractors with a single tx fetch', async () => {
    const db = makeMockDb({ walletFound: true, lastScannedAt: null });
    const walletScanner = new WalletScanner(() => db as never);

    const result = await walletScanner.scanWallet(WALLET_ID, CHAIN);

    expect(mockFetcher.fetchAll).toHaveBeenCalledOnce();
    expect(mockFirstFunder.extractFromTransactions).toHaveBeenCalledOnce();
    expect(mockDeposit.scanTransactions).toHaveBeenCalledOnce();
    expect(mockP2P.scanTransactions).toHaveBeenCalledOnce();

    expect(result.firstFunderFound).toBe(true);
    expect(result.depositEvidenceFound).toBe(2);
    expect(result.p2pMatchesFound).toBe(1);
    expect(result.transactionsFetched).toBe(5);
    expect(result.error).toBeUndefined();
  });

  it('returns error result when wallet not found in DB', async () => {
    const db = makeMockDb({ walletFound: false });
    const walletScanner = new WalletScanner(() => db as never);

    const result = await walletScanner.scanWallet(WALLET_ID, CHAIN);

    expect(result.error).toContain(WALLET_ID);
    expect(mockFetcher.fetchAll).not.toHaveBeenCalled();
  });

  it('handles extractor errors gracefully — partial results returned', async () => {
    const db = makeMockDb({ walletFound: true, lastScannedAt: null });

    // Deposit scanner throws
    mockDeposit.scanTransactions.mockRejectedValue(new Error('deposit API down'));

    const walletScanner = new WalletScanner(() => db as never);
    const result = await walletScanner.scanWallet(WALLET_ID, CHAIN);

    // Should still return a result — deposit = 0, others still ran
    expect(result.depositEvidenceFound).toBe(0);
    expect(result.firstFunderFound).toBe(true);
    expect(result.p2pMatchesFound).toBe(1);
  });

  it('skips fetch when wallet is already fully scanned', async () => {
    const db = makeMockDb({
      walletFound: true,
      lastScannedAt: new Date(),
      existingSignal: true,
    });
    const walletScanner = new WalletScanner(() => db as never);

    const result = await walletScanner.scanWallet(WALLET_ID, CHAIN);

    expect(mockFetcher.fetchAll).not.toHaveBeenCalled();
    expect(result.firstFunderFound).toBe(true);
    expect(result.transactionsFetched).toBe(0);
  });

  it('marks wallet as scanned after completion', async () => {
    const db = makeMockDb({ walletFound: true, lastScannedAt: null });
    const updates: unknown[] = [];
    db.update = (_: unknown) => ({
      set: (vals: unknown) => {
        updates.push(vals);
        return { where: (_c: unknown) => Promise.resolve() };
      },
    });

    const walletScanner = new WalletScanner(() => db as never);
    await walletScanner.scanWallet(WALLET_ID, CHAIN);

    expect(updates.length).toBeGreaterThan(0);
  });

  // -------------------------------------------------------------------------
  // Delta scan tests (new in M5)
  // -------------------------------------------------------------------------

  it('deltaScanWallet falls back to full scan when lastScannedBlock is null', async () => {
    const db = makeMockDb({
      walletFound: true,
      lastScannedBlock: null,
      lastScannedAt: null,
    });
    const walletScanner = new WalletScanner(() => db as never);

    // Mock scanWallet to track if it was called
    const scanWalletSpy = vi.spyOn(walletScanner, 'scanWallet').mockResolvedValue({
      walletId: WALLET_ID,
      chain: CHAIN,
      transactionsFetched: 10,
      firstFunderFound: true,
      depositEvidenceFound: 1,
      p2pMatchesFound: 0,
      partial: false,
      deepScanReasons: [],
      durationMs: 100,
    });

    await walletScanner.deltaScanWallet(WALLET_ID, CHAIN);

    expect(scanWalletSpy).toHaveBeenCalledWith(WALLET_ID, CHAIN);
  });

  it('deltaScanWallet returns early with transactionsFetched=0 when no new txs', async () => {
    const db = makeMockDb({
      walletFound: true,
      lastScannedBlock: 5000n,
      lastScannedAt: new Date(),
    });

    // Fetcher returns empty result
    mockFetcher.fetchAll.mockResolvedValue({
      transactions: [],
      totalFetched: 0,
      chain: CHAIN,
      address: WALLET_ADDR,
      partial: false,
    });

    const walletScanner = new WalletScanner(() => db as never);
    const result = await walletScanner.deltaScanWallet(WALLET_ID, CHAIN);

    expect(result.transactionsFetched).toBe(0);
    expect(mockFirstFunder.extractFromTransactions).not.toHaveBeenCalled();
    expect(mockDeposit.scanTransactions).not.toHaveBeenCalled();
    expect(mockP2P.scanTransactions).not.toHaveBeenCalled();
  });

  it('deltaScanWallet fetches from lastScannedBlock + 1', async () => {
    const db = makeMockDb({
      walletFound: true,
      lastScannedBlock: 5000n,
      lastScannedAt: new Date(),
    });

    const newTxs = [
      {
        txHash: '0xnew1',
        fromAddress: '0xsomeone',
        toAddress: WALLET_ADDR,
        blockNumber: 5001n,
        blockTimestamp: new Date(),
        valueWei: '1000',
        isInbound: true,
        chain: CHAIN,
      },
    ];

    mockFetcher.fetchAll.mockResolvedValue({
      transactions: newTxs,
      totalFetched: 1,
      chain: CHAIN,
      address: WALLET_ADDR,
      fromBlock: 5001n,
      toBlock: 5001n,
      partial: false,
    });

    const walletScanner = new WalletScanner(() => db as never);
    const result = await walletScanner.deltaScanWallet(WALLET_ID, CHAIN);

    // fetchAll called with fromBlock = 5001n
    expect(mockFetcher.fetchAll).toHaveBeenCalledWith(WALLET_ADDR, { fromBlock: 5001n });
    expect(result.transactionsFetched).toBe(1);
  });

  it('deltaScanWallet updates lastScannedBlock to highest block seen', async () => {
    const db = makeMockDb({
      walletFound: true,
      lastScannedBlock: 5000n,
      lastScannedAt: new Date(),
    });

    const updates: unknown[] = [];
    db.update = (_: unknown) => ({
      set: (vals: unknown) => {
        updates.push(vals);
        return { where: (_c: unknown) => Promise.resolve() };
      },
    });

    const newTxs = [
      {
        txHash: '0xnew',
        fromAddress: '0xsomeone',
        toAddress: WALLET_ADDR,
        blockNumber: 6000n,
        blockTimestamp: new Date(),
        valueWei: '1000',
        isInbound: true,
        chain: CHAIN,
      },
    ];

    mockFetcher.fetchAll.mockResolvedValue({
      transactions: newTxs,
      totalFetched: 1,
      chain: CHAIN,
      address: WALLET_ADDR,
      fromBlock: 5001n,
      toBlock: 6000n,
      partial: false,
    });

    const walletScanner = new WalletScanner(() => db as never);
    await walletScanner.deltaScanWallet(WALLET_ID, CHAIN);

    expect(updates.length).toBeGreaterThan(0);
    const updateVals = updates[0] as Record<string, unknown>;
    expect(updateVals).toHaveProperty('lastScannedBlock', 6000n);
  });

  it('deltaScanWallet returns error when wallet not found', async () => {
    const db = makeMockDb({ walletFound: false });
    const walletScanner = new WalletScanner(() => db as never);

    const result = await walletScanner.deltaScanWallet(WALLET_ID, CHAIN);

    expect(result.error).toContain(WALLET_ID);
    expect(mockFetcher.fetchAll).not.toHaveBeenCalled();
  });

  it('deltaScanWallet runs all three extractors when new txs found', async () => {
    const db = makeMockDb({
      walletFound: true,
      lastScannedBlock: 5000n,
      lastScannedAt: new Date(),
    });

    const newTxs = [
      {
        txHash: '0xnew',
        fromAddress: '0xsomeone',
        toAddress: WALLET_ADDR,
        blockNumber: 5001n,
        blockTimestamp: new Date(),
        valueWei: '500',
        isInbound: true,
        chain: CHAIN,
      },
    ];

    mockFetcher.fetchAll.mockResolvedValue({
      transactions: newTxs,
      totalFetched: 1,
      chain: CHAIN,
      address: WALLET_ADDR,
      toBlock: 5001n,
      partial: false,
    });

    const walletScanner = new WalletScanner(() => db as never);
    await walletScanner.deltaScanWallet(WALLET_ID, CHAIN);

    expect(mockFirstFunder.extractFromTransactions).toHaveBeenCalledOnce();
    expect(mockDeposit.scanTransactions).toHaveBeenCalledOnce();
    expect(mockP2P.scanTransactions).toHaveBeenCalledOnce();
  });
});
