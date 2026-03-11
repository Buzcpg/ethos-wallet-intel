import type { ChainSlug } from './index.js';
import type { ChainAdapter } from './adapter.js';
import { EtherscanAdapter } from './adapters/etherscan.js';
import { BlockscoutAdapter } from './adapters/blockscout.js';

const ETHERSCAN_CHAINS: ChainSlug[] = ['ethereum', 'optimism', 'polygon', 'avalanche'];
const BLOCKSCOUT_CHAINS: ChainSlug[] = ['base', 'arbitrum'];

const adapterCache = new Map<ChainSlug, ChainAdapter>();

export function getAdapter(chain: ChainSlug): ChainAdapter {
  const cached = adapterCache.get(chain);
  if (cached) return cached;

  let adapter: ChainAdapter;
  if ((ETHERSCAN_CHAINS as string[]).includes(chain)) {
    adapter = new EtherscanAdapter(chain);
  } else if ((BLOCKSCOUT_CHAINS as string[]).includes(chain)) {
    adapter = new BlockscoutAdapter(chain);
  } else {
    throw new Error(`No adapter registered for chain "${chain}"`);
  }

  adapterCache.set(chain, adapter);
  return adapter;
}

export function getAllAdapters(): ChainAdapter[] {
  const allChains: ChainSlug[] = [...ETHERSCAN_CHAINS, ...BLOCKSCOUT_CHAINS];
  return allChains.map((chain) => getAdapter(chain));
}
