import type { ChainSlug } from './index.js';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawTransaction {
  txHash: string;
  fromAddress: string; // lowercase
  toAddress: string;   // lowercase, '' for contract creation
  blockNumber: bigint;
  blockTimestamp: Date;
  valueWei: string;    // native token value as string
  isInbound: boolean;  // relative to the scanned wallet address
  chain: ChainSlug;
  // ERC20 fields (undefined for native txs)
  tokenSymbol?: string;
  tokenContractAddress?: string;
  tokenValueRaw?: string;
}

export interface FetchResult {
  transactions: RawTransaction[];
  totalFetched: number;
  /**
   * true when the wallet has more txs than the scan window covers.
   * The fetcher grabbed first SCAN_WINDOW_FIRST + last SCAN_WINDOW_LAST txs
   * but skipped the middle. Queue a deep_scan job to fill the gap overnight.
   */
  partial: boolean;
  chain: ChainSlug;
  address: string;
  fromBlock?: bigint;
  toBlock?: bigint;
}

export interface FetchOptions {
  fromBlock?: bigint;
  /** If true, fetch ALL transactions (ignores window limits). Used by deep_scan jobs. */
  deepScan?: boolean;
}

// ---------------------------------------------------------------------------
// Chain configuration
// ---------------------------------------------------------------------------

const BLOCKSCOUT_CONFIGS: Record<string, { baseUrl: string }> = {
  ethereum: { baseUrl: 'https://eth.blockscout.com/api/v2' },
  base:     { baseUrl: 'https://base.blockscout.com/api/v2' },
  arbitrum: { baseUrl: 'https://arbitrum.blockscout.com/api/v2' },
  optimism: { baseUrl: 'https://optimism.blockscout.com/api/v2' },
  polygon:  { baseUrl: 'https://polygon.blockscout.com/api/v2' },
};

const ETHERSCAN_CONFIGS: Record<string, { baseUrl: string; envKey: string }> = {
  avalanche: { baseUrl: 'https://api.snowtrace.io/api', envKey: 'SNOWTRACE_API_KEY' },
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
      throw new Error(`HTTP ${response.status}`);
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) await sleep(backoffMs * (attempt + 1));
    }
  }
  throw lastErr;
}

function deduplicateTxs(txs: RawTransaction[]): RawTransaction[] {
  const seen = new Set<string>();
  return txs.filter((tx) => {
    const key = `${tx.txHash}:${tx.tokenContractAddress ?? 'native'}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

// ---------------------------------------------------------------------------
// Blockscout v2 types
// ---------------------------------------------------------------------------

interface BlockscoutTx {
  hash: string;
  from: { hash: string } | null;
  to: { hash: string } | null;
  block_number: number | null;
  timestamp: string;
  value: string;
}

interface BlockscoutTokenTransfer {
  transaction_hash: string;
  from: { hash: string } | null;
  to: { hash: string } | null;
  block_number: number | null;
  timestamp: string;
  total?: { value: string };
  token?: { symbol: string; address: string };
}

interface BlockscoutPageResponse<T> {
  items: T[];
  next_page_params?: Record<string, unknown> | null;
}

// ---------------------------------------------------------------------------
// Blockscout v2 normalisers
// ---------------------------------------------------------------------------

function normaliseTx(tx: BlockscoutTx, addr: string, chain: ChainSlug): RawTransaction {
  const from = tx.from?.hash?.toLowerCase() ?? '';
  const to   = tx.to?.hash?.toLowerCase()   ?? '';
  return {
    txHash: tx.hash,
    fromAddress: from,
    toAddress: to,
    blockNumber: BigInt(tx.block_number ?? 0),
    blockTimestamp: new Date(tx.timestamp),
    valueWei: tx.value ?? '0',
    isInbound: to === addr,
    chain,
  };
}

function normaliseTokenTransfer(tx: BlockscoutTokenTransfer, addr: string, chain: ChainSlug): RawTransaction {
  const from = tx.from?.hash?.toLowerCase() ?? '';
  const to   = tx.to?.hash?.toLowerCase()   ?? '';
  return {
    txHash: tx.transaction_hash,
    fromAddress: from,
    toAddress: to,
    blockNumber: BigInt(tx.block_number ?? 0),
    blockTimestamp: new Date(tx.timestamp),
    valueWei: '0',
    isInbound: to === addr,
    chain,
    ...(tx.token?.symbol  ? { tokenSymbol: tx.token.symbol } : {}),
    ...(tx.token?.address ? { tokenContractAddress: tx.token.address.toLowerCase() } : {}),
    ...(tx.total?.value   ? { tokenValueRaw: tx.total.value } : {}),
  };
}

async function fetchBlockscoutPage<T>(url: string): Promise<{ items: T[]; nextUrl: string | null }> {
  const resp = await fetchWithRetry(url, 3, 1000);
  const data = (await resp.json()) as BlockscoutPageResponse<T>;
  const next = data.next_page_params;
  if (!next || Object.keys(next).length === 0) return { items: data.items ?? [], nextUrl: null };
  const params = new URLSearchParams();
  for (const [k, v] of Object.entries(next)) params.set(k, String(v));
  // Preserve the base URL (before any ?) and append next_page_params
  const base = url.split('?')[0]!;
  const existingFixed = url.split('?')[1]
    ?.split('&')
    .filter(p => !Object.keys(next).includes(p.split('=')[0] ?? ''))
    .join('&') ?? '';
  const nextUrl: string = existingFixed
    ? `${base}?${existingFixed}&${params.toString()}`
    : `${base}?${params.toString()}`;
  return { items: data.items ?? [], nextUrl: nextUrl as string | null };
}

// ---------------------------------------------------------------------------
// Blockscout v2 — window fetch (first N asc + last M desc, detect gap)
// ---------------------------------------------------------------------------

async function fetchBlockscoutWindow(
  baseUrl: string,
  address: string,
  chain: ChainSlug,
  firstCount: number,
  lastCount: number,
  pageDelayMs: number,
): Promise<{ transactions: RawTransaction[]; partial: boolean }> {
  const addr = address.toLowerCase();

  async function fetchNPages<T>(
    startUrl: string,
    maxItems: number,
    normalise: (item: T) => RawTransaction,
  ): Promise<{ results: RawTransaction[]; exhausted: boolean }> {
    const results: RawTransaction[] = [];
    let url: string | null = startUrl;
    while (url && results.length < maxItems) {
      try {
        const { items, nextUrl }: { items: T[]; nextUrl: string | null } = await fetchBlockscoutPage<T>(url);
        results.push(...items.map(normalise));
        url = nextUrl;
        if (url) await sleep(pageDelayMs);
      } catch (err) {
        console.warn(`[BlockscoutFetcher:${chain}] page fetch failed:`, err);
        break;
      }
    }
    return { results, exhausted: url === null };
  }

  const normTx    = (tx: BlockscoutTx)         => normaliseTx(tx, addr, chain);
  const normToken = (tx: BlockscoutTokenTransfer) => normaliseTokenTransfer(tx, addr, chain);

  // First N ascending
  const { results: firstNative, exhausted: nativeExhaustedFirst } =
    await fetchNPages<BlockscoutTx>(
      `${baseUrl}/addresses/${addr}/transactions?limit=100&sort=asc`,
      firstCount, normTx,
    );

  const { results: firstTokens, exhausted: tokensExhaustedFirst } =
    await fetchNPages<BlockscoutTokenTransfer>(
      `${baseUrl}/addresses/${addr}/token-transfers?limit=100&type=ERC-20`,
      firstCount, normToken,
    );

  // Last M descending (then reverse)
  const { results: lastNativeRev, exhausted: nativeExhaustedLast } =
    await fetchNPages<BlockscoutTx>(
      `${baseUrl}/addresses/${addr}/transactions?limit=100&sort=desc`,
      lastCount, normTx,
    );
  const lastNative = [...lastNativeRev].reverse();

  const { results: lastTokensRev, exhausted: tokensExhaustedLast } =
    await fetchNPages<BlockscoutTokenTransfer>(
      `${baseUrl}/addresses/${addr}/token-transfers?limit=100&type=ERC-20&sort=desc`,
      lastCount, normToken,
    );
  const lastTokens = [...lastTokensRev].reverse();

  // Detect gap: latest block in first window < earliest block in last window
  const allFirst = [...firstNative, ...firstTokens];
  const allLast  = [...lastNative,  ...lastTokens];

  const firstMaxBlock = allFirst.reduce<bigint | null>((m, tx) => m === null || tx.blockNumber > m ? tx.blockNumber : m, null);
  const lastMinBlock  = allLast.reduce<bigint | null>((m, tx)  => m === null || tx.blockNumber < m ? tx.blockNumber : m, null);

  const hasGap = firstMaxBlock !== null && lastMinBlock !== null && firstMaxBlock < lastMinBlock - 1n;

  // Also partial if either window was capped (didn't exhaust the chain)
  const windowCapped = (!nativeExhaustedFirst || !tokensExhaustedFirst) &&
                       (!nativeExhaustedLast  || !tokensExhaustedLast);

  const partial = hasGap || windowCapped;

  if (partial) {
    console.info(
      `[BlockscoutFetcher:${chain}] partial scan for ${addr} — ` +
      `gap=${hasGap}, capped=${windowCapped}. Queue deep_scan for full coverage.`,
    );
  }

  const transactions = deduplicateTxs([...allFirst, ...allLast]);
  return { transactions, partial };
}

// ---------------------------------------------------------------------------
// Blockscout v2 — deep scan (all txs, slow, used overnight)
// ---------------------------------------------------------------------------

async function fetchBlockscoutAll(
  baseUrl: string,
  address: string,
  chain: ChainSlug,
  pageDelayMs: number,
): Promise<{ transactions: RawTransaction[]; partial: false }> {
  const addr = address.toLowerCase();
  const results: RawTransaction[] = [];

  let nativeUrl: string | null = `${baseUrl}/addresses/${addr}/transactions?limit=100&sort=asc`;
  while (nativeUrl) {
    try {
      const { items, nextUrl }: { items: BlockscoutTx[]; nextUrl: string | null } = await fetchBlockscoutPage<BlockscoutTx>(nativeUrl);
      results.push(...items.map((tx) => normaliseTx(tx, addr, chain)));
      nativeUrl = nextUrl;
      if (nativeUrl) await sleep(pageDelayMs);
    } catch (err) {
      console.warn(`[BlockscoutFetcher:${chain}] deep scan native page failed:`, err);
      break;
    }
  }

  let tokenUrl: string | null = `${baseUrl}/addresses/${addr}/token-transfers?limit=100&type=ERC-20`;
  while (tokenUrl) {
    try {
      const { items, nextUrl }: { items: BlockscoutTokenTransfer[]; nextUrl: string | null } = await fetchBlockscoutPage<BlockscoutTokenTransfer>(tokenUrl);
      results.push(...items.map((tx) => normaliseTokenTransfer(tx, addr, chain)));
      tokenUrl = nextUrl;
      if (tokenUrl) await sleep(pageDelayMs);
    } catch (err) {
      console.warn(`[BlockscoutFetcher:${chain}] deep scan token page failed:`, err);
      break;
    }
  }

  return { transactions: deduplicateTxs(results), partial: false };
}

// ---------------------------------------------------------------------------
// Blockscout v2 — delta scan (only txs after fromBlock, ascending, capped at N pages)
// ---------------------------------------------------------------------------

async function fetchBlockscoutDelta(
  baseUrl: string,
  address: string,
  chain: ChainSlug,
  fromBlock: bigint,
  maxPages: number,
  pageDelayMs: number,
): Promise<{ transactions: RawTransaction[]; partial: false }> {
  const addr = address.toLowerCase();

  async function fetchDeltaPages<T>(
    startUrl: string,
    normalise: (item: T) => RawTransaction,
    getBlockNumber: (item: T) => bigint,
  ): Promise<RawTransaction[]> {
    const results: RawTransaction[] = [];
    let url: string | null = startUrl;
    let pages = 0;

    while (url && pages < maxPages) {
      try {
        const { items, nextUrl }: { items: T[]; nextUrl: string | null } = await fetchBlockscoutPage<T>(url);
        pages++;

        // Filter: only keep items with blockNumber >= fromBlock
        const newItems = items.filter((item) => getBlockNumber(item) >= fromBlock);
        results.push(...newItems.map(normalise));

        // If every item on the page is below fromBlock, we're done (ascending order,
        // so nothing further back will be in range — but we're fetching ascending
        // so items should be in increasing block order). Stop if page is entirely old.
        if (items.length > 0 && items.every((item) => getBlockNumber(item) < fromBlock)) {
          break;
        }

        url = nextUrl;
        if (url) await sleep(pageDelayMs);
      } catch (err) {
        console.warn(`[BlockscoutFetcher:${chain}] delta page fetch failed:`, err);
        break;
      }
    }

    return results;
  }

  const normTx    = (tx: BlockscoutTx) => normaliseTx(tx, addr, chain);
  const normToken = (tx: BlockscoutTokenTransfer) => normaliseTokenTransfer(tx, addr, chain);

  const nativeTxs = await fetchDeltaPages<BlockscoutTx>(
    `${baseUrl}/addresses/${addr}/transactions?limit=100&sort=asc`,
    normTx,
    (tx) => BigInt(tx.block_number ?? 0),
  );

  const tokenTxs = await fetchDeltaPages<BlockscoutTokenTransfer>(
    `${baseUrl}/addresses/${addr}/token-transfers?limit=100&type=ERC-20&sort=asc`,
    normToken,
    (tx) => BigInt(tx.block_number ?? 0),
  );

  return { transactions: deduplicateTxs([...nativeTxs, ...tokenTxs]), partial: false };
}

// ---------------------------------------------------------------------------
// Etherscan/Snowtrace fetcher (Avalanche)
// ---------------------------------------------------------------------------

interface EtherscanTx {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  isError: string;
}

interface EtherscanTokenTx {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  tokenSymbol: string;
  contractAddress: string;
}

interface EtherscanResponse<T> {
  status: string;
  message: string;
  result: T[] | string;
}

async function fetchEtherscanAllTxs(
  baseUrl: string,
  address: string,
  chain: ChainSlug,
  apiKey: string | undefined,
  fromBlock?: bigint,
): Promise<{ transactions: RawTransaction[]; partial: boolean }> {
  const addr = address.toLowerCase();
  const results: RawTransaction[] = [];

  const buildUrl = (action: string): string => {
    const params = new URLSearchParams({
      module: 'account',
      action,
      address,
      startblock: fromBlock !== undefined ? fromBlock.toString() : '0',
      endblock: '99999999',
      sort: 'asc',
      offset: '10000',
      page: '1',
    });
    if (apiKey) params.set('apikey', apiKey);
    return `${baseUrl}?${params.toString()}`;
  };

  try {
    const resp = await fetchWithRetry(buildUrl('txlist'), 3, 1000);
    const data = (await resp.json()) as EtherscanResponse<EtherscanTx>;
    if (data.status === '1' && Array.isArray(data.result)) {
      for (const tx of data.result) {
        if (tx.isError !== '0') continue;
        results.push({
          txHash: tx.hash,
          fromAddress: tx.from.toLowerCase(),
          toAddress: tx.to.toLowerCase(),
          blockNumber: BigInt(tx.blockNumber),
          blockTimestamp: new Date(Number(tx.timeStamp) * 1000),
          valueWei: tx.value,
          isInbound: tx.to.toLowerCase() === addr,
          chain,
        });
      }
    }
  } catch (err) {
    console.warn(`[EtherscanFetcher:${chain}] native tx fetch failed:`, err);
  }

  try {
    const resp = await fetchWithRetry(buildUrl('tokentx'), 3, 1000);
    const data = (await resp.json()) as EtherscanResponse<EtherscanTokenTx>;
    if (data.status === '1' && Array.isArray(data.result)) {
      for (const tx of data.result) {
        results.push({
          txHash: tx.hash,
          fromAddress: tx.from.toLowerCase(),
          toAddress: tx.to.toLowerCase(),
          blockNumber: BigInt(tx.blockNumber),
          blockTimestamp: new Date(Number(tx.timeStamp) * 1000),
          valueWei: '0',
          isInbound: tx.to.toLowerCase() === addr,
          chain,
          ...(tx.tokenSymbol ? { tokenSymbol: tx.tokenSymbol } : {}),
          tokenContractAddress: tx.contractAddress.toLowerCase(),
          tokenValueRaw: tx.value,
        });
      }
    }
  } catch (err) {
    console.warn(`[EtherscanFetcher:${chain}] token tx fetch failed:`, err);
  }

  // Snowtrace caps at 10k via offset; mark partial if we hit that limit
  const deduped = deduplicateTxs(results);
  return { transactions: deduped, partial: deduped.length >= 10000 };
}

// ---------------------------------------------------------------------------
// WalletTransactionFetcher
// ---------------------------------------------------------------------------

export class WalletTransactionFetcher {
  private readonly chain: ChainSlug;

  constructor(chain: ChainSlug) {
    this.chain = chain;
  }

  /**
   * Fetch transactions using the first+last window strategy:
   *   - First SCAN_WINDOW_FIRST txs (asc) — early funding/sybil signals
   *   - Last SCAN_WINDOW_LAST txs (desc reversed) — recent deposit/P2P activity
   *   - Gap detection: if uncovered history exists, partial=true
   *
   * opts.deepScan=true: fetch ALL txs with DEEP_SCAN_PAGE_DELAY_MS between pages.
   * Only used by overnight deep_scan jobs for flagged partial wallets.
   *
   * opts.fromBlock: fetch only transactions at or after this block number (delta scan).
   * Skips the window strategy; fetches ascending from fromBlock up to
   * SCAN_MAX_PAGES_DELTA pages. partial=false for delta scans.
   */
  async fetchAll(address: string, opts?: FetchOptions): Promise<FetchResult> {
    const addr = address.toLowerCase();
    let fetchResult: { transactions: RawTransaction[]; partial: boolean };

    if (this.chain in BLOCKSCOUT_CONFIGS) {
      const { baseUrl } = BLOCKSCOUT_CONFIGS[this.chain]!;
      if (opts?.fromBlock !== undefined) {
        // Delta scan: fetch only new txs since fromBlock
        fetchResult = await fetchBlockscoutDelta(
          baseUrl, addr, this.chain,
          opts.fromBlock,
          env.SCAN_MAX_PAGES_DELTA,
          50,
        );
      } else if (opts?.deepScan) {
        fetchResult = await fetchBlockscoutAll(baseUrl, addr, this.chain, env.DEEP_SCAN_PAGE_DELAY_MS);
      } else {
        fetchResult = await fetchBlockscoutWindow(
          baseUrl, addr, this.chain,
          env.SCAN_WINDOW_FIRST,
          env.SCAN_WINDOW_LAST,
          50,
        );
      }
    } else if (this.chain in ETHERSCAN_CONFIGS) {
      const config = ETHERSCAN_CONFIGS[this.chain]!;
      const apiKey = env[config.envKey as keyof typeof env] as string | undefined;
      // Etherscan 10k cap is generous; deep_scan flag not needed for Avalanche
      // fromBlock wired directly to startblock param
      fetchResult = await fetchEtherscanAllTxs(config.baseUrl, addr, this.chain, apiKey, opts?.fromBlock);
    } else {
      throw new Error(`WalletTransactionFetcher: unsupported chain "${this.chain}"`);
    }

    const { transactions, partial } = fetchResult;
    const blockNumbers = transactions.map((t) => t.blockNumber);
    const fromBlock = blockNumbers.length > 0 ? blockNumbers.reduce((a, b) => (a < b ? a : b)) : undefined;
    const toBlock   = blockNumbers.length > 0 ? blockNumbers.reduce((a, b) => (a > b ? a : b)) : undefined;

    return {
      transactions,
      totalFetched: transactions.length,
      partial,
      chain: this.chain,
      address: addr,
      ...(fromBlock !== undefined ? { fromBlock } : {}),
      ...(toBlock   !== undefined ? { toBlock   } : {}),
    };
  }
}
