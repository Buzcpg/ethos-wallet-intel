import { WalletTransactionFetcher } from '../src/chains/transactionFetcher.js';

async function main() {
  const f = new WalletTransactionFetcher('ethereum');
  const r = await f.fetchAll('0x9a58c041255ca395a9cba41ab541e6dc8f3518bb');
  console.log('txs:', r.totalFetched, 'partial:', r.partial);
}

main().catch(err => { console.error(err); process.exit(1); });
