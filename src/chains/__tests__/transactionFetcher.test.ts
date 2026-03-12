import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { WalletTransactionFetcher } from '../transactionFetcher.js';

// ---------------------------------------------------------------------------
// Mock env to avoid real config requirements
// ---------------------------------------------------------------------------

vi.mock('../../config/env.js', () => ({
  env: {
    SCAN_WINDOW_FIRST: 50,
    SCAN_WINDOW_LAST: 50,
    SCANNER_DELAY_MS: 0,
    SCAN_MAX_PAGES_DELTA: 10,
    DEEP_SCAN_PAGE_DELAY_MS: 0,
  },
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const ADDR = '0xdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef';
const CHAIN = 'ethereum' as const;
const FROM_BLOCK = 1000n;

function makeTxItem(overrides: {
  hash?: string;
  block_number?: number | null;
  timestamp?: string;
  from?: string;
  to?: string;
  value?: string;
}) {
  return {
    hash: overrides.hash ?? '0xtxhash1',
    // Use undefined-check (not ??) so that explicit null is preserved
    block_number: overrides.block_number !== undefined ? overrides.block_number : 1500,
    timestamp: overrides.timestamp ?? '2024-01-15T10:00:00.000Z',
    from: { hash: overrides.from ?? '0xsender' },
    to: { hash: overrides.to ?? ADDR },
    value: overrides.value ?? '1000000000000000000',
  };
}

function makeResponse(items: unknown[], nextPageParams: null | Record<string, unknown> = null) {
  return new Response(
    JSON.stringify({ items, next_page_params: nextPageParams }),
    {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    },
  );
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('WalletTransactionFetcher — blockTimestamp / block_number edge cases (C4)', () => {
  let fetchSpy: ReturnType<typeof vi.fn>;

  beforeEach(() => {
    fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('filters out pending transactions (block_number = null)', async () => {
    // fetchFromBlock calls fetch twice per loop: native + token-transfers
    fetchSpy
      .mockResolvedValueOnce(makeResponse([makeTxItem({ block_number: null })]))  // native page
      .mockResolvedValueOnce(makeResponse([]));                                     // token page

    const fetcher = new WalletTransactionFetcher(CHAIN);
    const result = await fetcher.fetchAll(ADDR, { fromBlock: FROM_BLOCK });

    expect(result.totalFetched).toBe(0);
    expect(result.transactions).toHaveLength(0);
  });

  it('filters out transactions below fromBlock', async () => {
    // tx at block 999 is below FROM_BLOCK (1000) — should be excluded
    fetchSpy
      .mockResolvedValueOnce(makeResponse([makeTxItem({ block_number: 999 })]))
      .mockResolvedValueOnce(makeResponse([]));

    const fetcher = new WalletTransactionFetcher(CHAIN);
    const result = await fetcher.fetchAll(ADDR, { fromBlock: FROM_BLOCK });

    expect(result.totalFetched).toBe(0);
  });

  it('includes transactions at or above fromBlock', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeResponse([
        makeTxItem({ hash: '0xtx-at', block_number: 1000 }),     // exactly at fromBlock
        makeTxItem({ hash: '0xtx-above', block_number: 2000 }),  // above fromBlock
      ]))
      .mockResolvedValueOnce(makeResponse([]));

    const fetcher = new WalletTransactionFetcher(CHAIN);
    const result = await fetcher.fetchAll(ADDR, { fromBlock: FROM_BLOCK });

    expect(result.totalFetched).toBe(2);
  });

  it('throws when blockTimestamp is an invalid date string', async () => {
    fetchSpy
      .mockResolvedValueOnce(makeResponse([makeTxItem({ block_number: 1500, timestamp: 'not-a-date' })]))
      .mockResolvedValueOnce(makeResponse([]));

    const fetcher = new WalletTransactionFetcher(CHAIN);

    await expect(fetcher.fetchAll(ADDR, { fromBlock: FROM_BLOCK })).rejects.toThrow(
      /Invalid blockTimestamp.*not-a-date/,
    );
  });

  it('correctly identifies inbound vs outbound transactions', async () => {
    const inboundTx = makeTxItem({ hash: '0xinbound', to: ADDR, from: '0xsender' });
    const outboundTx = makeTxItem({ hash: '0xoutbound', from: ADDR, to: '0xrecipient' });

    fetchSpy
      .mockResolvedValueOnce(makeResponse([inboundTx, outboundTx]))
      .mockResolvedValueOnce(makeResponse([]));

    const fetcher = new WalletTransactionFetcher(CHAIN);
    const result = await fetcher.fetchAll(ADDR, { fromBlock: FROM_BLOCK });

    expect(result.totalFetched).toBe(2);
    const inbound = result.transactions.find((t) => t.txHash === '0xinbound');
    const outbound = result.transactions.find((t) => t.txHash === '0xoutbound');
    expect(inbound?.isInbound).toBe(true);
    expect(outbound?.isInbound).toBe(false);
  });

  it('stops paginating when next_page_params is null', async () => {
    // First page has next_page_params, second page has null
    fetchSpy
      .mockResolvedValueOnce(makeResponse([makeTxItem({ hash: '0xtx-p1' })], { block: 1499 }))
      .mockResolvedValueOnce(makeResponse([])) // token page 1
      .mockResolvedValueOnce(makeResponse([makeTxItem({ hash: '0xtx-p2' })], null))            // native page 2
      .mockResolvedValueOnce(makeResponse([])); // token page 2

    const fetcher = new WalletTransactionFetcher(CHAIN);
    const result = await fetcher.fetchAll(ADDR, { fromBlock: FROM_BLOCK });

    expect(result.totalFetched).toBe(2);
  });

  it('deduplicates transactions with the same txHash', async () => {
    const tx = makeTxItem({ hash: '0xdupedhash' });
    fetchSpy
      .mockResolvedValueOnce(makeResponse([tx, tx])) // same hash twice
      .mockResolvedValueOnce(makeResponse([]));

    const fetcher = new WalletTransactionFetcher(CHAIN);
    const result = await fetcher.fetchAll(ADDR, { fromBlock: FROM_BLOCK });

    expect(result.totalFetched).toBe(1);
  });
});
