/**
 * ethos-wallet-intel test suite — 10 wallets
 * ────────────────────────────────────────────
 * Mandatory: buz_eth (#15), serpinxbt (#8), EthosiansAgent (#24309)
 * Plus 7 more early profiles. Primary wallets only, ethereum chain.
 * Checks: first funder, deposit evidence, p2p matches, cross-wallet signals.
 *
 * Usage:  npx tsx scripts/test-suite.ts
 */
import { db as getDb } from '../src/db/client.js';
import { profiles, wallets, firstFunderSignals, walletMatches } from '../src/db/schema/index.js';
import { WalletTransactionFetcher } from '../src/chains/transactionFetcher.js';
import { WalletScanner } from '../src/scanner/walletScanner.js';
import { and, eq, inArray, or, sql } from 'drizzle-orm';
import type { ChainSlug } from '../src/chains/index.js';

// ── 3 mandatory + 7 interesting early profiles ────────────────────────────
const REQUIRED_PROFILE_IDS  = [15, 8, 24309];          // buz_eth, serpinxbt, EthosiansAgent
const EXTRA_PROFILE_IDS     = [1, 2, 3, 6, 9, 32, 37]; // ethos, porkbus, workhorse, bluechilli, ak, roothlus, hildobby
const ALL_PROFILE_IDS       = [...REQUIRED_PROFILE_IDS, ...EXTRA_PROFILE_IDS];
const SCAN_CHAIN: ChainSlug = 'ethereum';

let passed = 0;
let failed = 0;

function check(label: string, ok: boolean, detail = '') {
  if (ok) {
    console.log(`  ✅ ${label}${detail ? ' — ' + detail : ''}`);
    passed++;
  } else {
    console.error(`  ❌ FAIL: ${label}${detail ? ' — ' + detail : ''}`);
    failed++;
  }
}

async function main() {
  console.log('\n═══════════════════════════════════════════');
  console.log('  ethos-wallet-intel — 10-wallet test suite');
  console.log('═══════════════════════════════════════════\n');

  const database = getDb();

  // ── 1. DB connectivity ─────────────────────────────────────────────────────
  console.log('▶ DB connectivity');
  try {
    await database.execute(sql`SELECT 1 AS ok`);
    check('DB responds', true);
  } catch (err) {
    check('DB responds', false, String(err));
    process.exit(1);
  }

  // ── 2. Mandatory profiles exist ────────────────────────────────────────────
  console.log('\n▶ Mandatory profiles');
  const allProfiles = await database
    .select({ id: profiles.id, externalId: profiles.externalProfileId, slug: profiles.slug })
    .from(profiles)
    .where(inArray(profiles.externalProfileId, ALL_PROFILE_IDS));

  for (const pid of REQUIRED_PROFILE_IDS) {
    const found = allProfiles.find(p => p.externalId === pid);
    check(`Profile #${pid} exists`, !!found, found ? `slug=${found.slug}` : 'MISSING');
  }
  const optionalFound = allProfiles.filter(p => EXTRA_PROFILE_IDS.includes(p.externalId ?? 0));
  console.log(`  Extra profiles found: ${optionalFound.length}/${EXTRA_PROFILE_IDS.length}`);

  if (!allProfiles.some(p => REQUIRED_PROFILE_IDS.includes(p.externalId ?? 0))) {
    console.error('\n💥 No mandatory profiles found — aborting.');
    process.exit(1);
  }

  // ── 3. API health check ────────────────────────────────────────────────────
  console.log('\n▶ API health');
  try {
    const fetcher = new WalletTransactionFetcher(SCAN_CHAIN);
    const r = await fetcher.fetchAll('0x9a58c041255ca395a9cba41ab541e6dc8f3518bb');
    check(`${SCAN_CHAIN} API responds`, true, `${r.totalFetched} txs for buz_eth`);
  } catch (err) {
    check(`${SCAN_CHAIN} API responds`, false, err instanceof Error ? err.message : String(err));
  }

  // ── 4. Load primary wallets ────────────────────────────────────────────────
  console.log('\n▶ Loading primary wallets');
  const profileIds = allProfiles.map(p => p.id);
  // For mandatory profiles: scan ALL wallets (to catch cross-wallet p2p links)
  // For extra profiles: primary only (keeps CU reasonable)
  const mandatoryProfileIds = allProfiles
    .filter(p => REQUIRED_PROFILE_IDS.includes(p.externalId ?? 0))
    .map(p => p.id);
  const extraProfileIds = allProfiles
    .filter(p => !REQUIRED_PROFILE_IDS.includes(p.externalId ?? 0))
    .map(p => p.id);

  const allWalletsForMandatory = mandatoryProfileIds.length > 0
    ? await database
        .select({ id: wallets.id, address: wallets.address, chain: wallets.chain, profileId: wallets.profileId })
        .from(wallets)
        .where(and(inArray(wallets.profileId, mandatoryProfileIds), eq(wallets.chain, SCAN_CHAIN)))
    : [];

  const primaryWalletsForExtras = extraProfileIds.length > 0
    ? await database
        .select({ id: wallets.id, address: wallets.address, chain: wallets.chain, profileId: wallets.profileId })
        .from(wallets)
        .where(and(inArray(wallets.profileId, extraProfileIds), eq(wallets.chain, SCAN_CHAIN), eq(wallets.isPrimary, true)))
    : [];

  const primaryWallets = [...allWalletsForMandatory, ...primaryWalletsForExtras];

  check(`Wallets loaded`, primaryWallets.length >= REQUIRED_PROFILE_IDS.length,
    `${primaryWallets.length} wallets for ${allProfiles.length} profiles on ${SCAN_CHAIN}`);

  if (primaryWallets.length === 0) process.exit(1);

  console.log('  Wallet addresses in scan set:');
  for (const w of primaryWallets) {
    const p = allProfiles.find(x => x.id === w.profileId);
    console.log(`    ${(p?.slug ?? '?').padEnd(20)} ${w.address}`);
  }

  // ── 5. Clear signals for clean run ────────────────────────────────────────
  const walletIds = primaryWallets.map(w => w.id);
  await database.delete(firstFunderSignals).where(inArray(firstFunderSignals.walletId, walletIds));
  await database.delete(walletMatches).where(
    or(inArray(walletMatches.walletAId, walletIds), inArray(walletMatches.walletBId, walletIds))
  );
  console.log(`\n  Cleared existing signals for ${walletIds.length} wallets`);

  // ── 6. Scan — serial, no concurrent calls ────────────────────────────────
  console.log('\n▶ Scanning wallets (serial)');
  const scanner = new WalletScanner();
  const scanResults: Array<{ slug: string; address: string; firstFunder: boolean; deposits: number; p2p: number; partial: boolean }> = [];
  const errors: string[] = [];

  for (const w of primaryWallets) {
    const p = allProfiles.find(x => x.id === w.profileId);
    const label = `${p?.slug ?? w.profileId}`;
    process.stdout.write(`  ${label.padEnd(22)} `);

    try {
      const result = await scanner.scanWallet(w.id, w.chain as ChainSlug);
      const partial = result.partial ? ' [partial]' : '';
      process.stdout.write(`txs=${result.transactionsFetched} funder=${result.firstFunderFound ? '✅' : '—'} deposits=${result.depositEvidenceFound} p2p=${result.p2pMatchesFound}${partial}\n`);
      scanResults.push({
        slug: label, address: w.address,
        firstFunder: result.firstFunderFound,
        deposits: result.depositEvidenceFound,
        p2p: result.p2pMatchesFound,
        partial: result.partial,
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      process.stdout.write(`❌ ${msg}\n`);
      errors.push(`${label}: ${msg}`);
    }
  }

  check('All wallets scanned', errors.length === 0,
    errors.length === 0 ? `${scanResults.length}/${primaryWallets.length} ok` : errors.join('; '));

  // ── 7. First funder signals ───────────────────────────────────────────────
  console.log('\n▶ First funder signals');
  const signals = await database
    .select({
      walletId: firstFunderSignals.walletId,
      funder: firstFunderSignals.funderAddress,
      txHash: firstFunderSignals.txHash,
      confidence: firstFunderSignals.confidence,
      source: firstFunderSignals.source,
    })
    .from(firstFunderSignals)
    .where(inArray(firstFunderSignals.walletId, walletIds));

  check('≥1 first funder signal written', signals.length >= 1, `${signals.length} total`);

  for (const w of primaryWallets) {
    const p = allProfiles.find(x => x.id === w.profileId);
    const s = signals.find(x => x.walletId === w.id);
    if (s) {
      console.log(`  ${(p?.slug ?? '?').padEnd(20)} funder=${s.funder}  conf=${s.confidence}  via=${s.source}`);
    } else {
      console.log(`  ${(p?.slug ?? '?').padEnd(20)} — no first funder signal`);
    }
  }

  // Check mandatory profiles have signals
  for (const pid of REQUIRED_PROFILE_IDS) {
    const prof = allProfiles.find(p => p.externalId === pid);
    if (!prof) continue;
    const w = primaryWallets.find(x => x.profileId === prof.id);
    if (!w) continue;
    const sig = signals.find(s => s.walletId === w.id);
    check(`${prof.slug} has first funder signal`, !!sig, sig ? sig.funder ?? '' : 'missing');
  }

  // ── 8. Deposit evidence ───────────────────────────────────────────────────
  console.log('\n▶ Deposit evidence');
  const totalDeposits = scanResults.reduce((sum, r) => sum + r.deposits, 0);
  console.log(`  Total deposit evidence rows: ${totalDeposits}`);
  const depositProfiles = scanResults.filter(r => r.deposits > 0);
  if (depositProfiles.length > 0) {
    for (const r of depositProfiles) {
      console.log(`  ${r.slug.padEnd(22)} ${r.deposits} deposit evidence row(s)`);
    }
  } else {
    console.log('  No deposit evidence found (wallets may not send to known CEX addresses)');
  }

  // ── 9. P2P matches ────────────────────────────────────────────────────────
  console.log('\n▶ P2P matches');
  const matches = await database
    .select({
      walletAId: walletMatches.walletAId,
      walletBId: walletMatches.walletBId,
      matchType: walletMatches.matchType,
      matchKey: walletMatches.matchKey,
      score: walletMatches.score,
    })
    .from(walletMatches)
    .where(or(
      inArray(walletMatches.walletAId, walletIds),
      inArray(walletMatches.walletBId, walletIds),
    ));

  console.log(`  Total matches: ${matches.length}`);

  if (matches.length > 0) {
    for (const m of matches) {
      const wa = primaryWallets.find(w => w.id === m.walletAId);
      const wb = primaryWallets.find(w => w.id === m.walletBId);
      const pa = allProfiles.find(p => p.id === wa?.profileId);
      const pb = allProfiles.find(p => p.id === wb?.profileId);
      console.log(`  ${(pa?.slug ?? '?').padEnd(20)} ↔ ${(pb?.slug ?? '?').padEnd(20)} type=${m.matchType} conf=${m.score}`);
      console.log(`    key: ${m.matchKey}`);
    }
  } else {
    console.log('  No p2p matches found between scanned wallets');
  }

  // Check specifically for buz ↔ EthosiansAgent match
  const buzProf = allProfiles.find(p => p.externalId === 15);
  const ethosProf = allProfiles.find(p => p.externalId === 24309);
  const buzWallet = primaryWallets.find(w => w.profileId === buzProf?.id);
  const ethosWallet = primaryWallets.find(w => w.profileId === ethosProf?.id);

  if (buzWallet && ethosWallet) {
    const buzEthosMatch = matches.find(m =>
      (m.walletAId === buzWallet.id && m.walletBId === ethosWallet.id) ||
      (m.walletAId === ethosWallet.id && m.walletBId === buzWallet.id)
    );
    if (buzEthosMatch) {
      check('buz_eth ↔ EthosiansAgent p2p match found', true, `type=${buzEthosMatch.matchType}`);
    } else {
      console.log(`  ℹ️  buz_eth ↔ EthosiansAgent: no match on ${SCAN_CHAIN} — known link is on base (0x5f2da3 funded 0x84de46)`);
    }
  }

  // ── 10. Shared funders (sybil signal) ────────────────────────────────────
  console.log('\n▶ Shared funder check');
  const funderCounts: Record<string, string[]> = {};
  for (const s of signals) {
    const w = primaryWallets.find(x => x.id === s.walletId);
    const p = allProfiles.find(x => x.id === w?.profileId);
    const funder = s.funder?.toLowerCase() ?? '';
    if (!funder) continue;
    if (!funderCounts[funder]) funderCounts[funder] = [];
    funderCounts[funder].push(p?.slug ?? '?');
  }

  const sharedFunders = Object.entries(funderCounts).filter(([, slugs]) => slugs.length > 1);
  if (sharedFunders.length > 0) {
    console.log(`  ⚠️  ${sharedFunders.length} shared funder(s) found — potential sybil signal:`);
    for (const [funder, slugs] of sharedFunders) {
      console.log(`    ${funder}`);
      console.log(`    funded: ${slugs.join(', ')}`);
    }
  } else {
    console.log('  No shared funders across this wallet set');
  }

  // ── Summary ────────────────────────────────────────────────────────────────
  console.log('\n═══════════════════════════════════════════');
  console.log(`  Results: ${passed} passed, ${failed} failed`);
  console.log('═══════════════════════════════════════════\n');
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => {
  console.error('\n💥 Crashed:', err);
  process.exit(1);
});
