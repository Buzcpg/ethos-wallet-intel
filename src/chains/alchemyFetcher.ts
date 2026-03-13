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
  '0x8731d54e9d02c286767d56ac03e8037c07e01e98': { type: 'bridge', name: 'Stargate router',            confidence: 0.7 },
  '0x45a01e4e04f14f7a4a6702c74187c5f6222033cd': { type: 'bridge', name: 'Stargate router (Poly)',     confidence: 0.7 },
  '0x25ace71c97b33cc4729cf772ae268934f7ab5fa1': { type: 'bridge', name: 'Hop protocol',               confidence: 0.7 },
  '0x3666f603cc164936c1b87e207f36beba4ac5f18a': { type: 'bridge', name: 'Synapse bridge',             confidence: 0.7 },
  // DEX routers — swap-funded; source wallet unclear, lowest signal
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': { type: 'dex',    name: 'Uniswap Universal Router',  confidence: 0.5 },
  '0x2626664c2603336e57b271c5c0b26f421741e481': { type: 'dex',    name: 'Uniswap V3 Router (Base)',   confidence: 0.5 },
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': { type: 'dex',    name: 'Kyberswap',                  confidence: 0.5 },
  '0x1111111254eeb25477b68fb85ed929f73a960582': { type: 'dex',    name: '1inch v5',                   confidence: 0.5 },
  '0xd9e1ce17f2641f24ae83637ab66a2cca9c378b9f': { type: 'dex',    name: 'SushiSwap router',           confidence: 0.5 },
  '0xdef1c0ded9bec7f1a1670819833240f027b25eff': { type: 'dex',    name: '0x Exchange Proxy',          confidence: 0.5 },
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
  result?: { transfers: AlchemyTransfer[]; pageKey?: string };
  error?: { message: string; code?: number };
}

// ---------------------------------------------------------------------------
// Low-level RPC call
// ---------------------------------------------------------------------------

let _callId = 0;

// Errors that warrant a retry with backoff
const RETRYABLE_STRINGS = [
  'rate limited',
  'service unavailable',
  'econnreset',
  'etimedout',
  'fetch failed',
  'network',
  'socket',
];

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

async function alchemyCall(
  url: string,
  params: Record<string, unknown>,
  retries = 4,
): Promise<{ transfers: AlchemyTransfer[]; pageKey?: string }> {
  const id = ++_callId;
  let lastErr: Error = new Error('alchemyCall: no attempts');

  for (let attempt = 0; attempt < retries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 30_000);

    try {
      await acquireToken();

      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id,
          jsonrpc: '2.0',
          method: 'alchemy_getAssetTransfers',
          params: [params],
        }),
        signal: controller.signal,
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

      const transfers = data.result?.transfers ?? [];
      const pageKey = data.result?.pageKey;
      return pageKey !== undefined ? { transfers, pageKey } : { transfers };
    } catch (err) {
      const isAbort = err instanceof Error && err.name === 'AbortError';
      const isRetryable =
        isAbort ||
        (err instanceof Error &&
          RETRYABLE_STRINGS.some((s) => (err as Error).message.toLowerCase().includes(s)));
      if (!isRetryable) throw err;
      lastErr = err as Error;
      const backoffMs = Math.min(1_000 * Math.pow(2, attempt), 30_000);
      if (attempt < retries - 1) await sleep(backoffMs);
    } finally {
      clearTimeout(timeoutId);
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

  const toAddr = tx.to?.toLowerCase() ?? null;
  // Contract creation (or malformed): tx.to is null — not relevant to wallet scan
  if (toAddr === null) return null;

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
  funderLabel: string;    // human-readable name, empty for EOA
  firstPageFull: boolean; // true if first page hit maxCount (suggests truncation)
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
      // partial: true when either call hit its hard cap — walletScanner should deep-scan
      partial: (funderResult?.firstPageFull === true || outbound.length >= 50),
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

    const { transfers: rawInbound } = await alchemyCall(this.url, {
      toAddress: addr,
      fromBlock: fromHex,
      toBlock: 'latest',
      category: inboundCats,
      order: 'asc',
      maxCount: '0x64', // 100
      withMetadata: true,
      excludeZeroValue: true,
    });
    const { transfers: rawOutbound } = await alchemyCall(this.url, {
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
  // Tiered first-funder detection — paginate up to MAX_PAGES per tier
  // ---------------------------------------------------------------------------

  private async findFirstFunder(addr: string): Promise<FirstFunderResult | null> {
    const cats = nativeCategories(this.chain);
    const MAX_PAGES = 3;
    const NATIVE_MAX_COUNT = 10; // 0xa

    const allTxs: RawTransaction[] = [];
    let firstTransfer: AlchemyTransfer | null = null;
    let firstPageFull = false;
    let pageKey: string | undefined;
    let foundEoa = false;

    // Tier 1: native ETH inbound, oldest-first, paginate up to MAX_PAGES
    for (let page = 0; page < MAX_PAGES; page++) {
      const callParams: Record<string, unknown> = {
        toAddress: addr,
        fromBlock: '0x0',
        toBlock: 'latest',
        category: cats,
        order: 'asc',
        maxCount: '0xa',
        withMetadata: true,
        excludeZeroValue: true,
      };
      if (pageKey !== undefined) callParams['pageKey'] = pageKey;

      const { transfers: raw, pageKey: nextKey } = await alchemyCall(this.url, callParams);

      if (raw.length === 0) break;

      // Record first transfer (oldest overall) from the very first page
      if (page === 0) {
        firstTransfer = raw[0] ?? null;
        firstPageFull = raw.length >= NATIVE_MAX_COUNT;
      }

      for (const t of raw) {
        const tx = normalise(t, addr, this.chain);
        if (tx) allTxs.push(tx);
        // Track whether we've found an EOA funder on this page
        if (!foundEoa && classifyFunder(t.from).type === 'eoa') {
          foundEoa = true;
        }
      }

      // Stop as soon as we find an EOA or there are no more pages
      if (foundEoa || !nextKey) break;
      pageKey = nextKey;
    }

    if (allTxs.length > 0 && firstTransfer !== null) {
      const classification = classifyFunder(firstTransfer.from);
      if (env.LOG_LEVEL === 'debug') {
        console.debug(
          `[alchemyFetcher] first funder: ${firstTransfer.from} type=${classification.type} confidence=${classification.confidence}${classification.name ? ' (' + classification.name + ')' : ''}`,
        );
      }
      return {
        transactions: allTxs,
        confidence: classification.confidence,
        funderType: classification.type,
        funderLabel: classification.name,
        firstPageFull,
      };
    }

    // Tier 2: stablecoin fallback (only if tier 1 returned nothing)
    const stables = STABLE_CONTRACTS[this.chain] ?? [];
    if (stables.length === 0) return null;

    const stableTxs: RawTransaction[] = [];
    let stableFirstTransfer: AlchemyTransfer | null = null;
    let stableFirstPageFull = false;
    let stablePageKey: string | undefined;
    let stableFoundEoa = false;

    for (let page = 0; page < MAX_PAGES; page++) {
      const callParams: Record<string, unknown> = {
        toAddress: addr,
        fromBlock: '0x0',
        toBlock: 'latest',
        category: ['erc20'],
        contractAddresses: stables,
        order: 'asc',
        maxCount: '0xa',
        withMetadata: true,
        excludeZeroValue: true,
      };
      if (stablePageKey !== undefined) callParams['pageKey'] = stablePageKey;

      const { transfers: raw, pageKey: nextKey } = await alchemyCall(this.url, callParams);

      if (raw.length === 0) break;

      if (page === 0) {
        stableFirstTransfer = raw[0] ?? null;
        stableFirstPageFull = raw.length >= 10;
      }

      for (const t of raw) {
        const tx = normalise(t, addr, this.chain);
        if (tx) stableTxs.push(tx);
        if (!stableFoundEoa && classifyFunder(t.from).type === 'eoa') {
          stableFoundEoa = true;
        }
      }

      if (stableFoundEoa || !nextKey) break;
      stablePageKey = nextKey;
    }

    if (stableTxs.length === 0 || stableFirstTransfer === null) return null;

    const stableClass = classifyFunder(stableFirstTransfer.from);
    // Stablecoin tier is inherently one step less certain than native ETH,
    // so cap confidence at 0.7 even for EOAs
    const stableConfidence = Math.min(stableClass.confidence, 0.7);
    if (env.LOG_LEVEL === 'debug') {
      console.debug(
        `[alchemyFetcher] first stable funder: ${stableFirstTransfer.from} type=${stableClass.type} confidence=${stableConfidence}`,
      );
    }

    return {
      transactions: stableTxs,
      confidence: stableConfidence,
      funderType: stableClass.type,
      funderLabel: stableClass.name,
      firstPageFull: stableFirstPageFull,
    };
  }

  // ---------------------------------------------------------------------------
  // Recent outbound (desc, limit 50 per page, paginate up to MAX_PAGES)
  // ---------------------------------------------------------------------------

  private async fetchRecentOutbound(addr: string): Promise<RawTransaction[]> {
    const MAX_PAGES = 3;
    const allTxs: RawTransaction[] = [];
    let pageKey: string | undefined;

    for (let page = 0; page < MAX_PAGES; page++) {
      const callParams: Record<string, unknown> = {
        fromAddress: addr,
        fromBlock: '0x0',
        toBlock: 'latest',
        category: ['external', 'erc20'],
        order: 'desc',
        maxCount: '0x32', // 50
        withMetadata: false,
        excludeZeroValue: true,
      };
      if (pageKey !== undefined) callParams['pageKey'] = pageKey;

      const { transfers: raw, pageKey: nextKey } = await alchemyCall(this.url, callParams);

      for (const t of raw) {
        const tx = normalise(t, addr, this.chain);
        if (tx) allTxs.push(tx);
      }

      // Stop if no more pages or this page was under the cap (not truncated)
      if (!nextKey || raw.length < 50) break;
      pageKey = nextKey;
    }

    return allTxs;
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
