/**
 * alchemy-probe.ts — first-funder lookup with funder classification
 * Classify, never skip. Every first funder stored with type + confidence.
 *
 * Usage: npx tsx scripts/alchemy-probe.ts [address] [chain]
 */

const API_KEY = process.env.ALCHEMY_API_KEY ?? 'OpKOcolYDmoHQOIDYVKqt';

const ENDPOINTS: Record<string, string> = {
  ethereum: `https://eth-mainnet.g.alchemy.com/v2/${API_KEY}`,
  base:     `https://base-mainnet.g.alchemy.com/v2/${API_KEY}`,
  arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${API_KEY}`,
  optimism: `https://opt-mainnet.g.alchemy.com/v2/${API_KEY}`,
  polygon:  `https://polygon-mainnet.g.alchemy.com/v2/${API_KEY}`,
};

// Must mirror src/chains/alchemyFetcher.ts FUNDER_LABELS exactly
const FUNDER_LABELS: Record<string, { type: string; name: string; confidence: number }> = {
  '0x80c67432656d59144ceff962e8faf8926599bcf8': { type: 'bridge', name: 'Orbiter Finance relay',    confidence: 0.7 },
  '0x99c9fc46f92e8a1c0dec1b1747d010903e884be1': { type: 'bridge', name: 'Optimism gateway',         confidence: 0.7 },
  '0x49048044d57e1c92a77f79988d21fa8faf74e97e': { type: 'bridge', name: 'Base bridge (L1Standard)', confidence: 0.7 },
  '0x3154cf16ccdb4c6d922629664174b904d80f2c35': { type: 'bridge', name: 'Base bridge (L1ERC20)',    confidence: 0.7 },
  '0x4200000000000000000000000000000000000010': { type: 'bridge', name: 'Optimism L2 bridge',        confidence: 0.7 },
  '0x4dbd4fc535ac27206064b68ffcf827b0a60bab3f': { type: 'bridge', name: 'Arbitrum inbox',            confidence: 0.7 },
  '0x8484ef722627bf18ca5ae6bcf031c23e6e922b30': { type: 'bridge', name: 'Across protocol',           confidence: 0.7 },
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': { type: 'dex',    name: 'Uniswap Universal Router',  confidence: 0.5 },
  '0x2626664c2603336e57b271c5c0b26f421741e481': { type: 'dex',    name: 'Uniswap V3 Router (Base)',   confidence: 0.5 },
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': { type: 'dex',    name: 'Kyberswap',                  confidence: 0.5 },
  '0x1111111254eeb25477b68fb85ed929f73a960582': { type: 'dex',    name: '1inch v5',                    confidence: 0.5 },
  '0x28c6c06298d514db089934071355e5743bf21d60': { type: 'cex',    name: 'Binance hot wallet',           confidence: 0.8 },
  '0x21a31ee1afc51d94c2efccaa2092ad1028285549': { type: 'cex',    name: 'Binance cold wallet',          confidence: 0.8 },
  '0xa9d1e08c7793af67e9d92fe308d5697fb81d3e43': { type: 'cex',    name: 'Coinbase',                     confidence: 0.8 },
  '0x71660c4005ba85c37ccec55d0c4493e66fe775d3': { type: 'cex',    name: 'Coinbase 2',                   confidence: 0.8 },
};

function classify(addr: string) {
  return FUNDER_LABELS[addr.toLowerCase()] ?? { type: 'eoa', name: '', confidence: 1.0 };
}

const STABLE_CONTRACTS: Record<string, string[]> = {
  ethereum: ['0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48','0xdac17f958d2ee523a2206206994597c13d831ec7','0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2'],
  base:     ['0x833589fcd6edb6e08f4c7c32d4f71b54bda02913','0xfde4c96c8593536e31f229ea8f37b2ada2699bb2','0x4200000000000000000000000000000000000006'],
  arbitrum: ['0xaf88d065e77c8cc2239327c5edb3a432268e5831','0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9','0x82af49447d8a07e3bd95bd0d56f35241523fbab1'],
  optimism: ['0x0b2c639c533813f4aa9d7837caf62653d097ff85','0x94b008aa00579c1307b0ef2c499ad98a8ce58e58','0x4200000000000000000000000000000000000006'],
  polygon:  ['0x3c499c542cef5e3811e1192ce70d8cc03d5c3359','0xc2132d05d31c914a87c6611c10748aeb04b58e8f','0x7ceb23fd6bc0add59e62ac25578270cff1b9f619'],
};

interface Transfer {
  hash: string; from: string; to: string | null;
  value: number | null; asset: string | null; blockNum: string;
  metadata?: { blockTimestamp?: string };
}

const wallet = process.argv[2] ?? '0x5f2da3eee5d389ab1ea7d871d4196905903e37c0';
const chain  = process.argv[3] ?? 'base';
const url    = ENDPOINTS[chain];
if (!url) { console.error(`Unknown chain: ${chain}`); process.exit(1); }

const nativeCats = ['ethereum','polygon'].includes(chain) ? ['external','internal'] : ['external'];
let calls = 0;

async function alchemyCall(params: Record<string, unknown>): Promise<Transfer[]> {
  calls++;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: calls, jsonrpc: '2.0', method: 'alchemy_getAssetTransfers', params: [params] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const d = await res.json() as { result?: { transfers: Transfer[] }; error?: { message: string } };
  if (d.error) throw new Error(d.error.message);
  return d.result?.transfers ?? [];
}

async function main() {
  console.log(`\n── First-funder probe: ${wallet} on ${chain} ──\n`);

  // Tier 1: first native ETH inbound
  console.log('Tier 1: native ETH (asc, limit 10)');
  const native = await alchemyCall({
    toAddress: wallet, fromBlock: '0x0', toBlock: 'latest',
    category: nativeCats, order: 'asc', maxCount: '0xa',
    withMetadata: true, excludeZeroValue: true,
  });

  let firstFunder: Transfer | null = null;
  let funderTier = 0;

  if (native.length > 0) {
    firstFunder = native[0];
    funderTier = 1;
    const cls = classify(firstFunder.from);
    const icon = cls.type === 'eoa' ? '✅' : cls.type === 'bridge' ? '🌉' : cls.type === 'cex' ? '🏦' : '🔄';
    const ts = firstFunder.metadata?.blockTimestamp?.slice(0,10) ?? '';
    console.log(`  ${icon} first funder : ${firstFunder.from}`);
    console.log(`     type        : ${cls.type}${cls.name ? ' — ' + cls.name : ''}`);
    console.log(`     confidence  : ${cls.confidence}`);
    console.log(`     tx          : ${firstFunder.hash}`);
    console.log(`     value       : ${firstFunder.value} ${firstFunder.asset ?? 'ETH'}  (${ts})`);
  } else {
    console.log('  no native ETH inbound → trying stablecoin fallback');

    // Tier 2: stablecoin fallback
    const stables = STABLE_CONTRACTS[chain] ?? [];
    if (stables.length > 0) {
      console.log('\nTier 2: USDC/USDT/WETH (asc, limit 10)');
      const stable = await alchemyCall({
        toAddress: wallet, fromBlock: '0x0', toBlock: 'latest',
        category: ['erc20'], contractAddresses: stables,
        order: 'asc', maxCount: '0xa',
        withMetadata: true, excludeZeroValue: true,
      });
      if (stable.length > 0) {
        firstFunder = stable[0];
        funderTier = 2;
        const cls = classify(firstFunder.from);
        const conf = Math.min(cls.confidence, 0.7); // stablecoin tier capped
        console.log(`  first funder : ${firstFunder.from}`);
        console.log(`  type         : ${cls.type}${cls.name ? ' — ' + cls.name : ''}`);
        console.log(`  confidence   : ${conf} (stablecoin tier, capped at 0.7)`);
      } else {
        console.log('  no stablecoin funder found either');
      }
    }
  }

  // Outbound
  console.log('\nOutbound (desc, limit 50)');
  const outbound = await alchemyCall({
    fromAddress: wallet, fromBlock: '0x0', toBlock: 'latest',
    category: ['external','erc20'], order: 'desc', maxCount: '0x32',
    withMetadata: false, excludeZeroValue: true,
  });
  const recipients = [...new Set(outbound.map(t => t.to?.toLowerCase()).filter(Boolean))];
  console.log(`  outbound: ${outbound.length}  unique recipients: ${recipients.length}`);
  outbound.slice(0,3).forEach(t => console.log(`    → ${t.to}  ${t.value ?? ''} ${t.asset ?? 'ETH'}`));

  console.log(`\nCalls made: ${calls}  (~${calls * 150} CU)`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
