import { describe, it, expect } from 'vitest';
import { FirstFunderScanner } from '../firstFunderScanner.js';
import type { RawTransaction } from '../../chains/transactionFetcher.js';

function makeDb(signalExists = false) {
  return {
    select: () => ({
      from: () => ({
        where: () => ({
          limit: async () => signalExists ? [{ id: 'sig' }] : [],
        }),
      }),
    }),
    insert: () => ({ values: async () => {} }),
    update: () => ({ set: () => ({ where: async () => {} }) }),
  } as never;
}

describe('FirstFunderScanner', () => {
  it('skips extraction when signal already exists', async () => {
    const scanner = new FirstFunderScanner(() => makeDb(true));
    const result = await scanner.extractFromTransactions('wallet-id', '0xwallet', [], 'ethereum');
    expect(result.skipped).toBe(true);
    expect(result.found).toBe(true);
  });

  it('returns not-found when no qualifying inbound tx', async () => {
    const scanner = new FirstFunderScanner(() => makeDb(false));
    const result = await scanner.extractFromTransactions('wallet-id', '0xwallet', [], 'ethereum');
    expect(result.found).toBe(false);
  });

  it('extracts first funder from pre-fetched transactions', async () => {
    const scanner = new FirstFunderScanner(() => makeDb(false));
    const txs: RawTransaction[] = [
      {
        txHash: '0xfunding',
        fromAddress: '0xfunder',
        toAddress: '0xwallet',
        isInbound: true,
        valueWei: '1000000000000000000',
        blockNumber: 100n,
        blockTimestamp: new Date(),
        chain: 'ethereum',
      },
    ];
    const result = await scanner.extractFromTransactions('wallet-id', '0xwallet', txs, 'ethereum');
    expect(result.found).toBe(true);
    expect(result.funderAddress).toBe('0xfunder');
  });
});
