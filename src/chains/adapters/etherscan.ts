import type { ChainAdapter, FirstInboundTx } from '../adapter.js';
import type { ChainSlug } from '../index.js';
import { env } from '../../config/env.js';

// Etherscan-compatible API config per chain
const ETHERSCAN_CONFIGS: Record<string, { baseUrl: string; envKey: string }> = {
  ethereum: { baseUrl: 'https://api.etherscan.io/api', envKey: 'ETHERSCAN_API_KEY' },
  optimism: {
    baseUrl: 'https://api-optimistic.etherscan.io/api',
    envKey: 'ETHERSCAN_API_KEY',
  },
  polygon: { baseUrl: 'https://api.polygonscan.com/api', envKey: 'POLYGONSCAN_API_KEY' },
  avalanche: { baseUrl: 'https://api.snowtrace.io/api', envKey: 'SNOWTRACE_API_KEY' },
};

interface EtherscanTx {
  blockNumber: string;
  timeStamp: string;
  hash: string;
  from: string;
  to: string;
  value: string;
  isError: string;
}

interface EtherscanResponse {
  status: string;
  message: string;
  result: EtherscanTx[] | string;
}

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
        // Rate limited — back off and retry
        await sleep(backoffMs * (attempt + 1));
        continue;
      }
      throw new Error(`Etherscan API returned ${response.status}`);
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) {
        await sleep(backoffMs * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

export class EtherscanAdapter implements ChainAdapter {
  readonly chain: ChainSlug;
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly delayMs: number;

  constructor(chain: ChainSlug) {
    const config = ETHERSCAN_CONFIGS[chain];
    if (!config) {
      throw new Error(`EtherscanAdapter: unsupported chain "${chain}"`);
    }
    this.chain = chain;
    this.baseUrl = config.baseUrl;
    this.delayMs = env.SCANNER_DELAY_MS;

    // Resolve API key: chain-specific key first, then ETHERSCAN_API_KEY fallback
    const chainKey = env[config.envKey as keyof typeof env] as string | undefined;
    this.apiKey = chainKey ?? env.ETHERSCAN_API_KEY;

    if (!this.apiKey) {
      console.warn(
        `[EtherscanAdapter:${chain}] No API key set — free tier rate limits apply (slower)`,
      );
    }
  }

  async getFirstInboundNativeTx(address: string): Promise<FirstInboundTx | null> {
    const lowerAddress = address.toLowerCase();
    const url = this.buildUrl(address);

    await sleep(this.delayMs);

    let data: EtherscanResponse;
    try {
      const response = await fetchWithRetry(url, 3, 1000);
      data = (await response.json()) as EtherscanResponse;
    } catch (err) {
      console.warn(`[EtherscanAdapter:${this.chain}] Fetch error for ${address}:`, err);
      return null;
    }

    if (data.status !== '1') {
      // NOTX is a normal case (no transactions), not a real error
      if (data.message !== 'No transactions found') {
        console.warn(
          `[EtherscanAdapter:${this.chain}] API error for ${address}: ${data.message}`,
        );
      }
      return null;
    }

    if (!Array.isArray(data.result)) {
      return null;
    }

    // Filter: inbound, non-zero value, no error
    const inbound = data.result.filter(
      (tx) =>
        tx.to.toLowerCase() === lowerAddress &&
        tx.value !== '0' &&
        tx.isError === '0',
    );

    if (inbound.length === 0) {
      return null;
    }

    // Take the earliest by blockNumber (already sorted asc, but be safe)
    const earliest = inbound.reduce((min, tx) =>
      BigInt(tx.blockNumber) < BigInt(min.blockNumber) ? tx : min,
    );

    return {
      txHash: earliest.hash,
      fromAddress: earliest.from.toLowerCase(),
      blockNumber: BigInt(earliest.blockNumber),
      blockTimestamp: new Date(Number(earliest.timeStamp) * 1000),
      valueWei: earliest.value,
      chain: this.chain,
    };
  }

  private buildUrl(address: string): string {
    const params = new URLSearchParams({
      module: 'account',
      action: 'txlist',
      address,
      startblock: '0',
      endblock: '99999999',
      page: '1',
      offset: '10',
      sort: 'asc',
    });
    if (this.apiKey) {
      params.set('apikey', this.apiKey);
    }
    return `${this.baseUrl}?${params.toString()}`;
  }
}
