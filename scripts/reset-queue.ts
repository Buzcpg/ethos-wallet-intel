import 'dotenv/config';
import { db as getDb } from '../src/db/client.js';
import { walletScanJobs, wallets } from '../src/db/schema/index.js';
import { eq, sql } from 'drizzle-orm';

const CHAIN = 'base';
const BATCH_SIZE = 500;

async function main() {
  const db = getDb();
  console.log('[queue] Truncating wallet_scan_jobs...');
  await db.execute(sql`TRUNCATE TABLE wallet_scan_jobs`);

  console.log('[queue] Loading primary wallets...');
  const rows = await db.select({ id: wallets.id }).from(wallets).where(eq(wallets.isPrimary, true));
  console.log(`[queue] ${rows.length} primary wallets — enqueuing on ${CHAIN}...`);

  let inserted = 0;
  for (let i = 0; i < rows.length; i += BATCH_SIZE) {
    const batch = rows.slice(i, i + BATCH_SIZE);
    await db.insert(walletScanJobs).values(batch.map(w => ({
      walletId: w.id, chain: CHAIN, jobType: 'new_user', status: 'pending' as const,
    })));
    inserted += batch.length;
    if (inserted % 5000 === 0 || inserted === rows.length) console.log(`[queue] ${inserted}/${rows.length}`);
  }
  console.log(`[queue] Done — ${inserted} jobs on ${CHAIN}`);
  process.exit(0);
}
main().catch(e => { console.error(e); process.exit(1); });
