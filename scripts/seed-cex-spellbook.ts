import 'dotenv/config';
import { getPool } from '../src/db/client.js';
import { CEX_SPELLBOOK_LABELS } from '../src/labels/cexSpellbook.js';

const CHAIN = 'ethereum';
const LABEL_KIND = 'exchange_hot_wallet';
const SOURCE = 'cex_spellbook';
const BATCH_SIZE = 500;
const CONCURRENCY = 4;

async function main() {
  const pool = getPool();
  const entries = [...CEX_SPELLBOOK_LABELS.entries()];
  console.log(`[seed-cex-spellbook] ${entries.length.toLocaleString()} addresses → address_labels`);

  const batches: Array<typeof entries> = [];
  for (let i = 0; i < entries.length; i += BATCH_SIZE) batches.push(entries.slice(i, i + BATCH_SIZE));

  let inserted = 0, skipped = 0, batchIdx = 0;

  async function worker() {
    while (batchIdx < batches.length) {
      const myIdx = batchIdx++;
      const batch = batches[myIdx];
      // 5 params per row: chain, address, label_value, label_kind, source
      const values = batch.map((_, i) => `($${i*5+1},$${i*5+2},$${i*5+3},$${i*5+4},$${i*5+5})`).join(',');
      const params: string[] = [];
      for (const [address, label] of batch) params.push(CHAIN, address.toLowerCase(), label, LABEL_KIND, SOURCE);
      const sql = `INSERT INTO address_labels (chain,address,label_value,label_kind,source) VALUES ${values} ON CONFLICT (chain,address) DO NOTHING`;
      const client = await pool.connect();
      try {
        const result = await client.query(sql, params);
        inserted += result.rowCount ?? 0;
        skipped += batch.length - (result.rowCount ?? 0);
      } finally { client.release(); }
      const pct = Math.round(((myIdx + 1) / batches.length) * 100);
      process.stdout.write(`\r  ${myIdx+1}/${batches.length} batches (${pct}%) — ${inserted.toLocaleString()} inserted, ${skipped} skipped  `);
    }
  }

  await Promise.all(Array.from({ length: Math.min(CONCURRENCY, batches.length) }, () => worker()));
  console.log(`\n[seed-cex-spellbook] ✅ done — ${inserted.toLocaleString()} inserted, ${skipped} skipped`);
  await pool.end();
}

main().catch(err => { console.error('[seed-cex-spellbook] fatal:', err); process.exit(1); });
