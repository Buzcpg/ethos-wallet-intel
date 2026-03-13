/**
 * transactionFetcher.ts — delegates to AlchemyFetcher.
 *
 * Keeps WalletTransactionFetcher class name + FetchResult / RawTransaction
 * interfaces so all upstream scanners remain unchanged.
 */

import type { ChainSlug } from './index.js';
import { AlchemyFetcher } from './alchemyFetcher.js';

// ---------------------------------------------------------------------------
// Types (exported for consumers: walletScanner, firstFunderScanner, depositScanner)
// ---------------------------------------------------------------------------

export interface RawTransaction {
  txHash: string;
  fromAddress: string;
  toAddress: string;
  blockNumber: bigint;
  blockTimestamp: Date;
  valueWei: string;
  tokenContractAddress?: string;
  tokenSymbol?: string;
  tokenValueRaw?: string;
  isInbound: boolean;
  chain: ChainSlug;
}

export interface FetchAllOptions {
  /** Restrict to transactions from this block number onward (inclusive). */
  fromBlock?: bigint;
  /** If true, fetch ALL transactions ignoring window strategy. */
  deepScan?: boolean;
}

export interface FetchResult {
  transactions: RawTransaction[];
  totalFetched: number;
  chain: ChainSlug;
  address: string;
  /** undefined means the scan covered the full window */
  fromBlock?: bigint;
  toBlock?: bigint;
  /** true if window scan left a gap in the middle */
  partial: boolean;
}

// ---------------------------------------------------------------------------
// WalletTransactionFetcher — thin wrapper around AlchemyFetcher
// ---------------------------------------------------------------------------

export class WalletTransactionFetcher {
  private readonly fetcher: AlchemyFetcher;

  constructor(chain: ChainSlug) {
    this.fetcher = new AlchemyFetcher(chain);
  }

  async fetchAll(address: string, opts?: FetchAllOptions): Promise<FetchResult> {
    return this.fetcher.fetchAll(address, opts);
  }
}
