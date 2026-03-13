/**
 * alchemyFetcher.ts — Alchemy-powered transaction fetcher
 *
 * Uses alchemy_getAssetTransfers JSON-RPC method.
 * Rate limit: 330 CU/sec free tier. Each call ≈ 150 CU.
 * Global rate limiter capped at 2 calls/sec (conservative).
 *
 * Strategy:
 *   - First-funder: tiered (1–2 calls): native ETH inbound asc, then stable fallback
 *   - Recent outbound: 1 call (desc, limit 50) for deposit detection
 *   - Delta scan (fromBlock): 2 calls (inbound + outbound since that block)
 */

import type { ChainSlug } from './index.js';
import { env } from '../config/env.js';
import { acquireToken } from '../lib/rateLimiter.js';
import type { FetchResult, FetchAllOptions, RawTransaction } from './transactionFetcher.js';

// ---------------------------------------------------------------------------
// Alchemy config
// ---------------------------------------------------------------------------

function alchemyUrl(chain: ChainSlug): string {
  const key = env.ALCHEMY_API_KEY;
  const endpoints: Record<ChainSlug, string> = {
    ethereum: `https://eth-mainnet.g.alchemy.com/v2/${key}`,
    base:     `https://base-mainnet.g.alchemy.com/v2/${key}`,
    arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${key}`,
    optimism: `https://opt-mainnet.g.alchemy.com/v2/${key}`,
    polygon:  `https://polygon-mainnet.g.alchemy.com/v2/${key}`,
  };
  return endpoints[chain];
}

// ETH L1 + Polygon support 'internal'; L2s do not
function nativeCategories(chain: ChainSlug): string[] {
  return ['ethereum', 'polygon'].includes(chain)
    ? ['external', 'internal']
    : ['external'];
}

// ---------------------------------------------------------------------------
// Known contract labels — classify funders (never skip; always store)
// Confidence: EOA=1.0, cex=0.8, bridge=0.7, unknown_contract=0.6, dex=0.5
// ---------------------------------------------------------------------------

export type FunderType = 'eoa' | 'bridge' | 'cex' | 'dex' | 'unknown_contract';

interface FunderLabel { type: FunderType; name: string; confidence: number }

const FUNDER_LABELS: Record<string, FunderLabel> = {
  // Bridges — still valid first funder, traceable cross-chain
  '0x80c67432656d59144ceff962e8faf8926599bcf8': { type: 'bridge', name: 'Orbiter Finance relay',      confidence: 0.7 },
  '0x99c9fc46f92e8a1c0dec1b1747d010903e884be1': { type: 'bridge', name: 'Optimism gateway',           confidence: 0.7 },
  '0x49048044d57e1c92a77f79988d21fa8faf74e97e': { type: 'bridge', name: 'Base bridge (L1Standard)',   confidence: 0.7 },
  '0x3154cf16ccdb4c6d922629664174b904d80f2c35': { type: 'bridge', name: 'Base bridge (L1ERC20)',      confidence: 0.7 },
  '0x4200000000000000000000000000000000000010': { type: 'bridge', name: 'Optimism L2 bridge',         confidence: 0.7 },
  '0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f': { type: 'bridge', name: 'Arbitrum inbox',             confidence: 0.7 },
  '0x8484ef722627bf18ca5ae6bcf031c23e6e922b30': { type: 'bridge', name: 'Across protocol',            confidence: 0.7 },
  // DEX routers — swap-funded; source wallet unclear, lowest signal
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': { type: 'dex',    name: 'Uniswap Universal Router',  confidence: 0.5 },
  '0x2626664c2603336e57b271c5c0b26f421741e481': { type: 'dex',    name: 'Uniswap V3 Router (Base)',   confidence: 0.5 },
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': { type: 'dex',    name: 'Kyberswap',                 confidence: 0.5 },
  '0x1111111254eeb25477b68fb85ed929f73a960582': { type: 'dex',    name: '1inch v5',                   confidence: 0.5 },
  // CEX hot wallets — useful clustering signal
  '0x28c6c06298d514db089934071355e5743bf21d60': { type: 'cex',    name: 'Binance hot wallet',         confidence: 0.8 },
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549': { type: 'cex',    name: 'Binance cold wallet',        confidence: 0.8 },
  '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43': { type: 'cex',    name: 'Coinbase',                   confidence: 0.8 },
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3': { type: 'cex',    name: 'Coinbase 2',                 confidence: 0.8 },
};

function classifyFunder(address: string): FunderLabel {
  return FUNDER_LABELS[address.toLowerCase()] ?? { type: 'eoa', name: '', confidence: 1.0 };
}

// ---------------------------------------------------------------------------
// Stablecoins by chain for tier-2 first-funder fallback
// ---------------------------------------------------------------------------

const STABLE_CONTRACTS: Record<ChainSlug, string[]> = {
  ethereum: [
    '0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48', // USDC
    '0xdac17f958d2ee523a2206206994597c13d831ec7', // USDT
    '0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2', // WETH
  ],
  base: [
    '0x833589fcd6edb6e08f4c7c32d4f71b54bda02913', // USDC
    '0xfde4c96c8593536e31f229ea8f37b2ada2699bb2', // USDbC
    '0x4200000000000000000000000000000000000006', // WETH
  ],
  arbitrum: [
    '0xaf88d065e77c8cc2239327c5edb3a432268e5831', // USDC
    '0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9', // USDT
    '0x82af49447d8a07e3bd95bd0d56f35241523fbab1', // WETH
  ],
  optimism: [
    '0x0b2c639c533813f4aa9d7837caf62653d097ff85', // USDC
    '0x94b008aa00579c1307b0ef2c499ad98a8ce58e58', // USDT
    '0x4200000000000000000000000000000000000006', // WETH
  ],
  polygon: [
    '0x3c499c542cef5e3811e1192ce70d8cc03d5c3359', // USDC
    '0xc2132d05d31c914a87c6611c10748aeb04b58e8f', // USDT
    '0x7ceb23fd6bc0add59e62ac25578270cff1b9f619', // WETH
  ],
};

// ---------------------------------------------------------------------------
// Alchemy API types
// ---------------------------------------------------------------------------

interface AlchemyTransfer {
  blockNum: string;
  hash: string;
  from: string;
  to: string | null;
  value: number | null;
  asset: string | null;
  category: string;
  rawContract: {
    value: string | null;
    address: string | null;
    decimal: string | null;
  };
  metadata?: {
    blockTimestamp?: string;
  };
}

interface AlchemyResponse {
  result?: { transfers: AlchemyTransfer[] };
  error?: { message: string; code?: number };
}

// ---------------------------------------------------------------------------
// Low-level RPC call
// ---------------------------------------------------------------------------

let _callId = 0;

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function alchemyCall(
  url: string,
  params: Record<string, unknown>,
  retries = 4,
): Promise<AlchemyTransfer[]> {
  const id = ++_callId;
  let lastErr: Error = new Error('alchemyCall: no attempts');

  for (let attempt = 0; attempt < retries; attempt++) {
    await acquireToken();

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          jsonrpc: '2.0',
          method: 'alchemy_getAssetTransfers',
          params: [params],
        }),
      });

      if (env.LOG_LEVEL === 'debug') {
        console.debug(`[alchemy] ${res.status} POST alchemy_getAssetTransfers`);
      }

      if (res.status === 429) {
        const retryAfter = res.headers.get('retry-after');
        const waitMs = retryAfter ? Number(retryAfter) * 1000 + 100 : 1500 * Math.pow(2, attempt);
        console.warn(`[alchemy] rate limited (429) — waiting ${Math.round(waitMs)}ms`);
        await sleep(waitMs);
        lastErr = new Error(`rate limited (429) attempt ${attempt + 1}`);
        continue;
      }

      if (res.status === 503) {
        console.warn(`[alchemy] service unavailable (503) — waiting 10s`);
        await sleep(10_000);
        lastErr = new Error(`service unavailable (503) attempt ${attempt + 1}`);
        continue;
      }

      if (!res.ok) {
        throw new Error(`Alchemy HTTP ${res.status}`);
      }

      const data = (await res.json()) as AlchemyResponse;

      if (data.error) {
        throw new Error(`Alchemy RPC error: ${data.error.message}`);
      }

      return data.result?.transfers ?? [];
    } catch (err) {
      const isRetryable =
        err instanceof Error &&
        (err.message.startsWith('rate limited') || err.message.startsWith('service unavailable'));
      if (!isRetryable) throw err;
      lastErr = err as Error;
      if (attempt < retries - 1) await sleep(500);
    }
  }

  throw lastErr;
}

// ---------------------------------------------------------------------------
// Normalise an AlchemyTransfer → RawTransaction
// ---------------------------------------------------------------------------

function normalise(
  tx: AlchemyTransfer,
  walletAddr: string,
  chain: ChainSlug,
): RawTransaction | null {
  let blockNumber: bigint;
  try {
    blockNumber = BigInt(tx.blockNum);
  } catch {
    return null;
  }

  const tsStr = tx.metadata?.blockTimestamp;
  const blockTimestamp = tsStr ? new Date(tsStr) : new Date(0);
  if (isNaN(blockTimestamp.getTime())) return null;

  const toAddr = tx.to?.toLowerCase() ?? '';
  const fromAddr = tx.from.toLowerCase();
  const lowerWallet = walletAddr.toLowerCase();

  const isErc20 = tx.category === 'erc20' || tx.category === 'token';

  // valueWei: use rawContract.value (hex) for precision; fall back to float
  let valueWei = '0';
  if (!isErc20) {
    if (tx.rawContract.value) {
      try {
        valueWei = BigInt(tx.rawContract.value).toString();
      } catch {
        valueWei = tx.value !== null ? String(Math.round(tx.value * 1e18)) : '0';
      }
    } else if (tx.value !== null) {
      valueWei = String(Math.round(tx.value * 1e18));
    }
  }

  // tokenValueRaw: raw ERC20 transfer amount
  let tokenValueRaw: string | undefined;
  if (isErc20 && tx.rawContract.value) {
    try {
      tokenValueRaw = BigInt(tx.rawContract.value).toString();
    } catch {
      tokenValueRaw = tx.value !== null ? String(tx.value) : undefined;
    }
  }

  const base: RawTransaction = {
    txHash: tx.hash,
    fromAddress: fromAddr,
    toAddress: toAddr,
    blockNumber,
    blockTimestamp,
    valueWei,
    isInbound: toAddr === lowerWallet,
    chain,
  };

  if (isErc20 && tx.rawContract.address) {
    base.tokenContractAddress = tx.rawContract.address.toLowerCase();
  }
  if (isErc20 && tx.asset) {
    base.tokenSymbol = tx.asset;
  }
  if (tokenValueRaw !== undefined) {
    base.tokenValueRaw = tokenValueRaw;
  }

  return base;
}

// ---------------------------------------------------------------------------
// First-funder result
// ---------------------------------------------------------------------------

interface FirstFunderResult {
  transactions: RawTransaction[];
  confidence: number;
  funderType: FunderType;
  funderLabel: string;  // human-readable name, empty for EOA
}

// ---------------------------------------------------------------------------
// AlchemyFetcher
// ---------------------------------------------------------------------------

export class AlchemyFetcher {
  private readonly url: string;

  constructor(private readonly chain: ChainSlug) {
    this.url = alchemyUrl(chain);
  }

  /**
   * Main entry point — mirrors WalletTransactionFetcher.fetchAll interface.
   */
  async fetchAll(address: string, opts?: FetchAllOptions): Promise<FetchResult> {
    const addr = address.toLowerCase();

    if (opts?.fromBlock !== undefined) {
      return this.fetchFromBlock(addr, opts.fromBlock);
    }

    // Default and deepScan both use the tiered Alchemy approach
    return this.fetchWindowed(addr);
  }

  // ---------------------------------------------------------------------------
  // Default / deep-scan path
  // ---------------------------------------------------------------------------

  private async fetchWindowed(addr: string): Promise<FetchResult> {
    const funderResult = await this.findFirstFunder(addr);
    const outbound = await this.fetchRecentOutbound(addr);

    const inbound = funderResult?.transactions ?? [];
    const allTxs = this.dedup([...inbound, ...outbound]);

    const toBlock =
      allTxs.length > 0
        ? allTxs.reduce((max, tx) => (tx.blockNumber > max ? tx.blockNumber : max), 0n)
        : undefined;

    return {
      transactions: allTxs,
      totalFetched: allTxs.length,
      chain: this.chain,
      address: addr,
      partial: false,
      ...(toBlock !== undefined ? { toBlock } : {}),
    };
  }

  // ---------------------------------------------------------------------------
  // Delta fetch (from a specific block)
  // ---------------------------------------------------------------------------

  private async fetchFromBlock(addr: string, fromBlock: bigint): Promise<FetchResult> {
    const fromHex = `0x${fromBlock.toString(16)}`;
    const cats = nativeCategories(this.chain);

    // Inbound: all native + erc20 since fromBlock
    const inboundCats = [...new Set([...cats, 'erc20'])];

    const rawInbound = await alchemyCall(this.url, {
      toAddress: addr,
      fromBlock: fromHex,
      toBlock: 'latest',
      category: inboundCats,
      order: 'asc',
      maxCount: '0x64', // 100
      withMetadata: true,
      excludeZeroValue: true,
    });
    const rawOutbound = await alchemyCall(this.url, {
      fromAddress: addr,
      fromBlock: fromHex,
      toBlock: 'latest',
      category: ['external', 'erc20'],
      order: 'desc',
      maxCount: '0x32', // 50
      withMetadata: true,
      excludeZeroValue: true,
    });

    const txs: RawTransaction[] = [];
    for (const t of rawInbound) {
      const tx = normalise(t, addr, this.chain);
      if (tx) txs.push(tx);
    }
    for (const t of rawOutbound) {
      const tx = normalise(t, addr, this.chain);
      if (tx) txs.push(tx);
    }

    const merged = this.dedup(txs);
    const toBlock =
      merged.length > 0
        ? merged.reduce((max, tx) => (tx.blockNumber > max ? tx.blockNumber : max), 0n)
        : undefined;

    return {
      transactions: merged,
      totalFetched: merged.length,
      chain: this.chain,
      address: addr,
      fromBlock,
      ...(toBlock !== undefined ? { toBlock } : {}),
      partial: false,
    };
  }

  // ---------------------------------------------------------------------------
  // Tiered first-funder detection (1–2 calls)
  // ---------------------------------------------------------------------------

  private async findFirstFunder(addr: string): Promise<FirstFunderResult | null> {
    const cats = nativeCategories(this.chain);

    // Tier 1: native ETH inbound, oldest-first, limit 10
    const rawNative = await alchemyCall(this.url, {
      toAddress: addr,
      fromBlock: '0x0',
      toBlock: 'latest',
      category: cats,
      order: 'asc',
      maxCount: '0xa',
      withMetadata: true,
      excludeZeroValue: true,
    });

    if (rawNative.length > 0) {
      const txs: RawTransaction[] = [];
      for (const t of rawNative) {
        const tx = normalise(t, addr, this.chain);
        if (tx) txs.push(tx);
      }

      // Classify the first (oldest) funder — never skip, always store
      const firstFunder = rawNative[0]!;
      const classification = classifyFunder(firstFunder.from);
      if (env.LOG_LEVEL === 'debug') {
        console.debug(`[alchemyFetcher] first funder: ${firstFunder.from} type=${classification.type} confidence=${classification.confidence}${classification.name ? ' (' + classification.name + ')' : ''}`);
      }

      return {
        transactions: txs,
        confidence: classification.confidence,
        funderType: classification.type,
        funderLabel: classification.name,
      };
    }

    // Tier 2: stablecoin fallback (only if tier 1 returned nothing)
    const stables = STABLE_CONTRACTS[this.chain] ?? [];
    if (stables.length === 0) return null;

    const rawStable = await alchemyCall(this.url, {
      toAddress: addr,
      fromBlock: '0x0',
      toBlock: 'latest',
      category: ['erc20'],
      contractAddresses: stables,
      order: 'asc',
      maxCount: '0xa',
      withMetadata: true,
      excludeZeroValue: true,
    });

    if (rawStable.length === 0) return null;

    const txs: RawTransaction[] = [];
    for (const t of rawStable) {
      const tx = normalise(t, addr, this.chain);
      if (tx) txs.push(tx);
    }

    // Classify the first stablecoin funder — never skip
    const firstStableFunder = rawStable[0]!;
    const stableClass = classifyFunder(firstStableFunder.from);
    // Stablecoin tier is inherently one step less certain than native ETH,
    // so cap confidence at 0.7 even for EOAs
    const stableConfidence = Math.min(stableClass.confidence, 0.7);
    if (env.LOG_LEVEL === 'debug') {
      console.debug(`[alchemyFetcher] first stable funder: ${firstStableFunder.from} type=${stableClass.type} confidence=${stableConfidence}`);
    }

    return {
      transactions: txs,
      confidence: stableConfidence,
      funderType: stableClass.type,
      funderLabel: stableClass.name,
    };
  }

  // ---------------------------------------------------------------------------
  // Recent outbound (1 call, desc, limit 50)
  // ---------------------------------------------------------------------------

  private async fetchRecentOutbound(addr: string): Promise<RawTransaction[]> {
    const rawOutbound = await alchemyCall(this.url, {
      fromAddress: addr,
      fromBlock: '0x0',
      toBlock: 'latest',
      category: ['external', 'erc20'],
      order: 'desc',
      maxCount: '0x32', // 50
      withMetadata: false,
      excludeZeroValue: true,
    });

    const txs: RawTransaction[] = [];
    for (const t of rawOutbound) {
      const tx = normalise(t, addr, this.chain);
      if (tx) txs.push(tx);
    }
    return txs;
  }

  // ---------------------------------------------------------------------------
  // Deduplicate by txHash
  // ---------------------------------------------------------------------------

  private dedup(txs: RawTransaction[]): RawTransaction[] {
    const seen = new Set<string>();
    return txs.filter((tx) => {
      if (seen.has(tx.txHash)) return false;
      seen.add(tx.txHash);
      return true;
    });
  }
}
