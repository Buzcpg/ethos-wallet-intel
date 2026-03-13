import { describe, it, expect } from 'vitest';
import { DepositScanner } from '../depositScanner.js';
import type { RawTransaction } from '../../chains/transactionFetcher.js';

function makeDb() {
  return {
    select: () => ({ from: () => ({ where: () => [] }) }),
    insert: () => ({ values: () => ({ returning: async () => [] }) }),
  } as never;
}

describe('DepositScanner', () => {
  it('returns zero deposits when no transactions provided', async () => {
    const scanner = new DepositScanner(makeDb);
    const result = await scanner.scanTransactions('wallet-id', [], 'ethereum');
    expect(result.depositsFound).toBe(0);
    expect(result.evidenceIds).toHaveLength(0);
  });

  it('returns zero deposits for outbound transactions (CEX detection disabled)', async () => {
    const scanner = new DepositScanner(makeDb);
    const txs: RawTransaction[] = [
      {
        txHash: '0xabc',
        fromAddress: '0xwallet',
        toAddress: '0xcex',
        isInbound: false,
        valueWei: '1000000000000000000',
        blockNumber: 100n,
        blockTimestamp: new Date(),
        chain: 'ethereum',
      },
    ];
    const result = await scanner.scanTransactions('wallet-id', txs, 'ethereum');
    expect(result.depositsFound).toBe(0);
  });
});
