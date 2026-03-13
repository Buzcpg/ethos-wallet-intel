/**
 * ethos-wallet-intel test suite
 * ─────────────────────────────
 * Scans only buz_eth (#15) and serpinxbt (#8) primary wallets on ethereum.
 * Serial execution — no Promise.all over scans. ~4-8 API calls total.
 *
 * Usage:  npx tsx scripts/test-suite.ts
 * Output: pass/fail per check, exit code 1 if any fail.
 */
import { db as getDb } from '../src/db/client.js';
import { profiles, wallets, firstFunderSignals } from '../src/db/schema/index.js';
import { WalletTransactionFetcher } from '../src/chains/transactionFetcher.js';
import { WalletScanner } from '../src/scanner/walletScanner.js';
import { eq, inArray, sql } from 'drizzle-orm';
import type { ChainSlug } from '../src/chains/index.js';

// Only these two profiles, ethereum only — ~4-8 API calls total
const REQUIRED_PROFILE_IDS = [15, 8]; // buz_eth, serpinxbt
const SCAN_CHAIN: ChainSlug = 'ethereum';

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

  // ── Step 1: DB connectivity ────────────────────────────────────────────────
  console.log('▶ DB connectivity');
  try {
    await database.execute(sql`SELECT 1 AS ok`);
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

  if (requiredProfiles.length === 0) {
    console.error('\n💥 No required profiles found in DB — aborting.');
    process.exit(1);
  }

  // ── Step 3: Raw API health check (one request on ethereum) ─────────────────
  console.log('\n▶ Blockscout API health (ethereum only)');
  const testAddr = '0x9a58c041255ca395a9cba41ab541e6dc8f3518bb';
  try {
    const fetcher = new WalletTransactionFetcher(SCAN_CHAIN);
    const result = await fetcher.fetchAll(testAddr);
    check(`${SCAN_CHAIN} API responds`, true, `fetched ${result.totalFetched} txs for test address`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    check(`${SCAN_CHAIN} API responds`, false, msg);
  }

  // ── Step 4: Scan primary wallets — serial, ethereum only ──────────────────
  console.log('\n▶ Scanning primary wallets (ethereum, serial)');

  // Load primary wallets for buz_eth and serpinxbt on ethereum only
  const profileIds = requiredProfiles.map(p => p.id);
  const primaryWallets = await database
    .select({
      id: wallets.id,
      address: wallets.address,
      chain: wallets.chain,
      profileId: wallets.profileId,
    })
    .from(wallets)
    .where(
      inArray(wallets.profileId, profileIds),
    )
    .then(rows => rows.filter(w => w.chain === SCAN_CHAIN));

  console.log(`  Found ${primaryWallets.length} wallet(s) on ${SCAN_CHAIN} for ${requiredProfiles.length} profiles`);

  if (primaryWallets.length === 0) {
    check('Primary wallets found on ethereum', false, 'no wallets found — check DB sync');
    process.exit(1);
  }

  // Clear existing signals for a clean test run
  const walletIds = primaryWallets.map(w => w.id);
  await database.delete(firstFunderSignals).where(inArray(firstFunderSignals.walletId, walletIds));
  console.log('  Cleared existing signals for clean run');

  const scanner = new WalletScanner();
  let scanned = 0;
  const errors: string[] = [];

  // Serial scan — no Promise.all
  for (const w of primaryWallets) {
    const profile = requiredProfiles.find(p => p.id === w.profileId);
    const label = `${profile?.slug ?? w.profileId}@${w.chain}`;
    console.log(`\n  Scanning ${label} (${w.address})`);

    try {
      const result = await scanner.scanWallet(w.id, w.chain as ChainSlug);
      console.log(`    txs fetched:      ${result.transactionsFetched}`);
      console.log(`    first funder:     ${result.firstFunderFound ? '✅ found' : '— none'}`);
      console.log(`    deposit evidence: ${result.depositEvidenceFound}`);
      console.log(`    p2p matches:      ${result.p2pMatchesFound}`);
      console.log(`    partial:          ${result.partial}`);
      scanned++;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      errors.push(`${label}: ${msg}`);
      console.error(`    ❌ error: ${msg}`);
    }
  }

  check('All wallets scanned without errors', errors.length === 0,
    errors.length > 0 ? errors.join('; ') : `${scanned}/${primaryWallets.length} scanned`);

  // ── Step 5: Verify signals in DB ──────────────────────────────────────────
  console.log('\n▶ Signal verification');

  const signalCount = await database
    .select({ count: sql<number>`COUNT(*)` })
    .from(firstFunderSignals)
    .where(inArray(firstFunderSignals.walletId, walletIds));

  const totalSignals = Number(signalCount[0]?.count ?? 0);
  check('≥1 signal written to DB', totalSignals >= 1, `${totalSignals} signal(s) total`);

  // Per-profile signal breakdown
  for (const profile of requiredProfiles) {
    const profileWallets = primaryWallets.filter(w => w.profileId === profile.id);
    if (profileWallets.length === 0) continue;

    const signals = await database
      .select({
        chain: firstFunderSignals.chain,
        funderAddress: firstFunderSignals.funderAddress,
        txHash: firstFunderSignals.txHash,
      })
      .from(firstFunderSignals)
      .where(inArray(firstFunderSignals.walletId, profileWallets.map(w => w.id)));

    console.log(`\n  ${profile.slug ?? `#${profile.externalId}`} signals (${signals.length}):`);
    for (const s of signals) {
      console.log(`    ${s.chain}: first funder = ${s.funderAddress}`);
      console.log(`             tx    = ${s.txHash}`);
    }
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
