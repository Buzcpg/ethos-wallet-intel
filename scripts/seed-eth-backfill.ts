/**
 * seed-eth-backfill.ts — seeds the full ETH backfill queue with Discord progress every 1000
 */
import 'dotenv/config';
import { db as getDb } from '../src/db/client.js';
import { wallets, walletScanJobs } from '../src/db/schema/index.js';
import { isNull, eq, and, inArray, sql } from 'drizzle-orm';

const CHAIN = 'ethereum';
const BATCH_SIZE = 500;
const DISCORD_NOTIFY_EVERY = 1000;
const DISCORD_TOKEN = process.env.DISCORD_BOT_TOKEN;
const DISCORD_CHANNEL_ID = '1482049214824452277';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');

async function postDiscord(message: string) {
  if (!DISCORD_TOKEN) { console.log(`[discord-skip] ${message}`); return; }
  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${DISCORD_CHANNEL_ID}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bot ${DISCORD_TOKEN}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: message }),
    });
    if (!res.ok) console.warn(`[discord] failed: ${res.status} ${await res.text()}`);
  } catch (err) { console.warn(`[discord] error:`, err); }
}

async function main() {
  const db = getDb();
  console.log(`\n[seed-eth-backfill] chain=${CHAIN} dry-run=${DRY_RUN}`);

  const [{ total }] = await db
    .select({ total: sql<number>`count(*)`.mapWith(Number) })
    .from(wallets)
    .where(and(eq(wallets.chain, CHAIN), isNull(wallets.lastScannedAt)));

  console.log(`[seed-eth-backfill] unscanned wallets: ${total}`);

  if (total === 0) {
    await postDiscord(`✅ ETH backfill seed complete — nothing to do (all wallets already scanned)`);
    process.exit(0);
  }
  if (DRY_RUN) {
    console.log(`[seed-eth-backfill] dry-run — would enqueue ${total} wallets.`);
    process.exit(0);
  }

  await postDiscord(`🌱 **ETH backfill seeding started**\n\`${total.toLocaleString()}\` unscanned Ethereum wallets — updates every 1,000`);

  let enqueued = 0, skipped = 0, offset = 0, lastNotifyAt = 0;

  while (enqueued + skipped < total) {
    const batchLimit = Math.min(BATCH_SIZE, total - enqueued - skipped);
    const rows = await db
      .select({ id: wallets.id })
      .from(wallets)
      .where(and(eq(wallets.chain, CHAIN), isNull(wallets.lastScannedAt)))
      .limit(batchLimit)
      .offset(offset);

    if (rows.length === 0) break;
    const walletIds = rows.map(r => r.id);

    const existingJobs = await db
      .select({ walletId: walletScanJobs.walletId })
      .from(walletScanJobs)
      .where(and(inArray(walletScanJobs.walletId, walletIds), inArray(walletScanJobs.status, ['pending', 'running'])));

    const alreadyQueued = new Set(existingJobs.map(j => j.walletId));
    const toEnqueue = walletIds.filter(id => !alreadyQueued.has(id));

    if (toEnqueue.length > 0) {
      await db.insert(walletScanJobs).values(
        toEnqueue.map(walletId => ({ walletId, chain: CHAIN, jobType: 'backfill', status: 'pending' as const }))
      );
      enqueued += toEnqueue.length;
    }
    skipped += alreadyQueued.size;
    offset += rows.length;

    const pct = Math.round(((enqueued + skipped) / total) * 100);
    process.stdout.write(`\r[seed-eth-backfill] ${enqueued.toLocaleString()} enqueued, ${skipped} skipped (${pct}%)`);

    const notifyThreshold = Math.floor(enqueued / DISCORD_NOTIFY_EVERY) * DISCORD_NOTIFY_EVERY;
    if (notifyThreshold >= DISCORD_NOTIFY_EVERY && notifyThreshold > lastNotifyAt) {
      lastNotifyAt = notifyThreshold;
      const filled = Math.floor(pct / 5);
      const bar = '█'.repeat(filled) + '░'.repeat(20 - filled);
      await postDiscord(`📦 **Seeding progress** | \`${enqueued.toLocaleString()}\` / \`${total.toLocaleString()}\` enqueued\n\`${bar}\` ${pct}%`);
    }
  }

  console.log(`\n[seed-eth-backfill] done — ${enqueued.toLocaleString()} enqueued, ${skipped} skipped`);
  await postDiscord(`✅ **ETH backfill seeding complete**\n\`${enqueued.toLocaleString()}\` jobs enqueued | \`${skipped}\` skipped\n\n🔫 Queue is hot — start the worker to begin processing.`);
}

main().catch(err => {
  console.error('[seed-eth-backfill] fatal:', err);
  postDiscord(`❌ **ETH backfill seed FAILED**\n\`\`\`${err.message}\`\`\``).finally(() => process.exit(1));
});
