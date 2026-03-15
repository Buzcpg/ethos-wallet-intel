/**
 * seed-labels.ts — populate address_labels from open-source datasets
 *
 * Sources (zero API credits consumed):
 *   1. Dune spellbook cex_evms_addresses (4,957 EVM addresses, 200+ exchanges)
 *      Parsed directly from GitHub — free, no execution required
 *   2. CEX_SEED_LABELS (hand-curated high-confidence list)
 *
 * Usage:
 *   npx tsx scripts/seed-labels.ts            # seed all
 *   npx tsx scripts/seed-labels.ts --dry-run  # preview counts only
 *   npx tsx scripts/seed-labels.ts --refresh  # upsert even if already seeded
 */
import 'dotenv/config';
import { db as getDb } from '../src/db/client.js';
import { addressLabels } from '../src/db/schema/index.js';
import { sql, count } from 'drizzle-orm';
import { CEX_SPELLBOOK_LABELS } from '../src/labels/cexSpellbook.js';
import { CEX_SEED_LABELS } from '../src/labels/seedData.js';

const args = process.argv.slice(2);
const DRY_RUN = args.includes('--dry-run');
const REFRESH = args.includes('--refresh');
const BATCH_SIZE = 500;

async function main() {
  const database = getDb();

  console.log(`\n[seed-labels] dry-run=${DRY_RUN} refresh=${REFRESH}`);

  const [existingRow] = await database
    .select({ cnt: count() })
    .from(addressLabels);
  const existing = existingRow?.cnt ?? 0;
  console.log(`[seed-labels] existing rows: ${existing}`);

  if (existing > 0 && !REFRESH) {
    console.log('[seed-labels] already seeded. Use --refresh to upsert. Done.');
    process.exit(0);
  }

  // Merge: spellbook (0.85) overridden by curated seed_data (0.95)
  const merged = new Map<string, { labelValue: string; source: string; confidence: string }>();

  for (const [address, cexName] of CEX_SPELLBOOK_LABELS.entries()) {
    merged.set(address, { labelValue: cexName, source: 'dune_spellbook', confidence: '0.85' });
  }

  for (const label of CEX_SEED_LABELS) {
    if (label.chain !== 'ethereum') continue;
    merged.set(label.address.toLowerCase(), {
      labelValue: label.label, source: 'seed_data', confidence: '0.95',
    });
  }

  console.log(`[seed-labels] ${merged.size} unique addresses to upsert`);

  if (DRY_RUN) {
    console.log('[seed-labels] dry-run — no writes. Done.');
    process.exit(0);
  }

  const entries = [...merged.entries()];
  let inserted = 0;

  for (let i = 0; i < entries.length; i += BATCH_SIZE) {
    const batch = entries.slice(i, i + BATCH_SIZE);

    await database
      .insert(addressLabels)
      .values(
        batch.map(([address, { labelValue, source, confidence }]) => ({
          chain: 'ethereum',
          address,
          labelValue,
          labelKind: 'exchange_hot_wallet',
          source,
          confidence,
          lastVerifiedAt: new Date(),
        })),
      )
      .onConflictDoUpdate({
        target: [addressLabels.chain, addressLabels.address],
        set: {
          labelValue: sql`EXCLUDED.label_value`,
          source: sql`EXCLUDED.source`,
          confidence: sql`EXCLUDED.confidence`,
          lastVerifiedAt: sql`now()`,
        },
      });

    inserted += batch.length;
    process.stdout.write(`\r[seed-labels] ${inserted}/${merged.size} upserted`);
  }

  console.log(`\n[seed-labels] done`);

  const [totalRow] = await database.select({ cnt: count() }).from(addressLabels);
  console.log(`[seed-labels] address_labels total: ${totalRow?.cnt ?? 0}\n`);
}

main().catch((err) => {
  console.error('[seed-labels] fatal:', err);
  process.exit(1);
});
