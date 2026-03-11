import type { ChainSlug } from './index.js';
import { env } from '../config/env.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RawTransaction {
  txHash: string;
  fromAddress: string; // lowercase
  toAddress: string; // lowercase, '' for contract creation
  blockNumber: bigint;
  blockTimestamp: Date;
  valueWei: string; // native token value as string
  isInbound: boolean; // relative to the scanned wallet address
  chain: ChainSlug;
  // ERC20 transfer fields (undefined for native txs)
  tokenSymbol?: string;
  tokenContractAddress?: string;
  tokenValueRaw?: string;
}

export interface FetchResult {
  transactions: RawTransaction[];
  totalFetched: number;
  chain: ChainSlug;
  address: string;
  fromBlock?: bigint;
  toBlock?: bigint;
}

export interface FetchOptions {
  fromBlock?: bigint;
}

// ---------------------------------------------------------------------------
// Chain configuration
// ---------------------------------------------------------------------------

const BLOCKSCOUT_CONFIGS: Record<string, { baseUrl: string }> = {
  ethereum: { baseUrl: 'https://eth.blockscout.com/api/v2' },
  base: { baseUrl: 'https://base.blockscout.com/api/v2' },
  arbitrum: { baseUrl: 'https://arbitrum.blockscout.com/api/v2' },
  optimism: { baseUrl: 'https://optimism.blockscout.com/api/v2' },
  polygon: { baseUrl: 'https://polygon.blockscout.com/api/v2' },
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

// ---------------------------------------------------------------------------
// Blockscout v2 fetcher
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

interface BlockscoutTxResponse {
  items: BlockscoutTx[];
  next_page_params?: Record<string, unknown> | null;
}

interface BlockscoutTokenResponse {
  items: BlockscoutTokenTransfer[];
  next_page_params?: Record<string, unknown> | null;
}

async function fetchBlockscoutAllTxs(
  baseUrl: string,
  address: string,
  chain: ChainSlug,
): Promise<RawTransaction[]> {
  const addr = address.toLowerCase();
  const PAGE_DELAY = 50;
  const results: RawTransaction[] = [];

  // ---- Native transactions ----
  let nativeUrl: string | null =
    `${baseUrl}/addresses/${addr}/transactions?limit=100&sort=asc`;

  while (nativeUrl) {
    let data: BlockscoutTxResponse;
    try {
      const resp = await fetchWithRetry(nativeUrl, 3, 1000);
      data = (await resp.json()) as BlockscoutTxResponse;
    } catch (err) {
      console.warn(`[BlockscoutFetcher:${chain}] native tx page failed:`, err);
      break;
    }

    for (const tx of data.items ?? []) {
      if (tx.block_number === null) continue;
      const fromAddr = tx.from?.hash?.toLowerCase() ?? '';
      const toAddr = tx.to?.hash?.toLowerCase() ?? '';
      results.push({
        txHash: tx.hash,
        fromAddress: fromAddr,
        toAddress: toAddr,
        blockNumber: BigInt(tx.block_number),
        blockTimestamp: new Date(tx.timestamp),
        valueWei: tx.value ?? '0',
        isInbound: toAddr === addr,
        chain,
      });
    }

    const next = data.next_page_params;
    if (next && Object.keys(next).length > 0) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(next)) {
        params.set(k, String(v));
      }
      nativeUrl = `${baseUrl}/addresses/${addr}/transactions?limit=100&sort=asc&${params.toString()}`;
      await sleep(PAGE_DELAY);
    } else {
      nativeUrl = null;
    }
  }

  // ---- ERC-20 transfers ----
  let tokenUrl: string | null =
    `${baseUrl}/addresses/${addr}/token-transfers?limit=100&type=ERC-20`;

  while (tokenUrl) {
    let data: BlockscoutTokenResponse;
    try {
      const resp = await fetchWithRetry(tokenUrl, 3, 1000);
      data = (await resp.json()) as BlockscoutTokenResponse;
    } catch (err) {
      console.warn(`[BlockscoutFetcher:${chain}] token transfer page failed:`, err);
      break;
    }

    for (const tx of data.items ?? []) {
      if (tx.block_number === null) continue;
      const fromAddr = tx.from?.hash?.toLowerCase() ?? '';
      const toAddr = tx.to?.hash?.toLowerCase() ?? '';
      results.push({
        txHash: tx.transaction_hash,
        fromAddress: fromAddr,
        toAddress: toAddr,
        blockNumber: BigInt(tx.block_number),
        blockTimestamp: new Date(tx.timestamp),
        valueWei: '0',
        isInbound: toAddr === addr,
        chain,
        ...(tx.token?.symbol !== undefined ? { tokenSymbol: tx.token.symbol } : {}),
        ...(tx.token?.address !== undefined ? { tokenContractAddress: tx.token.address.toLowerCase() } : {}),
        ...(tx.total?.value !== undefined ? { tokenValueRaw: tx.total.value } : {}),
      });
    }

    const next = data.next_page_params;
    if (next && Object.keys(next).length > 0) {
      const params = new URLSearchParams();
      for (const [k, v] of Object.entries(next)) {
        params.set(k, String(v));
      }
      tokenUrl = `${baseUrl}/addresses/${addr}/token-transfers?limit=100&type=ERC-20&${params.toString()}`;
      await sleep(PAGE_DELAY);
    } else {
      tokenUrl = null;
    }
  }

  return results;
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
): Promise<RawTransaction[]> {
  const addr = address.toLowerCase();
  const results: RawTransaction[] = [];

  const buildUrl = (action: string): string => {
    const params = new URLSearchParams({
      module: 'account',
      action,
      address,
      startblock: '0',
      endblock: '99999999',
      sort: 'asc',
      offset: '10000',
      page: '1',
    });
    if (apiKey) params.set('apikey', apiKey);
    return `${baseUrl}?${params.toString()}`;
  };

  // Native txs
  try {
    const resp = await fetchWithRetry(buildUrl('txlist'), 3, 1000);
    const data = (await resp.json()) as EtherscanResponse<EtherscanTx>;
    if (data.status === '1' && Array.isArray(data.result)) {
      for (const tx of data.result) {
        if (tx.isError !== '0') continue;
        const fromAddr = tx.from.toLowerCase();
        const toAddr = tx.to.toLowerCase();
        results.push({
          txHash: tx.hash,
          fromAddress: fromAddr,
          toAddress: toAddr,
          blockNumber: BigInt(tx.blockNumber),
          blockTimestamp: new Date(Number(tx.timeStamp) * 1000),
          valueWei: tx.value,
          isInbound: toAddr === addr,
          chain,
        });
      }
    }
  } catch (err) {
    console.warn(`[EtherscanFetcher:${chain}] native tx fetch failed:`, err);
  }

  // ERC-20 transfers
  try {
    const resp = await fetchWithRetry(buildUrl('tokentx'), 3, 1000);
    const data = (await resp.json()) as EtherscanResponse<EtherscanTokenTx>;
    if (data.status === '1' && Array.isArray(data.result)) {
      for (const tx of data.result) {
        const fromAddr = tx.from.toLowerCase();
        const toAddr = tx.to.toLowerCase();
        results.push({
          txHash: tx.hash,
          fromAddress: fromAddr,
          toAddress: toAddr,
          blockNumber: BigInt(tx.blockNumber),
          blockTimestamp: new Date(Number(tx.timeStamp) * 1000),
          valueWei: '0',
          isInbound: toAddr === addr,
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

  return results;
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
   * Fetch ALL transactions for a wallet (native + ERC20, paginated).
   */
  async fetchAll(address: string, opts?: FetchOptions): Promise<FetchResult> {
    const addr = address.toLowerCase();
    let transactions: RawTransaction[];

    if (this.chain in BLOCKSCOUT_CONFIGS) {
      const config = BLOCKSCOUT_CONFIGS[this.chain]!;
      transactions = await fetchBlockscoutAllTxs(config.baseUrl, addr, this.chain);
    } else if (this.chain in ETHERSCAN_CONFIGS) {
      const config = ETHERSCAN_CONFIGS[this.chain]!;
      const apiKey = env[config.envKey as keyof typeof env] as string | undefined;
      transactions = await fetchEtherscanAllTxs(config.baseUrl, addr, this.chain, apiKey);
    } else {
      throw new Error(`WalletTransactionFetcher: unsupported chain "${this.chain}"`);
    }

    // Deduplicate by txHash + token contract (a tx can appear in both native and token endpoints)
    const seen = new Set<string>();
    const deduped: RawTransaction[] = [];
    for (const tx of transactions) {
      const key = `${tx.txHash}:${tx.tokenContractAddress ?? 'native'}`;
      if (!seen.has(key)) {
        seen.add(key);
        deduped.push(tx);
      }
    }

    const blockNumbers = deduped.map((t) => t.blockNumber);
    const fromBlock =
      blockNumbers.length > 0 ? blockNumbers.reduce((a, b) => (a < b ? a : b)) : undefined;
    const toBlock =
      blockNumbers.length > 0 ? blockNumbers.reduce((a, b) => (a > b ? a : b)) : undefined;

    // Satisfy opts usage (fromBlock for delta scans — currently not used in fetch logic
    // but accepted for forward-compatibility with M5)
    void opts;

    return {
      transactions: deduped,
      totalFetched: deduped.length,
      chain: this.chain,
      address: addr,
      ...(fromBlock !== undefined ? { fromBlock } : {}),
      ...(toBlock !== undefined ? { toBlock } : {}),
    };
  }
}
