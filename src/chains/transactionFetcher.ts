import type { ChainSlug } from './index.js';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Types
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
// Blockscout API types
// ---------------------------------------------------------------------------

interface BlockscoutTx {
  hash: string;
  from: { hash: string };
  to: { hash: string } | null;
  block_number: number | null;
  timestamp: string;
  value: string;
  fee?: { value: string };
}

interface BlockscoutTokenTransfer {
  transaction_hash: string;
  from: { hash: string };
  to: { hash: string } | null;
  token: { symbol: string; address: string };
  total: { value: string };
  block_number: number | null;
  timestamp: string;
}

interface BlockscoutNextPage {
  [key: string]: string | number | null;
}

interface BlockscoutPage<T> {
  items: T[];
  next_page_params?: BlockscoutNextPage | null;
}

// ---------------------------------------------------------------------------
// Blockscout chain config
// ---------------------------------------------------------------------------

const BLOCKSCOUT_CONFIGS: Record<string, { baseUrl: string }> = {
  ethereum: { baseUrl: 'https://eth.blockscout.com/api/v2' },
  base:     { baseUrl: 'https://base.blockscout.com/api/v2' },
  arbitrum: { baseUrl: 'https://arbitrum.blockscout.com/api/v2' },
  optimism: { baseUrl: 'https://optimism.blockscout.com/api/v2' },
  polygon:  { baseUrl: 'https://polygon.blockscout.com/api/v2' },
  avalanche: { baseUrl: 'https://api.snowtrace.io/api/v2/avalanche' },
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, retries = 3, backoffMs = 1000): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url);
      if (response.ok) return response;
      if (response.status === 429) {
        await sleep(backoffMs * (attempt + 1));
        continue;
      }
      throw new Error(`Blockscout API returned ${response.status}`);
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) await sleep(backoffMs * (attempt + 1));
    }
  }
  throw lastErr;
}

// ---------------------------------------------------------------------------
// C4 — normaliseTx: returns null for pending (block_number=null) transactions.
//      Callers must filter the null out.
//      Also validates blockTimestamp (M12) — throws on invalid date.
// ---------------------------------------------------------------------------

function normaliseTx(tx: BlockscoutTx, addr: string, chain: ChainSlug): RawTransaction | null {
  // C4 — skip pending transactions (block_number is null for unconfirmed txs)
  if (tx.block_number === null || tx.block_number === undefined) {
    return null;
  }

  // C4 / M12 — validate blockTimestamp
  const ts = new Date(tx.timestamp);
  if (isNaN(ts.getTime())) {
    throw new Error(
      `[normaliseTx] Invalid blockTimestamp "${tx.timestamp}" for tx ${tx.hash}`,
    );
  }

  const lowerAddr = addr.toLowerCase();
  const toAddr = tx.to?.hash?.toLowerCase() ?? '';
  const fromAddr = tx.from.hash.toLowerCase();

  return {
    txHash: tx.hash,
    fromAddress: fromAddr,
    toAddress: toAddr,
    blockNumber: BigInt(tx.block_number),
    blockTimestamp: ts,
    valueWei: tx.value,
    isInbound: toAddr === lowerAddr,
    chain,
  };
}

function normaliseTokenTransfer(
  tt: BlockscoutTokenTransfer,
  addr: string,
  chain: ChainSlug,
): RawTransaction | null {
  // C4 — skip pending token transfers
  if (tt.block_number === null || tt.block_number === undefined) {
    return null;
  }

  // C4 / M12 — validate blockTimestamp
  const ts = new Date(tt.timestamp);
  if (isNaN(ts.getTime())) {
    throw new Error(
      `[normaliseTokenTransfer] Invalid blockTimestamp "${tt.timestamp}" for tx ${tt.transaction_hash}`,
    );
  }

  const lowerAddr = addr.toLowerCase();
  const toAddr = tt.to?.hash?.toLowerCase() ?? '';
  const fromAddr = tt.from.hash.toLowerCase();

  return {
    txHash: tt.transaction_hash,
    fromAddress: fromAddr,
    toAddress: toAddr,
    blockNumber: BigInt(tt.block_number),
    blockTimestamp: ts,
    valueWei: '0', // token transfers carry no native value
    tokenContractAddress: tt.token.address,
    tokenSymbol: tt.token.symbol,
    tokenValueRaw: tt.total.value,
    isInbound: toAddr === lowerAddr,
    chain,
  };
}

// ---------------------------------------------------------------------------
// M9 — fetchBlockscoutPage: build next-page URLs from scratch.
//      Take the base URL + path, add fixed params, then spread next_page_params
//      on top. Never parse or mutate an existing URL string.
// ---------------------------------------------------------------------------

async function fetchBlockscoutPage<T>(
  baseUrl: string,
  address: string,
  kind: 'transactions' | 'token-transfers',
  fixedParams: Record<string, string>,
  nextPageParams?: BlockscoutNextPage | null,
): Promise<BlockscoutPage<T>> {
  const url = new URL(`${baseUrl}/addresses/${address}/${kind}`);

  // Fixed params first (address, sort, limit)
  for (const [k, v] of Object.entries(fixedParams)) {
    url.searchParams.set(k, v);
  }

  // next_page_params override/extend the fixed params
  if (nextPageParams) {
    for (const [k, v] of Object.entries(nextPageParams)) {
      if (v !== null && v !== undefined) {
        url.searchParams.set(k, String(v));
      }
    }
  }

  const response = await fetchWithRetry(url.toString());
  return (await response.json()) as BlockscoutPage<T>;
}

// ---------------------------------------------------------------------------
// WalletTransactionFetcher
// ---------------------------------------------------------------------------

export class WalletTransactionFetcher {
  private readonly chain: ChainSlug;
  private readonly baseUrl: string;

  constructor(chain: ChainSlug) {
    const config = BLOCKSCOUT_CONFIGS[chain];
    if (!config) {
      throw new Error(`WalletTransactionFetcher: no Blockscout config for chain "${chain}"`);
    }
    this.chain = chain;
    this.baseUrl = config.baseUrl;
  }

  /**
   * Fetch all (or windowed) transactions for a wallet address.
   */
  async fetchAll(address: string, opts?: FetchAllOptions): Promise<FetchResult> {
    const addr = address.toLowerCase();

    if (opts?.fromBlock !== undefined) {
      return this.fetchFromBlock(addr, opts.fromBlock);
    }

    if (opts?.deepScan) {
      return this.fetchDeepScan(addr);
    }

    return this.fetchWindowed(addr);
  }

  // ---------------------------------------------------------------------------
  // Windowed fetch (default full scan)
  // ---------------------------------------------------------------------------

  private async fetchWindowed(addr: string): Promise<FetchResult> {
    const windowFirst = env.SCAN_WINDOW_FIRST;
    const windowLast = env.SCAN_WINDOW_LAST;

    const fixedParamsAsc  = { sort: 'asc',  limit: '50' };
    const fixedParamsDesc = { sort: 'desc', limit: '50' };

    const [
      { txs: nativeFirst,  exhausted: nativeExhaustedFirst },
      { txs: tokensFirst,  exhausted: tokensExhaustedFirst },
      { txs: nativeLast,   exhausted: nativeExhaustedLast  },
      { txs: tokensLast,   exhausted: tokensExhaustedLast  },
    ] = await Promise.all([
      this.fetchNPages(addr, 'transactions',   fixedParamsAsc,  Math.ceil(windowFirst / 50)),
      this.fetchNPages(addr, 'token-transfers', fixedParamsAsc,  Math.ceil(windowFirst / 50)),
      this.fetchNPages(addr, 'transactions',   fixedParamsDesc, Math.ceil(windowLast  / 50)),
      this.fetchNPages(addr, 'token-transfers', fixedParamsDesc, Math.ceil(windowLast  / 50)),
    ]);

    // H8 — a scan is partial if EITHER the first OR last window was capped
    //      (was &&, now || — correct: partial if either window was truncated)
    const windowCapped =
      (!nativeExhaustedFirst || !tokensExhaustedFirst) ||
      (!nativeExhaustedLast  || !tokensExhaustedLast);

    const merged = this.dedup([...nativeFirst, ...tokensFirst, ...nativeLast, ...tokensLast]);

    const toBlock =
      merged.length > 0
        ? merged.reduce((max, tx) => (tx.blockNumber > max ? tx.blockNumber : max), 0n)
        : undefined;

    return {
      transactions: merged,
      totalFetched: merged.length,
      chain: this.chain,
      address: addr,
      toBlock,
      partial: windowCapped,
    };
  }

  // ---------------------------------------------------------------------------
  // Deep scan (all pages, no window limit)
  // ---------------------------------------------------------------------------

  private async fetchDeepScan(addr: string): Promise<FetchResult> {
    const fixedParams = { sort: 'asc', limit: '50' };
    const delayMs = env.DEEP_SCAN_PAGE_DELAY_MS;

    const [{ txs: nativeTxs }, { txs: tokenTxs }] = await Promise.all([
      this.fetchNPages(addr, 'transactions',   fixedParams, Infinity, delayMs),
      this.fetchNPages(addr, 'token-transfers', fixedParams, Infinity, delayMs),
    ]);

    const merged = this.dedup([...nativeTxs, ...tokenTxs]);

    const toBlock =
      merged.length > 0
        ? merged.reduce((max, tx) => (tx.blockNumber > max ? tx.blockNumber : max), 0n)
        : undefined;

    return {
      transactions: merged,
      totalFetched: merged.length,
      chain: this.chain,
      address: addr,
      toBlock,
      partial: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Delta fetch (from a specific block number)
  // ---------------------------------------------------------------------------

  private async fetchFromBlock(addr: string, fromBlock: bigint): Promise<FetchResult> {
    const maxPages = env.SCAN_MAX_PAGES_DELTA;
    const fixedParams = { sort: 'asc', limit: '50' };

    const allTxs: RawTransaction[] = [];
    let nativeNextPage: BlockscoutNextPage | null = null;
    let tokenNextPage: BlockscoutNextPage | null = null;
    let pages = 0;

    while (pages < maxPages) {
      const [nativePage, tokenPage] = await Promise.all([
        fetchBlockscoutPage<BlockscoutTx>(
          this.baseUrl, addr, 'transactions', fixedParams, nativeNextPage,
        ),
        fetchBlockscoutPage<BlockscoutTokenTransfer>(
          this.baseUrl, addr, 'token-transfers', fixedParams, tokenNextPage,
        ),
      ]);

      // C4 — only include confirmed transactions at or after fromBlock
      const newNative = (nativePage.items ?? []).filter(
        (item): item is BlockscoutTx & { block_number: number } =>
          item.block_number !== null &&
          item.block_number !== undefined &&
          BigInt(item.block_number) >= fromBlock,
      );
      const newTokens = (tokenPage.items ?? []).filter(
        (item): item is BlockscoutTokenTransfer & { block_number: number } =>
          item.block_number !== null &&
          item.block_number !== undefined &&
          BigInt(item.block_number) >= fromBlock,
      );

      for (const item of newNative) {
        const tx = normaliseTx(item, addr, this.chain);
        if (tx) allTxs.push(tx);
      }
      for (const item of newTokens) {
        const tx = normaliseTokenTransfer(item, addr, this.chain);
        if (tx) allTxs.push(tx);
      }

      nativeNextPage = nativePage.next_page_params ?? null;
      tokenNextPage = tokenPage.next_page_params ?? null;

      if (!nativeNextPage && !tokenNextPage) break;
      pages++;

      if (pages < maxPages) await sleep(env.SCANNER_DELAY_MS);
    }

    const merged = this.dedup(allTxs);
    const toBlock =
      merged.length > 0
        ? merged.reduce((max, tx) => (tx.blockNumber > max ? tx.blockNumber : max), 0n)
        : undefined;

    return {
      transactions: merged,
      totalFetched: merged.length,
      chain: this.chain,
      address: addr,
      fromBlock,
      toBlock,
      partial: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async fetchNPages(
    addr: string,
    kind: 'transactions' | 'token-transfers',
    fixedParams: Record<string, string>,
    maxPages: number,
    delayMs = env.SCANNER_DELAY_MS,
  ): Promise<{ txs: RawTransaction[]; exhausted: boolean }> {
    const txs: RawTransaction[] = [];
    let nextPage: BlockscoutNextPage | null = null;
    let pages = 0;

    while (pages < maxPages) {
      const page = await fetchBlockscoutPage<BlockscoutTx | BlockscoutTokenTransfer>(
        this.baseUrl, addr, kind, fixedParams, nextPage,
      );

      for (const item of page.items ?? []) {
        const tx =
          kind === 'transactions'
            ? normaliseTx(item as BlockscoutTx, addr, this.chain)
            : normaliseTokenTransfer(item as BlockscoutTokenTransfer, addr, this.chain);

        // C4 — filter out null (pending) transactions
        if (tx !== null) txs.push(tx);
      }

      nextPage = page.next_page_params ?? null;

      if (!nextPage) return { txs, exhausted: true };

      pages++;
      if (pages < maxPages) await sleep(delayMs);
    }

    return { txs, exhausted: false };
  }

  private dedup(txs: RawTransaction[]): RawTransaction[] {
    const seen = new Set<string>();
    return txs.filter((tx) => {
      if (seen.has(tx.txHash)) return false;
      seen.add(tx.txHash);
      return true;
    });
  }
}
