/**
 * alchemy-probe.ts — tiered first-funder lookup
 *
 * Tier 1: native ETH inbound, EOA sender only  (1 call)
 * Tier 2: if no EOA ETH funder → USDC/USDT/WETH by contract address (1 call)
 * Tier 3: recent outbound for deposit detection (1 call)
 *
 * Total: 2-3 calls per wallet×chain. ~300-450 CU.
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

// Known contracts — if first funder is one of these, lower confidence
const KNOWN_CONTRACTS: Record<string, string> = {
  // Bridges
  '0x80c67432656d59144ceff962e8faf8926599bcf8': 'Orbiter Finance relay',
  '0x99c9fc46f92e8a1c0dec1b1747d010903e884be1': 'Optimism bridge',
  '0x49048044d57e1c92a77f79988d21fa8faf74e97e': 'Base bridge (L1Standard)',
  '0x3154cf16ccdb4c6d922629664174b904d80f2c35': 'Base bridge (L1ERC20)',
  // DEX routers
  '0x3fc91a3afd70395cd496c647d5a6cc9d4b2b7fad': 'Uniswap Universal Router',
  '0x2626664c2603336e57b271c5c0b26f421741e481': 'Uniswap V3 Router (Base)',
  '0x6131b5fae19ea4f9d964eac0408e4408b66337b5': 'Kyberswap',
};

// Major stablecoins/WETH by chain for tier-2 fallback
const STABLE_CONTRACTS: Record<string, string[]> = {
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

interface Transfer {
  hash: string; from: string; to: string | null;
  value: number | null; asset: string | null;
  blockNum: string; rawContract?: { address?: string };
  metadata?: { blockTimestamp?: string };
}

const wallet = process.argv[2] ?? '0x9a58c041255ca395a9cba41ab541e6dc8f3518bb';
const chain  = process.argv[3] ?? 'base';
const url    = ENDPOINTS[chain];
if (!url) { console.error(`Unknown chain: ${chain}`); process.exit(1); }

// ETH chains support 'internal'; L2s do not
const nativeCategories = ['ethereum','polygon'].includes(chain)
  ? ['external','internal'] : ['external'];

let totalCalls = 0;

async function alchemyCall(params: Record<string, unknown>): Promise<Transfer[]> {
  totalCalls++;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: totalCalls, jsonrpc: '2.0', method: 'alchemy_getAssetTransfers', params: [params] }),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const d = await res.json() as { result?: { transfers: Transfer[] }; error?: { message: string } };
  if (d.error) throw new Error(d.error.message);
  return d.result?.transfers ?? [];
}

// Check if address is a known contract (from label DB or known list)
function classifyAddress(addr: string): { isKnownContract: boolean; label: string } {
  const lower = addr.toLowerCase();
  const label = KNOWN_CONTRACTS[lower];
  return { isKnownContract: !!label, label: label ?? '' };
}

async function main() {
  console.log(`\n── First-funder probe: ${wallet} on ${chain} ──\n`);

  // ── Tier 1: native ETH, EOA sender ────────────────────────────────────────
  console.log(`Tier 1: native ETH inbound (${nativeCategories.join('+')}, asc, limit 10)`);
  const nativeTxs = await alchemyCall({
    toAddress: wallet, fromBlock: '0x0', toBlock: 'latest',
    category: nativeCategories,
    order: 'asc', maxCount: '0xa',
    withMetadata: true, excludeZeroValue: true,
  });

  let firstFunder: Transfer | null = null;
  let funderLabel = '';
  let tier = 0;

  for (const tx of nativeTxs) {
    const { isKnownContract, label } = classifyAddress(tx.from);
    if (!isKnownContract) {
      firstFunder = tx; funderLabel = ''; tier = 1;
      break;
    } else {
      // Contract funder — note but keep looking
      console.log(`  skip: ${tx.from} (${label})`);
    }
  }

  // If only contract funders found, use the best one with low confidence
  if (!firstFunder && nativeTxs.length > 0) {
    firstFunder = nativeTxs[0];
    const { label } = classifyAddress(firstFunder.from);
    funderLabel = label;
    tier = 1;
    console.log(`  (only contract funders found — using first with low confidence)`);
  }

  if (firstFunder) {
    const ts = firstFunder.metadata?.blockTimestamp?.slice(0,10) ?? '';
    const conf = funderLabel ? '⚠️  LOW (contract)' : '✅ HIGH (EOA)';
    console.log(`  result:    ${conf}`);
    console.log(`  funder:    ${firstFunder.from}${funderLabel ? ` [${funderLabel}]` : ''}`);
    console.log(`  tx:        ${firstFunder.hash}`);
    console.log(`  value:     ${firstFunder.value} ${firstFunder.asset ?? 'ETH'}  (${ts})`);
  } else {
    console.log(`  no native ETH transfers found → falling back to tier 2`);
  }

  // ── Tier 2: stablecoin fallback if no native ETH funder ──────────────────
  const stables = STABLE_CONTRACTS[chain] ?? [];
  if (!firstFunder && stables.length > 0) {
    console.log(`\nTier 2: USDC/USDT/WETH inbound (asc, limit 10)`);
    const stableTxs = await alchemyCall({
      toAddress: wallet, fromBlock: '0x0', toBlock: 'latest',
      category: ['erc20'],
      contractAddresses: stables,
      order: 'asc', maxCount: '0xa',
      withMetadata: true, excludeZeroValue: true,
    });

    for (const tx of stableTxs) {
      const { isKnownContract, label } = classifyAddress(tx.from);
      if (!isKnownContract) {
        firstFunder = tx; funderLabel = ''; tier = 2;
        console.log(`  funder:    ${tx.from}  (${tx.value} ${tx.asset})`);
        break;
      } else {
        console.log(`  skip: ${tx.from} (${label})`);
      }
    }
    if (!firstFunder) console.log(`  no stablecoin EOA funder found either`);
  }

  // ── Tier 3: recent outbound for deposit detection ─────────────────────────
  console.log(`\nTier 3: recent outbound (desc, limit 50)`);
  const outbound = await alchemyCall({
    fromAddress: wallet, fromBlock: '0x0', toBlock: 'latest',
    category: ['external','erc20'],
    order: 'desc', maxCount: '0x32',
    withMetadata: false, excludeZeroValue: true,
  });
  const recipients = [...new Set(outbound.map(t => t.to?.toLowerCase()).filter(Boolean))];
  console.log(`  outbound txs:      ${outbound.length}`);
  console.log(`  unique recipients: ${recipients.length}`);
  outbound.slice(0, 5).forEach(t =>
    console.log(`    → ${t.to}  ${t.value ?? ''} ${t.asset ?? 'ETH'}`)
  );

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log(`\n── Summary ──`);
  if (firstFunder) {
    console.log(`  first funder (tier ${tier}): ${firstFunder.from}`);
    if (funderLabel) console.log(`  label: ${funderLabel}  confidence: LOW`);
    else console.log(`  confidence: HIGH — EOA, not a known contract`);
  } else {
    console.log(`  no first funder found`);
  }
  console.log(`  API calls made: ${totalCalls}  (~${totalCalls * 150} CU)`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
