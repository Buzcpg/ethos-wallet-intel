import type { ChainAdapter, FirstInboundTx } from '../adapter.js';
import type { ChainSlug } from '../index.js';
import { env } from '../../config/env.js';

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

// Round-robin key rotator — distributes requests across all configured keys.
// Each key has its own per-account rate limit bucket, so N keys ≈ N× throughput.
class KeyRotator {
  private keys: string[];
  private idx = 0;

  constructor(keys: string[]) {
    this.keys = keys.filter(Boolean);
  }

  next(): string | undefined {
    if (this.keys.length === 0) return undefined;
    const key = this.keys[this.idx % this.keys.length];
    this.idx++;
    return key;
  }

  count(): number { return this.keys.length; }
}

// Shared rotator — single instance across all BlockscoutAdapter instances so
// rotation is global (not per-chain-adapter). Reads keys at module load time.
function buildRotator(): KeyRotator {
  const raw = env.BLOCKSCOUT_API_KEYS ?? '';
  const keys = raw.split(',').map(k => k.trim()).filter(Boolean);
  if (keys.length === 0) {
    console.warn('[BlockscoutAdapter] no API keys configured — running at IP rate limit');
  } else {
    console.log(`[BlockscoutAdapter] key rotation: ${keys.length} key(s) configured`);
  }
  return new KeyRotator(keys);
}

const rotator = buildRotator();

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
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

export class BlockscoutAdapter implements ChainAdapter {
  readonly chain: ChainSlug;
  private readonly baseUrl: string;

  constructor(chain: ChainSlug) {
    const config = BLOCKSCOUT_CONFIGS[chain];
    if (!config) throw new Error(`BlockscoutAdapter: no config for chain "${chain}"`);
    this.chain = chain;
    this.baseUrl = config.baseUrl;
  }

  private buildUrl(addr: string, path: string, extra: Record<string, string> = {}): string {
    const params = new URLSearchParams({ ...extra });
    const key = rotator.next();
    if (key) params.set('apikey', key);
    return `${this.baseUrl}/${path}?${params.toString()}`;
  }

  async getFirstInboundNativeTx(address: string): Promise<FirstInboundTx | null> {
    const addr = address.toLowerCase();
    const url = this.buildUrl(addr, `addresses/${addr}/transactions`, {
      filter: 'to',
      limit: '10',
      sort: 'asc',
    });

    let data: BlockscoutResponse;
    try {
      const response = await fetchWithRetry(url);
      data = (await response.json()) as BlockscoutResponse;
    } catch (err) {
      console.warn(`[BlockscoutAdapter:${this.chain}] fetch failed for ${addr}:`, err);
      return null;
    }

    if (!data?.items?.length) return null;

    const tx = data.items.find(t => t.value && BigInt(t.value) > 0n);
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
