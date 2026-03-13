import 'dotenv/config';
import { SupabaseSync } from '../src/sync/supabaseSync.js';
import type { SupabaseProfileRow } from '../src/sync/supabaseSync.js';

const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_ANON_KEY = process.env.SUPABASE_ANON_KEY;

if (!SUPABASE_URL || !SUPABASE_ANON_KEY) {
  console.error('[sync] Missing SUPABASE_URL or SUPABASE_ANON_KEY in .env');
  process.exit(1);
}

const BATCH_SIZE = 1000;
const LOG_EVERY = 5000;

async function fetchBatch(offset: number): Promise<SupabaseProfileRow[]> {
  const url = `${SUPABASE_URL}/rest/v1/profiles_v2?select=raw_profile_id,display_name,username,status,score,primary_address&offset=${offset}&limit=${BATCH_SIZE}`;
  const res = await fetch(url, {
    headers: {
      apikey: SUPABASE_ANON_KEY!,
      Authorization: `Bearer ${SUPABASE_ANON_KEY}`,
      'Content-Type': 'application/json',
      Prefer: 'count=none',
    },
  });
  if (!res.ok) {
    throw new Error(`Supabase fetch failed: ${res.status} ${await res.text()}`);
  }
  return res.json() as Promise<SupabaseProfileRow[]>;
}

async function main() {
  const sync = new SupabaseSync();
  let offset = 0;
  let totalSynced = 0;
  let lastLogAt = 0;

  console.log('[sync] starting full profile sync...');

  while (true) {
    const batch = await fetchBatch(offset);
    if (batch.length === 0) break;

    await sync.ingestBatch(batch);
    totalSynced += batch.length;
    offset += batch.length;

    if (totalSynced - lastLogAt >= LOG_EVERY) {
      console.log(`[sync] ${totalSynced} profiles synced so far...`);
      lastLogAt = Math.floor(totalSynced / LOG_EVERY) * LOG_EVERY;
    }

    if (batch.length < BATCH_SIZE) break; // last page
  }

  console.log(`[sync] done — ${totalSynced} profiles synced`);
}

main().catch((err) => {
  console.error('[sync] fatal:', err);
  process.exit(1);
});
