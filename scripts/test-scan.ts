/**
 * Isolated E2E test: fetch transactions for a known wallet, verify signal detection.
 * Run with: npx tsx scripts/test-scan.ts
 */
import { WalletTransactionFetcher } from '../src/chains/transactionFetcher.js';
import type { ChainSlug } from '../src/chains/index.js';

const TEST_ADDRESS = '0xd8da6bf26964af9d7eed9e03e53415d37aa96045'; // Vitalik — known busy wallet
const TEST_CHAIN: ChainSlug = 'ethereum';

async function main() {
  console.log(`\n▶ Fetching transactions: ${TEST_ADDRESS} on ${TEST_CHAIN}\n`);

  const fetcher = new WalletTransactionFetcher(TEST_CHAIN);

  const result = await fetcher.fetchAll(TEST_ADDRESS);

  console.log(`✅ Fetch complete`);
  console.log(`   totalFetched : ${result.totalFetched}`);
  console.log(`   partial      : ${result.partial}`);
  console.log(`   tx count     : ${result.transactions.length}`);

  const inboundNative = result.transactions
    .filter(t => t.isInbound && !t.tokenContractAddress && t.valueWei !== '0' && t.fromAddress !== TEST_ADDRESS.toLowerCase())
    .sort((a, b) => (a.blockNumber < b.blockNumber ? -1 : 1));

  console.log(`   inbound native txs: ${inboundNative.length}`);

  if (inboundNative.length > 0) {
    const first = inboundNative[0];
    console.log(`\n🎯 First funder would be:`);
    console.log(`   from    : ${first.fromAddress}`);
    console.log(`   block   : ${first.blockNumber}`);
    console.log(`   value   : ${first.valueWei} wei`);
    console.log(`   txHash  : ${first.txHash}`);
  } else {
    console.log(`\n⚠️  No inbound native txs found in window`);
    console.log(`   Sample of fetched txs:`);
    result.transactions.slice(0, 3).forEach(t =>
      console.log(`     isInbound=${t.isInbound} value=${t.valueWei} tokenContract=${t.tokenContractAddress ?? 'none'} from=${t.fromAddress}`)
    );
  }
}

main().catch(err => { console.error('FAILED:', err); process.exit(1); });
