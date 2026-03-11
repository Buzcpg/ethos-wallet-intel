export const SUPPORTED_CHAINS = {
  ethereum: { id: 1, name: 'Ethereum', slug: 'ethereum', nativeSymbol: 'ETH' },
  base: { id: 8453, name: 'Base', slug: 'base', nativeSymbol: 'ETH' },
  arbitrum: { id: 42161, name: 'Arbitrum One', slug: 'arbitrum', nativeSymbol: 'ETH' },
  optimism: { id: 10, name: 'Optimism', slug: 'optimism', nativeSymbol: 'ETH' },
  polygon: { id: 137, name: 'Polygon', slug: 'polygon', nativeSymbol: 'POL' },
  avalanche: { id: 43114, name: 'Avalanche', slug: 'avalanche', nativeSymbol: 'AVAX' },
} as const;

export type ChainSlug = keyof typeof SUPPORTED_CHAINS;
export type ChainConfig = (typeof SUPPORTED_CHAINS)[ChainSlug];

export const CHAIN_SLUGS = Object.keys(SUPPORTED_CHAINS) as ChainSlug[];

export function isValidChain(chain: string): chain is ChainSlug {
  return chain in SUPPORTED_CHAINS;
}
