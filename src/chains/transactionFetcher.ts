import type { ChainSlug } from './index.js';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// API key rotation — shared pool, round-robin across all requests.
// Each key has its own per-account rate limit bucket per chain instance.
// ---------------------------------------------------------------------------
let _rotatorIdx = 0;
function nextApiKey(): string | undefined {
  const keys = (env.BLOCKSCOUT_API_KEYS ?? '')
    .split(',').map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) return undefined;
  return keys[_rotatorIdx++ % keys.length];
}

/**
 * Returns the Authorization header for Blockscout PRO API.
 * PRO key uses Bearer header; My Account keys use ?apikey= query param.
 * PRO key is multichain; My Account key is per-chain-instance only.
 */
function proAuthHeader(): Record<string, string> {
  const proKey = env.BLOCKSCOUT_PRO_API_KEY;
  if (proKey) return { Authorization: `Bearer ${proKey}` };
  // Fall back to no auth header (My Account key is added as query param separately)
  return {};
}

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

// Blockscout chain config
// v2: cursor-based DESC pagination — used for recent tx window (deposit detection)
// v1: Etherscan-compat API — supports sort=asc, used for first-funder detection
const BLOCKSCOUT_CONFIGS: Record<string, { baseUrl: string; v1Url: string }> = {
  ethereum: { baseUrl: 'https://eth.blockscout.com/api/v2', v1Url: 'https://eth.blockscout.com/api' },
  base:     { baseUrl: 'https://base.blockscout.com/api/v2', v1Url: 'https://base.blockscout.com/api' },
  arbitrum: { baseUrl: 'https://arbitrum.blockscout.com/api/v2', v1Url: 'https://arbitrum.blockscout.com/api' },
  optimism: { baseUrl: 'https://optimism.blockscout.com/api/v2', v1Url: 'https://optimism.blockscout.com/api' },
  polygon:  { baseUrl: 'https://polygon.blockscout.com/api/v2', v1Url: 'https://polygon.blockscout.com/api' },
  // Avalanche removed — Snowtrace does not support Blockscout v1 compat API reliably
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, retries = 4, backoffMs = 1500, extraHeaders: Record<string,string> = {}): Promise<Response> {
  let lastErr: Error = new Error('fetchWithRetry: no attempts made');
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url, {
        headers: extraHeaders,
      });
      if (response.ok) return response;

      if (response.status === 429 || response.status === 503) {
        // 429 = rate limited, 503 = Blockscout instance down
        const wait = backoffMs * Math.pow(2, attempt); // 1.5s, 3s, 6s, 12s
        const label = response.status === 429 ? 'rate limited (429)' : 'service unavailable (503)';
        console.warn(`[fetcher] ${label} — waiting ${Math.round(wait/1000)}s (attempt ${attempt+1}/${retries}): ${url.split('?')[0]}`);
        await sleep(wait);
        lastErr = new Error(`${label} after ${attempt + 1} attempts`);
        continue;
      }

      // All other non-ok statuses are real errors — don't retry
      throw new Error(`Blockscout returned ${response.status} for ${url.split('?')[0]}`);
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      if (attempt < retries - 1) await sleep(backoffMs);
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
  chain?: string,
): Promise<BlockscoutPage<T>> {
  if (chain) await chainRateLimit(chain);
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

  const response = await fetchWithRetry(url.toString(), 4, 1500, proAuthHeader());
  return (await response.json()) as BlockscoutPage<T>;
}

// ---------------------------------------------------------------------------
// WalletTransactionFetcher
// ---------------------------------------------------------------------------

// Per-chain rate limiter: ensures we don't exceed 1 req/sec per chain
// (PRO free tier = 5 RPS total across all chains — 1/chain is safe)
const _lastReqMs: Record<string, number> = {};
async function chainRateLimit(chain: string, minGapMs = 1000): Promise<void> {
  const last = _lastReqMs[chain] ?? 0;
  const wait = minGapMs - (Date.now() - last);
  if (wait > 0) await sleep(wait);
  _lastReqMs[chain] = Date.now();
}

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
    const windowLast = env.SCAN_WINDOW_LAST;
    const pagesLast  = Math.ceil(windowLast / 50);

    // v2 API (DESC, newest first) — for recent tx window used by deposit detection
    // NOTE: v2 API does NOT accept sort or limit params — omit them entirely
    const [txsDescNative, txsDescTokens] = await Promise.all([
      this.fetchNPages(addr, 'transactions',    {}, pagesLast),
      this.fetchNPages(addr, 'token-transfers', {}, pagesLast),
    ]);

    // v1 compat API (ASC, oldest first) — for first-funder detection
    const [txsAscNative, txsAscTokens] = await Promise.all([
      this.fetchV1Oldest(addr, 'txlist',  env.SCAN_WINDOW_FIRST),
      this.fetchV1Oldest(addr, 'tokentx', env.SCAN_WINDOW_FIRST),
    ]);

    const merged = this.dedup([
      ...txsAscNative.txs, ...txsAscTokens.txs,
      ...txsDescNative.txs, ...txsDescTokens.txs,
    ]);

    const partial = !txsDescNative.exhausted || !txsAscNative.exhausted;

    const toBlock = merged.length > 0
      ? merged.reduce((max, tx) => tx.blockNumber > max ? tx.blockNumber : max, 0n)
      : undefined;

    return {
      transactions: merged,
      totalFetched: merged.length,
      chain: this.chain,
      address: addr,
      partial,
      ...(toBlock !== undefined ? { toBlock } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Deep scan (all pages, no window limit)
  // ---------------------------------------------------------------------------

  private async fetchDeepScan(addr: string): Promise<FetchResult> {
    // Full history: v2 DESC all pages + v1 ASC all pages, merged
    const [descNative, descTokens] = await Promise.all([
      this.fetchNPages(addr, 'transactions',    {}, Infinity),
      this.fetchNPages(addr, 'token-transfers', {}, Infinity),
    ]);
    const [ascNative, ascTokens] = await Promise.all([
      this.fetchV1Oldest(addr, 'txlist',  999999),
      this.fetchV1Oldest(addr, 'tokentx', 999999),
    ]);

    const merged = this.dedup([
      ...ascNative.txs, ...ascTokens.txs,
      ...descNative.txs, ...descTokens.txs,
    ]);

    const toBlock = merged.length > 0
      ? merged.reduce((max, tx) => tx.blockNumber > max ? tx.blockNumber : max, 0n)
      : undefined;

    return {
      transactions: merged,
      totalFetched: merged.length,
      chain: this.chain,
      address: addr,
      partial: false,
      ...(toBlock !== undefined ? { toBlock } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Delta fetch (from a specific block number)
  // ---------------------------------------------------------------------------

  private async fetchFromBlock(addr: string, fromBlock: bigint): Promise<FetchResult> {
    const maxPages = env.SCAN_MAX_PAGES_DELTA;
    // fetchFromBlock uses v1 compat API for ASC ordering
    const fixedParams: Record<string,string> = {}; // v2: no sort/limit — use v1 for ASC

    const allTxs: RawTransaction[] = [];
    let nativeNextPage: BlockscoutNextPage | null = null;
    let tokenNextPage: BlockscoutNextPage | null = null;
    let pages = 0;

    while (pages < maxPages) {
      const [nativePage, tokenPage]: [BlockscoutPage<BlockscoutTx>, BlockscoutPage<BlockscoutTokenTransfer>] = await Promise.all([
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
      ...(toBlock !== undefined ? { toBlock } : {}),
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
      const page: BlockscoutPage<BlockscoutTx | BlockscoutTokenTransfer> = await fetchBlockscoutPage<BlockscoutTx | BlockscoutTokenTransfer>(
        this.baseUrl, addr, kind, fixedParams, nextPage, this.chain,
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

  /**
   * fetchV1Oldest — uses Blockscout's Etherscan-compatible v1 API.
   * Supports sort=asc (oldest first) — critical for first-funder detection.
   * Returns up to maxTxs oldest transactions for this address.
   * Falls back to empty on error (v1 API may not be available on all instances).
   */
  private async fetchV1Oldest(
    addr: string,
    action: 'txlist' | 'tokentx',
    maxTxs: number,
  ): Promise<{ txs: RawTransaction[]; exhausted: boolean }> {
    const config = BLOCKSCOUT_CONFIGS[this.chain];
    if (!config) return { txs: [], exhausted: true };

    const pageSize = 50;
    const pages = Math.ceil(maxTxs / pageSize);
    const allTxs: RawTransaction[] = [];

    for (let page = 1; page <= pages; page++) {
      const url = new URL(config.v1Url);
      url.searchParams.set('module', 'account');
      url.searchParams.set('action', action);
      url.searchParams.set('address', addr);
      url.searchParams.set('sort', 'asc');
      url.searchParams.set('page', String(page));
      url.searchParams.set('offset', String(pageSize));
      const apiKey = nextApiKey();
      if (apiKey) url.searchParams.set('apikey', apiKey);

      let data: { status: string; message: string; result: unknown };
      try {
        const response = await fetchWithRetry(url.toString());
        data = await response.json() as typeof data;
      } catch (err) {
        console.warn(`[fetcher:v1:${this.chain}] ${action} failed for ${addr}:`, err instanceof Error ? err.message : err);
        return { txs: allTxs, exhausted: false };
      }

      if (data.status !== '1') {
        // status=0 + message=No transactions found is normal for inactive addresses
        if (data.message?.includes('No transactions') || data.message?.includes('No records')) {
          return { txs: allTxs, exhausted: true };
        }
        // Any other error (rate limit, API down) — log and bail
        console.warn(`[fetcher:v1:${this.chain}] ${action} error for ${addr}: ${data.message}`);
        return { txs: allTxs, exhausted: false };
      }

      const items = Array.isArray(data.result) ? data.result as Record<string, string>[] : [];

      for (const item of items) {
        // v1 compat format differs from v2 — map to RawTransaction
        const blockNum = BigInt(item['blockNumber'] ?? '0');
        const ts = new Date(Number(item['timeStamp'] ?? '0') * 1000);
        if (isNaN(ts.getTime())) continue;

        const lowerAddr = addr.toLowerCase();
        const toAddr = (item['to'] ?? '').toLowerCase();
        const fromAddr = (item['from'] ?? '').toLowerCase();

        if (action === 'txlist') {
          allTxs.push({
            txHash: item['hash'] ?? '',
            fromAddress: fromAddr,
            toAddress: toAddr,
            blockNumber: blockNum,
            blockTimestamp: ts,
            valueWei: item['value'] ?? '0',
            isInbound: toAddr === lowerAddr,
            chain: this.chain,
          });
        } else {
          // tokentx
          allTxs.push({
            txHash: item['hash'] ?? '',
            fromAddress: fromAddr,
            toAddress: toAddr,
            blockNumber: blockNum,
            blockTimestamp: ts,
            valueWei: '0',
            tokenContractAddress: (item['contractAddress'] ?? '').toLowerCase(),
            tokenSymbol: item['tokenSymbol'] ?? '',
            tokenValueRaw: item['value'] ?? '0',
            isInbound: toAddr === lowerAddr,
            chain: this.chain,
          });
        }
      }

      // If we got fewer than pageSize, there are no more pages
      if (items.length < pageSize) return { txs: allTxs, exhausted: true };

      if (page < pages) await sleep(env.SCANNER_DELAY_MS);
    }

    return { txs: allTxs, exhausted: allTxs.length < maxTxs };
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
