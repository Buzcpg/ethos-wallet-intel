import type { ChainSlug } from './index.js';
import type { ChainAdapter } from './adapter.js';
import { EtherscanAdapter } from './adapters/etherscan.js';
import { BlockscoutAdapter, isBlockscoutChain } from './adapters/blockscout.js';

// Blockscout first — free, no key needed, generous rate limits.
// Etherscan fallback only for Avalanche (no confirmed Blockscout v2 instance for AVAX C-chain).
// When a Blockscout instance for Avalanche is confirmed, move it here too.
const ETHERSCAN_ONLY_CHAINS: ChainSlug[] = ['avalanche'];

const adapterCache = new Map<ChainSlug, ChainAdapter>();

export function getAdapter(chain: ChainSlug): ChainAdapter {
  const cached = adapterCache.get(chain);
  if (cached) return cached;

  let adapter: ChainAdapter;
  if (isBlockscoutChain(chain)) {
    adapter = new BlockscoutAdapter(chain);
  } else if ((ETHERSCAN_ONLY_CHAINS as string[]).includes(chain)) {
    adapter = new EtherscanAdapter(chain);
  } else {
    throw new Error(`No adapter registered for chain "${chain}"`);
  }

  adapterCache.set(chain, adapter);
  return adapter;
}

export function getAllAdapters(): ChainAdapter[] {
  const allChains: ChainSlug[] = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon', 'avalanche'];
  return allChains.map((chain) => getAdapter(chain));
}
