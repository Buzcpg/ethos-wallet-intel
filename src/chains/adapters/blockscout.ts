import type { ChainAdapter, FirstInboundTx } from '../adapter.js';
import type { ChainSlug } from '../index.js';

// Blockscout v2 REST API instances.
// Use Blockscout for all chains where an official instance exists — free, generous limits, no key needed.
// Avalanche: no confirmed Blockscout v2 instance for C-chain; handled by EtherscanAdapter (Snowtrace).
const BLOCKSCOUT_CONFIGS: Record<string, { baseUrl: string }> = {
  ethereum: { baseUrl: 'https://eth.blockscout.com/api/v2' },
  base:     { baseUrl: 'https://base.blockscout.com/api/v2' },
  arbitrum: { baseUrl: 'https://arbitrum.blockscout.com/api/v2' },
  optimism: { baseUrl: 'https://optimism.blockscout.com/api/v2' },
  polygon:  { baseUrl: 'https://polygon.blockscout.com/api/v2' },
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
      if (response.ok) return response;
      if (response.status === 429) {
        // Rate limited — back off
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

export class BlockscoutAdapter implements ChainAdapter {
  readonly chain: ChainSlug;
  private baseUrl: string;

  constructor(chain: ChainSlug) {
    const config = BLOCKSCOUT_CONFIGS[chain];
    if (!config) {
      throw new Error(`BlockscoutAdapter: no config for chain "${chain}"`);
    }
    this.chain = chain;
    this.baseUrl = config.baseUrl;
  }

  async getFirstInboundNativeTx(address: string): Promise<FirstInboundTx | null> {
    const addr = address.toLowerCase();
    // Filter=to returns txs where this address is the recipient; limit=10, sort=asc gets earliest first
    const url = `${this.baseUrl}/addresses/${addr}/transactions?filter=to&limit=10&sort=asc`;

    let data: BlockscoutResponse;
    try {
      const response = await fetchWithRetry(url);
      data = (await response.json()) as BlockscoutResponse;
    } catch (err) {
      console.warn(`[BlockscoutAdapter:${this.chain}] fetch failed for ${addr}:`, err);
      return null;
    }

    if (!data?.items?.length) return null;

    // Find first tx with non-zero native value
    const tx = data.items.find((t) => t.value && BigInt(t.value) > 0n);
    if (!tx) return null;

    return {
      txHash: tx.hash,
      fromAddress: tx.from.hash.toLowerCase(),
      blockNumber: BigInt(tx.block_number),
      blockTimestamp: new Date(tx.timestamp),
      valueWei: tx.value,
      chain: this.chain,
    };
  }
}

export function isBlockscoutChain(chain: string): boolean {
  return chain in BLOCKSCOUT_CONFIGS;
}
