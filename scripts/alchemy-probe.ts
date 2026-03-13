/**
 * alchemy-probe.ts — minimal 2-call wallet lookup
 * CU cost: 150 (first-funder) + 150 (recent outbound) = ~300 CU total
 * Usage: npx tsx scripts/alchemy-probe.ts [address] [chain]
 */

const API_KEY = 'OpKOcolYDmoHQOIDYVKqt';

const CHAIN_URLS: Record<string, string> = {
  ethereum: `https://eth-mainnet.g.alchemy.com/v2/${API_KEY}`,
  base:     `https://base-mainnet.g.alchemy.com/v2/${API_KEY}`,
  arbitrum: `https://arb-mainnet.g.alchemy.com/v2/${API_KEY}`,
  optimism: `https://opt-mainnet.g.alchemy.com/v2/${API_KEY}`,
  polygon:  `https://polygon-mainnet.g.alchemy.com/v2/${API_KEY}`,
};

const wallet = process.argv[2] ?? '0x937ec42ddfec2059bb64d613f99547a62cda6c01'; // serpinxbt primary
const chain  = process.argv[3] ?? 'ethereum';
const url    = CHAIN_URLS[chain];
if (!url) { console.error(`Unknown chain: ${chain}`); process.exit(1); }

interface AlchemyTransfer {
  hash: string; from: string; to: string | null;
  value: number | null; asset: string | null; blockNum: string; category: string;
  metadata?: { blockTimestamp?: string };
}

async function transfers(params: Record<string, unknown>) {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: 1, jsonrpc: '2.0', method: 'alchemy_getAssetTransfers', params: [params] }),
  });
  const cu = res.headers.get('x-alchemy-units-consumed') ?? res.headers.get('alchemy-units-used') ?? '?';
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  const d = await res.json() as { result?: { transfers: AlchemyTransfer[] }; error?: { message: string } };
  if (d.error) throw new Error(d.error.message);
  return { txs: d.result?.transfers ?? [], cu };
}

async function main() {
  console.log(`\n── Alchemy probe: ${wallet} on ${chain} ──\n`);

  // Call 1: first inbound transfer (oldest first = first funder)
  console.log('Call 1: first inbound (asc, limit 5)');
  const { txs: inbound, cu: cu1 } = await transfers({
    toAddress: wallet, fromBlock: '0x0', toBlock: 'latest',
    category: ['ethereum','polygon'].includes(chain) ? ['external','internal','erc20'] : ['external','erc20'],
    order: 'asc', maxCount: '0x5',
    withMetadata: true, excludeZeroValue: true,
  });

  if (inbound.length > 0) {
    const f = inbound[0];
    console.log(`  first funder : ${f.from}`);
    console.log(`  tx           : ${f.hash}`);
    console.log(`  value/asset  : ${f.value} ${f.asset ?? 'ETH'}`);
    console.log(`  block        : ${parseInt(f.blockNum, 16)}  ${f.metadata?.blockTimestamp ?? ''}`);
  } else {
    console.log('  (no inbound transfers found)');
  }
  console.log(`  CU: ${cu1}\n`);

  // Call 2: recent outbound (for deposit address detection)
  console.log('Call 2: recent outbound (desc, limit 50)');
  const { txs: outbound, cu: cu2 } = await transfers({
    fromAddress: wallet, fromBlock: '0x0', toBlock: 'latest',
    category: ['external', 'erc20'],
    order: 'desc', maxCount: '0x32',
    withMetadata: false, excludeZeroValue: true,
  });

  const recipients = [...new Set(outbound.map(t => t.to?.toLowerCase()).filter(Boolean))];
  console.log(`  outbound txs     : ${outbound.length}`);
  console.log(`  unique recipients: ${recipients.length}`);
  outbound.slice(0, 5).forEach(t => console.log(`    → ${t.to}  ${t.value} ${t.asset ?? 'ETH'}`));
  console.log(`  CU: ${cu2}\n`);

  const cuTotal = [cu1, cu2].filter(x => x !== '?').map(Number).reduce((a, b) => a + b, 0);
  console.log(`Total CU this run  : ${cuTotal || '~300'}`);
  console.log(`Projected full scan: 40k × 5 chains × 2 calls × ~150 CU = ~60M CU (free tier: 300M/mo)`);
}

main().catch(err => { console.error('Error:', err.message); process.exit(1); });
