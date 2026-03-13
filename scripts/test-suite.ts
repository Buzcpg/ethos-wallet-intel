/**
 * ethos-wallet-intel test suite
 * ─────────────────────────────
 * Loads 10 profiles (always includes profileId 15/buz_eth and 8/serpinxbt),
 * runs a full scan on each, and validates that the pipeline is healthy.
 *
 * Usage:  npx tsx scripts/test-suite.ts
 * Output: pass/fail per check, exit code 1 if any fail.
 */
import { db as getDb } from '../src/db/client.js';
import { profiles, wallets, firstFunderSignals, wallet_scan_jobs } from '../src/db/schema/index.js';
import { WalletTransactionFetcher } from '../src/chains/transactionFetcher.js';
import { WalletScanner } from '../src/scanner/walletScanner.js';
import { eq, inArray, or, sql } from 'drizzle-orm';
import type { ChainSlug } from '../src/chains/index.js';

const REQUIRED_PROFILE_IDS = [15, 8]; // buz_eth, serpinxbt
const TOTAL_PROFILES = 10;
const CHAINS: ChainSlug[] = ['ethereum', 'base', 'arbitrum', 'optimism', 'polygon'];

let passed = 0;
let failed = 0;

function check(label: string, condition: boolean, detail = '') {
  if (condition) {
    console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function main() {
  console.log('\n═══════════════════════════════════════');
  console.log('  ethos-wallet-intel test suite');
  console.log('═══════════════════════════════════════\n');

  const database = getDb();

  // ── Step 1: Check DB connectivity ──────────────────────────────────────────
  console.log('▶ DB connectivity');
  try {
    const res = await database.execute(sql`SELECT 1 AS ok`);
    check('DB responds', true);
  } catch (err) {
    check('DB responds', false, String(err));
    process.exit(1);
  }

  // ── Step 2: Verify required profiles exist ─────────────────────────────────
  console.log('\n▶ Profile existence');
  const requiredProfiles = await database
    .select({ id: profiles.id, externalId: profiles.externalProfileId, slug: profiles.slug })
    .from(profiles)
    .where(inArray(profiles.externalProfileId, REQUIRED_PROFILE_IDS));

  for (const pid of REQUIRED_PROFILE_IDS) {
    const found = requiredProfiles.find(p => p.externalId === pid);
    check(`Profile #${pid} exists`, !!found, found ? `slug=${found.slug}` : 'MISSING');
  }

  // ── Step 3: Load 10 test profiles ─────────────────────────────────────────
  console.log('\n▶ Loading test profiles');
  const requiredIds = requiredProfiles.map(p => p.id);
  const extras = await database
    .select({ id: profiles.id, externalId: profiles.externalProfileId, slug: profiles.slug })
    .from(profiles)
    .limit(TOTAL_PROFILES + REQUIRED_PROFILE_IDS.length);

  const testProfiles = [
    ...requiredProfiles,
    ...extras.filter(p => !requiredIds.includes(p.id)),
  ].slice(0, TOTAL_PROFILES);

  check(`Loaded ${TOTAL_PROFILES} profiles`, testProfiles.length === TOTAL_PROFILES,
    testProfiles.map(p => p.slug).join(', '));

  // ── Step 4: Raw API health check per chain ─────────────────────────────────
  console.log('\n▶ Blockscout API health (one request per chain)');
  // Use buz_eth's primary wallet as test address
  const testWallet = await database
    .select({ address: wallets.address })
    .from(wallets)
    .innerJoin(profiles, eq(wallets.profileId, profiles.id))
    .where(eq(profiles.externalProfileId, 15))
    .limit(1);

  const testAddr = testWallet[0]?.address ?? '0x9a58c041255ca395a9cba41ab541e6dc8f3518bb';

  for (const chain of CHAINS) {
    try {
      const fetcher = new WalletTransactionFetcher(chain);
      // Just test the v1 API responds (don't care about tx count for this addr)
      const result = await fetcher.fetchAll(testAddr);
      check(`${chain} API responds`, true, `fetched ${result.totalFetched} txs`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      check(`${chain} API responds`, false, msg);
    }
    // Small delay between chains to avoid rate limit burst
    await new Promise(r => setTimeout(r, 2000));
  }

  // ── Step 5: Full scan for the 10 profiles ─────────────────────────────────
  console.log('\n▶ Full scan for test profiles (one wallet×chain at a time)');

  // Clear any existing signals for test profiles to get clean results
  const testProfileIds = testProfiles.map(p => p.id);
  const testWallets = await database
    .select({ id: wallets.id, address: wallets.address, chain: wallets.chain, profileId: wallets.profileId })
    .from(wallets)
    .where(inArray(wallets.profileId, testProfileIds));

  console.log(`  Found ${testWallets.length} wallet×chain combos for ${testProfiles.length} profiles`);

  // Clear existing signals for a clean test
  if (testWallets.length > 0) {
    const walletIds = testWallets.map(w => w.id);
    await database.delete(firstFunderSignals).where(inArray(firstFunderSignals.walletId, walletIds));
    console.log('  Cleared existing signals for clean test');
  }

  // Scan each wallet×chain (5 chains × profiles, serialised to avoid rate limits)
  const scanner = new WalletScanner();
  let scanned = 0;
  let signalsFound = 0;
  const errors: string[] = [];

  for (const w of testWallets.filter(w => CHAINS.includes(w.chain as ChainSlug))) {
    const profile = testProfiles.find(p => p.id === w.profileId);
    try {
      const result = await scanner.scanWallet(w.id, w.chain as ChainSlug);
      if (result.firstFunderFound) signalsFound++;
      scanned++;
    } catch (err) {
      errors.push(`${profile?.slug ?? w.profileId}@${w.chain}: ${err instanceof Error ? err.message : err}`);
    }
    // Rate limit guard: 500ms between scans in test mode
    await new Promise(r => setTimeout(r, 500));
  }

  check('All wallets scanned without unhandled errors', errors.length === 0,
    errors.length > 0 ? errors.slice(0, 3).join('; ') : '');
  check('At least some signals found', signalsFound > 0, `${signalsFound} signals from ${scanned} scans`);

  // ── Step 6: Verify signals in DB ──────────────────────────────────────────
  console.log('\n▶ Signal verification');
  const signalCount = await database
    .select({ count: sql<number>`COUNT(*)` })
    .from(firstFunderSignals)
    .where(inArray(firstFunderSignals.walletId, testWallets.map(w => w.id)));

  const totalSignals = Number(signalCount[0]?.count ?? 0);
  check('Signals written to DB', totalSignals > 0, `${totalSignals} signals total`);

  // Check buz_eth specifically
  const buzWallets = testWallets.filter(w => testProfiles.find(p => p.id === w.profileId)?.externalId === 15);
  const buzSignals = await database
    .select({ chain: firstFunderSignals.chain, funder: firstFunderSignals.funderAddressAddress })
    .from(firstFunderSignals)
    .where(inArray(firstFunderSignals.walletId, buzWallets.map(w => w.id)));

  console.log(`\n  buz_eth signals (${buzSignals.length}):`);
  for (const s of buzSignals) {
    console.log(`    ${s.chain}: funded by ${s.funderAddress}`);
  }

  // Check serpinxbt specifically
  const serpWallets = testWallets.filter(w => testProfiles.find(p => p.id === w.profileId)?.externalId === 8);
  const serpSignals = await database
    .select({ chain: firstFunderSignals.chain, funder: firstFunderSignals.funderAddressAddress })
    .from(firstFunderSignals)
    .where(inArray(firstFunderSignals.walletId, serpWallets.map(w => w.id)));

  console.log(`\n  serpinxbt signals (${serpSignals.length}):`);
  for (const s of serpSignals) {
    console.log(`    ${s.chain}: funded by ${s.funderAddress}`);
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════\n');

  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n💥 Test suite crashed:', err);
  process.exit(1);
});
