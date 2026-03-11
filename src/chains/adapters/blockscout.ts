import type { ChainAdapter, FirstInboundTx } from '../adapter.js';
import type { ChainSlug } from '../index.js';

const BLOCKSCOUT_CONFIGS: Record<string, { baseUrl: string }> = {
  base: { baseUrl: 'https://base.blockscout.com/api/v2' },
  arbitrum: { baseUrl: 'https://arbitrum.blockscout.com/api/v2' },
};

interface BlockscoutTx {
  hash: string;
  from: { hash: string };
  block_number: number;
  timestamp: string;
  value: string;
}

interface BlockscoutResponse {
  items: BlockscoutTx[];
  next_page_params?: unknown;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function fetchWithRetry(url: string, retries = 3, backoffMs = 1000): Promise<Response> {
  let lastErr: unknown;
  for (let attempt = 0; attempt < retries; attempt++) {
    try {
      const response = await fetch(url);
      return response;
    } catch (err) {
      lastErr = err;
      if (attempt < retries - 1) {
        await sleep(backoffMs * (attempt + 1));
      }
    }
  }
  throw lastErr;
}

export class BlockscoutAdapter implements ChainAdapter {
  readonly chain: ChainSlug;
  private readonly baseUrl: string;

  constructor(chain: ChainSlug) {
    const config = BLOCKSCOUT_CONFIGS[chain];
    if (!config) {
      throw new Error(`BlockscoutAdapter: unsupported chain "${chain}"`);
    }
    this.chain = chain;
    this.baseUrl = config.baseUrl;
  }

  async getFirstInboundNativeTx(address: string): Promise<FirstInboundTx | null> {
    const url = `${this.baseUrl}/addresses/${address}/transactions?filter=to&limit=10&sort=asc`;

    let data: BlockscoutResponse;
    try {
      const response = await fetchWithRetry(url, 3, 1000);
      if (!response.ok) {
        console.warn(
          `[BlockscoutAdapter:${this.chain}] HTTP ${response.status} for ${address}`,
        );
        return null;
      }
      data = (await response.json()) as BlockscoutResponse;
    } catch (err) {
      console.warn(`[BlockscoutAdapter:${this.chain}] Fetch error for ${address}:`, err);
      return null;
    }

    if (!Array.isArray(data.items) || data.items.length === 0) {
      return null;
    }

    // Filter: non-zero native token value
    const inbound = data.items.filter((tx) => {
      try {
        return BigInt(tx.value) > 0n;
      } catch {
        return false;
      }
    });

    if (inbound.length === 0) {
      return null;
    }

    // Take the first item (already sorted asc by block)
    const earliest = inbound.reduce((min, tx) =>
      tx.block_number < min.block_number ? tx : min,
    );

    return {
      txHash: earliest.hash,
      fromAddress: earliest.from.hash.toLowerCase(),
      blockNumber: BigInt(earliest.block_number),
      blockTimestamp: new Date(earliest.timestamp),
      valueWei: earliest.value,
      chain: this.chain,
    };
  }
}
