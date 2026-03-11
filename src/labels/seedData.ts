export interface SeedLabel {
  chain: string;
  address: string;
  label: string;
  kind: 'exchange_hot_wallet' | 'cex_deposit';
}

/**
 * Hardcoded bootstrap set of known CEX hot wallets across chains.
 * These are high-confidence exchange addresses — not individual deposit addresses
 * (those are resolved dynamically via LabelResolver / Blockscout tags).
 *
 * Sources: publicly documented, on-chain labels, Etherscan tags.
 */
export const CEX_SEED_LABELS: SeedLabel[] = [
  // ── Binance (ETH mainnet) ─────────────────────────────────────────────────
  {
    chain: 'ethereum',
    address: '0x28c6c06298d514db089934071355e5743bf21d60',
    label: 'Binance',
    kind: 'exchange_hot_wallet',
  },
  {
    chain: 'ethereum',
    address: '0x21a31ee1afc51d94c2efccaa2092ad1028285549',
    label: 'Binance',
    kind: 'exchange_hot_wallet',
  },
  {
    chain: 'ethereum',
    address: '0xdfd5293d8e347dfe59e90efd55b2956a1343963d',
    label: 'Binance',
    kind: 'exchange_hot_wallet',
  },
  {
    chain: 'ethereum',
    address: '0x56eddb7aa87536c09ccc2793473599fd21a8b17f',
    label: 'Binance',
    kind: 'exchange_hot_wallet',
  },
  // ── Coinbase (ETH mainnet) ────────────────────────────────────────────────
  {
    chain: 'ethereum',
    address: '0x71660c4005ba85c37ccec55d0c4493e66fe775d3',
    label: 'Coinbase',
    kind: 'exchange_hot_wallet',
  },
  {
    chain: 'ethereum',
    address: '0x503828976d22510aad0201ac7ec88293211d23da',
    label: 'Coinbase',
    kind: 'exchange_hot_wallet',
  },
  {
    chain: 'ethereum',
    address: '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43',
    label: 'Coinbase',
    kind: 'exchange_hot_wallet',
  },
  // ── Kraken ────────────────────────────────────────────────────────────────
  {
    chain: 'ethereum',
    address: '0x2910543af39aba0cd09dbb2d50200b3e800a63d2',
    label: 'Kraken',
    kind: 'exchange_hot_wallet',
  },
  {
    chain: 'ethereum',
    address: '0x0a869d79a7052c7f1b55a8ebabbea3420f0d1e13',
    label: 'Kraken',
    kind: 'exchange_hot_wallet',
  },
  // ── OKX ───────────────────────────────────────────────────────────────────
  {
    chain: 'ethereum',
    address: '0x6cc5f688a315f3dc28a7781717a9a798a59fda7b',
    label: 'OKX',
    kind: 'exchange_hot_wallet',
  },
  {
    chain: 'ethereum',
    address: '0x236f9f97e0e62388479bf9e5ba4889e46b0273c3',
    label: 'OKX',
    kind: 'exchange_hot_wallet',
  },
  // ── Bybit ─────────────────────────────────────────────────────────────────
  {
    chain: 'ethereum',
    address: '0xf89d7b9c864f589bbf53a82105107622b35eaa40',
    label: 'Bybit',
    kind: 'exchange_hot_wallet',
  },
  // ── KuCoin ────────────────────────────────────────────────────────────────
  {
    chain: 'ethereum',
    address: '0x2b5634c42055806a59e9107ed44d43c426e58258',
    label: 'KuCoin',
    kind: 'exchange_hot_wallet',
  },
  {
    chain: 'ethereum',
    address: '0xa1d8d972560c2f8144af871db508f0b0b10a3fbf',
    label: 'KuCoin',
    kind: 'exchange_hot_wallet',
  },
  // ── Bitfinex ──────────────────────────────────────────────────────────────
  {
    chain: 'ethereum',
    address: '0x77134cbc06cb00b66f4c7e623d5fdbf6777635ec',
    label: 'Bitfinex',
    kind: 'exchange_hot_wallet',
  },
  {
    chain: 'ethereum',
    address: '0x742d35cc6634c0532925a3b844bc454e4438f44e',
    label: 'Bitfinex',
    kind: 'exchange_hot_wallet',
  },
  // ── Huobi / HTX ───────────────────────────────────────────────────────────
  {
    chain: 'ethereum',
    address: '0xab5c66752a9e8167967685f1450532fb96d5d24f',
    label: 'Huobi',
    kind: 'exchange_hot_wallet',
  },
  {
    chain: 'ethereum',
    address: '0x6748f50f686bfbca6fe8ad62b22228b87f31ff2b',
    label: 'Huobi',
    kind: 'exchange_hot_wallet',
  },
  // ── Gate.io ───────────────────────────────────────────────────────────────
  {
    chain: 'ethereum',
    address: '0x0d0707963952f2fba59dd06f2b425ace40b492fe',
    label: 'Gate.io',
    kind: 'exchange_hot_wallet',
  },
  // ── Binance (Polygon) ─────────────────────────────────────────────────────
  {
    chain: 'polygon',
    address: '0xb7eab3e9e61614454fc95d17e4469e98cc6acf74',
    label: 'Binance',
    kind: 'exchange_hot_wallet',
  },
  // ── Binance (Avalanche) ───────────────────────────────────────────────────
  {
    chain: 'avalanche',
    address: '0x4aefa39caeadd87e6e8655be7aa55e0d8f11fdb7',
    label: 'Binance',
    kind: 'exchange_hot_wallet',
  },
];

/**
 * Exchange-related keywords used when matching Blockscout public tags.
 * Case-insensitive match.
 */
export const CEX_KEYWORDS = [
  'binance',
  'coinbase',
  'kraken',
  'bybit',
  'okx',
  'kucoin',
  'gate',
  'bitfinex',
  'huobi',
  'htx',
  'gemini',
  'bitget',
  'mexc',
  'crypto.com',
  'bitstamp',
  'upbit',
  'bithumb',
  'poloniex',
  'bittrex',
  'whitebit',
];
