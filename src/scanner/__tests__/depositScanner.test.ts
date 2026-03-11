import { describe, it, expect, vi, beforeEach } from 'vitest';
import { DepositScanner } from '../depositScanner.js';
import type { RawTransaction } from '../../chains/transactionFetcher.js';
import type { AddressLabel } from '../../labels/labelResolver.js';

// ---------------------------------------------------------------------------
// Mock LabelResolver
// ---------------------------------------------------------------------------

vi.mock('../../labels/labelResolver.js', () => ({
  LabelResolver: vi.fn(),
}));

import { LabelResolver } from '../../labels/labelResolver.js';

// ---------------------------------------------------------------------------
// DB helpers
// ---------------------------------------------------------------------------

const DRIZZLE_NAME = Symbol.for('drizzle:Name');
function tableName(t: unknown): string {
  return (t as Record<symbol, string>)[DRIZZLE_NAME] ?? '';
}

interface EvidenceRow {
  id: string;
  walletId: string;
  chain: string;
  recipientAddress: string;
  txHash: string;
  transferType: string;
  tokenSymbol?: string | null;
  amountRaw?: string | null;
  blockNumber: bigint;
  blockTimestamp: Date;
}

function makeMockDb(storedEvidence: EvidenceRow[] = []) {
  const evidence: EvidenceRow[] = [...storedEvidence];
  let nextId = 100;

  const db = {
    _evidence: evidence,

    select: (_fields: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: number) =>
            Promise.resolve(evidence.length > 0 ? [evidence[evidence.length - 1]] : []),
        }),
      }),
    }),

    insert: (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => ({
        returning: (_fields: unknown) => {
          const id = `evi-${nextId++}`;
          evidence.push({ id, ...(vals as Omit<EvidenceRow, 'id'>) } as EvidenceRow);
          return Promise.resolve([{ id }]);
        },
      }),
    }),
  };

  return db;
}

// ---------------------------------------------------------------------------
// Test data helpers
// ---------------------------------------------------------------------------

const WALLET_ID = 'aaaaaaaa-0000-0000-0000-000000000001';
const CHAIN = 'ethereum' as const;

function makeTx(overrides: Partial<RawTransaction> = {}): RawTransaction {
  return {
    txHash: '0xtx1',
    fromAddress: '0xwallet',
    toAddress: '0xcexaddr',
    blockNumber: 1000n,
    blockTimestamp: new Date('2024-01-01'),
    valueWei: '1000000000000000000',
    isInbound: false,
    chain: CHAIN,
    ...overrides,
  };
}

const CEX_LABEL: AddressLabel = {
  address: '0xcexaddr',
  chain: CHAIN,
  labelValue: 'Binance',
  labelKind: 'exchange_hot_wallet',
  source: 'seed_list',
  confidence: 1.0,
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('DepositScanner', () => {
  let mockResolver: { resolveLabel: ReturnType<typeof vi.fn> };

  beforeEach(() => {
    vi.clearAllMocks();
    mockResolver = { resolveLabel: vi.fn().mockResolvedValue(null) };
    vi.mocked(LabelResolver).mockImplementation(() => mockResolver as never);
  });

  it('detects deposit address in outbound txs and inserts evidence', async () => {
    const db = makeMockDb([]);
    mockResolver.resolveLabel.mockResolvedValue(CEX_LABEL);
    // Override DB select to return empty (no existing evidence)
    db.select = (_: unknown) => ({
      from: (_t: unknown) => ({
        where: (_c: unknown) => ({
          limit: (_n: number) => Promise.resolve([]),
        }),
      }),
    });

    const depositScanner = new DepositScanner(() => db as never, mockResolver as never);
    const tx = makeTx({ txHash: '0xtx-deposit-1', isInbound: false, toAddress: '0xcexaddr' });
    const result = await depositScanner.scanTransactions(WALLET_ID, [tx], CHAIN);

    expect(result.depositsFound).toBe(1);
    expect(result.evidenceIds).toHaveLength(1);
    expect(db._evidence).toHaveLength(1);
    expect(db._evidence[0]!.recipientAddress).toBe('0xcexaddr');
    expect(db._evidence[0]!.txHash).toBe('0xtx-deposit-1');
  });

  it('skips inbound transactions', async () => {
    const db = makeMockDb([]);
    mockResolver.resolveLabel.mockResolvedValue(CEX_LABEL);

    const depositScanner = new DepositScanner(() => db as never, mockResolver as never);
    const tx = makeTx({ isInbound: true, fromAddress: '0xcexaddr', toAddress: '0xwallet' });
    const result = await depositScanner.scanTransactions(WALLET_ID, [tx], CHAIN);

    expect(result.depositsFound).toBe(0);
    expect(db._evidence).toHaveLength(0);
    // Should never have tried to resolve the inbound sender
    expect(mockResolver.resolveLabel).not.toHaveBeenCalled();
  });

  it('is idempotent — second scan does not duplicate evidence', async () => {
    const existingEvidence: EvidenceRow = {
      id: 'evi-existing',
      walletId: WALLET_ID,
      chain: CHAIN,
      recipientAddress: '0xcexaddr',
      txHash: '0xtx-deposit-1',
      transferType: 'native',
      blockNumber: 1000n,
      blockTimestamp: new Date('2024-01-01'),
    };
    // DB always returns the existing evidence row
    const db = makeMockDb([existingEvidence]);
    mockResolver.resolveLabel.mockResolvedValue(CEX_LABEL);

    const depositScanner = new DepositScanner(() => db as never, mockResolver as never);
    const tx = makeTx({ txHash: '0xtx-deposit-1', isInbound: false, toAddress: '0xcexaddr' });

    const result1 = await depositScanner.scanTransactions(WALLET_ID, [tx], CHAIN);
    expect(result1.depositsFound).toBe(1);

    const result2 = await depositScanner.scanTransactions(WALLET_ID, [tx], CHAIN);
    expect(result2.depositsFound).toBe(1);

    // No new rows inserted (mock DB still has exactly 1)
    expect(db._evidence).toHaveLength(1);
  });

  it('unknown addresses produce no evidence', async () => {
    const db = makeMockDb([]);
    // resolver returns null for all addresses
    mockResolver.resolveLabel.mockResolvedValue(null);

    const depositScanner = new DepositScanner(() => db as never, mockResolver as never);
    const tx = makeTx({ isInbound: false, toAddress: '0xunknownaddr' });
    const result = await depositScanner.scanTransactions(WALLET_ID, [tx], CHAIN);

    expect(result.depositsFound).toBe(0);
    expect(db._evidence).toHaveLength(0);
  });

  it('handles ERC20 deposit transfers', async () => {
    const db = makeMockDb([]);
    const erc20Addr = '0xcexerc20';
    mockResolver.resolveLabel.mockImplementation(async (addr: string) => {
      if (addr === erc20Addr) return { ...CEX_LABEL, address: erc20Addr };
      return null;
    });
    db.select = (_: unknown) => ({
      from: (_t: unknown) => ({
        where: (_c: unknown) => ({
          limit: (_n: number) => Promise.resolve([]),
        }),
      }),
    });

    const depositScanner = new DepositScanner(() => db as never, mockResolver as never);
    const tx = makeTx({
      txHash: '0xtx-erc20',
      isInbound: false,
      toAddress: erc20Addr,
      valueWei: '0',
      tokenSymbol: 'USDC',
      tokenContractAddress: '0xusdc',
      tokenValueRaw: '1000000',
    });

    const result = await depositScanner.scanTransactions(WALLET_ID, [tx], CHAIN);
    expect(result.depositsFound).toBe(1);
    expect(db._evidence[0]!.transferType).toBe('erc20');
    expect(db._evidence[0]!.tokenSymbol).toBe('USDC');
  });
});
