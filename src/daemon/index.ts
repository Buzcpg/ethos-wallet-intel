/**
 * Intel Daemon — runs every 60 minutes on the full dataset.
 * 1. Funding Hub Analyser  (excludes known CEX hot wallets)
 * 2. Profile Risk Scorer   (CEX first-funders are non-signals)
 * 3. Discord report
 */
import 'dotenv/config';
import { db as getDb, getPool } from '../db/client.js';
import {
  wallets, profiles,
  firstFunderSignals, depositTransferEvidence,
  walletMatches, profileMatches,
  fundingHubSignals, profileScores,
  addressLabels,
} from '../db/schema/index.js';
import { eq, sql, inArray } from 'drizzle-orm';

const RUN_INTERVAL_MS  = 60 * 60 * 1000;
const DISCORD_CHANNEL  = process.env['DISCORD_CHANNEL_ID'] ?? '1482049214824452277';
const HUB_MIN_PROFILES = 3;

const W = {
  perProfileMatch:      25,
  maxProfileMatchScore: 75,
  perWalletMatch:        5,
  maxWalletMatchScore:  50,
  sharedFirstFunder:    40,   // only non-CEX funders
  fundingHubConnection: 35,   // only non-CEX hubs
  firstFunderExists:    10,   // only non-CEX first funders
};

function toTier(score: number): 'low' | 'medium' | 'high' | 'critical' {
  if (score >= 90) return 'critical';
  if (score >= 60) return 'high';
  if (score >= 30) return 'medium';
  return 'low';
}

async function countQuery(pool: import('pg').Pool, query: string, params: unknown[]): Promise<number> {
  const client = await pool.connect();
  try {
    const res = await client.query(query, params);
    return parseInt(res.rows[0]?.cnt ?? '0', 10);
  } finally {
    client.release();
  }
}

// Load all known CEX hot wallet addresses into a Set for fast lookup
async function loadCexAddresses(database: ReturnType<typeof getDb>): Promise<Set<string>> {
  const rows = await database
    .select({ address: addressLabels.address })
    .from(addressLabels)
    .where(eq(addressLabels.labelKind, 'exchange_hot_wallet'));
  const cexSet = new Set(rows.map(r => r.address.toLowerCase()));
  console.log(`[intel] Loaded ${cexSet.size.toLocaleString()} CEX addresses to exclude from hub/scoring`);
  return cexSet;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 1 — Funding Hub Analysis (CEX-excluded)
// ─────────────────────────────────────────────────────────────────────────────
async function runFundingHubAnalysis(database: ReturnType<typeof getDb>, cexSet: Set<string>) {
  console.log('[intel] Step 1: Funding Hub Analysis');

  const rows = await database.execute(sql`
    SELECT ffs.funder_address, ffs.chain, ffs.wallet_id, w.profile_id
    FROM first_funder_signals ffs
    JOIN wallets w ON w.id = ffs.wallet_id
    WHERE ffs.funder_address IS NOT NULL
  `);

  type HubEntry = { walletIds: Set<string>; profileIds: Set<string> };
  const hubs = new Map<string, HubEntry>();

  for (const row of rows.rows as Array<{ funder_address: string; chain: string; wallet_id: string; profile_id: string }>) {
    // Skip known CEX hot wallets — they fund thousands of unrelated users
    if (cexSet.has(row.funder_address.toLowerCase())) continue;

    const key = `${row.funder_address}::${row.chain}`;
    if (!hubs.has(key)) hubs.set(key, { walletIds: new Set(), profileIds: new Set() });
    hubs.get(key)!.walletIds.add(row.wallet_id);
    hubs.get(key)!.profileIds.add(row.profile_id);
  }

  const qualifying = [...hubs.entries()]
    .filter(([, e]) => e.profileIds.size >= HUB_MIN_PROFILES)
    .map(([key, e]) => {
      const sep = key.indexOf('::');
      return { funderAddress: key.slice(0, sep), chain: key.slice(sep + 2), e };
    });

  console.log(`[intel] Found ${qualifying.length} non-CEX funding hubs (>= ${HUB_MIN_PROFILES} profiles)`);

  // Clear stale hub rows then re-insert fresh
  await database.delete(fundingHubSignals);

  for (const { funderAddress, chain, e } of qualifying) {
    await database
      .insert(fundingHubSignals)
      .values({
        funderAddress, chain,
        walletsFundedCount:  e.walletIds.size,
        profilesFundedCount: e.profileIds.size,
        fundedWalletIds:     [...e.walletIds],
        fundedProfileIds:    [...e.profileIds],
        computedAt:          new Date(),
      })
      .onConflictDoUpdate({
        target: [fundingHubSignals.funderAddress, fundingHubSignals.chain],
        set: {
          walletsFundedCount:  e.walletIds.size,
          profilesFundedCount: e.profileIds.size,
          fundedWalletIds:     [...e.walletIds],
          fundedProfileIds:    [...e.profileIds],
          computedAt:          new Date(),
        },
      });
  }

  return qualifying.length;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 2 — Profile Risk Scoring
// ─────────────────────────────────────────────────────────────────────────────
async function runProfileScoring(database: ReturnType<typeof getDb>, cexSet: Set<string>) {
  console.log('[intel] Step 2: Profile Risk Scoring');

  const hubRows = await database
    .select({ funderAddress: fundingHubSignals.funderAddress, chain: fundingHubSignals.chain })
    .from(fundingHubSignals);
  // Hub set already has CEX stripped (from Step 1), but belt-and-braces:
  const hubSet = new Set(
    hubRows
      .filter(r => !cexSet.has(r.funderAddress.toLowerCase()))
      .map(r => `${r.funderAddress}::${r.chain}`)
  );

  const allProfiles = await database
    .select({ id: profiles.id, externalProfileId: profiles.externalProfileId })
    .from(profiles);

  console.log(`[intel] Scoring ${allProfiles.length.toLocaleString()} profiles`);

  const pool = getPool();
  const tierCounts = { low: 0, medium: 0, high: 0, critical: 0 };
  let processed = 0;

  for (const profile of allProfiles) {
    const profileWallets = await database
      .select({ id: wallets.id, address: wallets.address, chain: wallets.chain })
      .from(wallets)
      .where(eq(wallets.profileId, profile.id));

    if (profileWallets.length === 0) continue;
    const walletIds    = profileWallets.map(w => w.id);
    const pgUuidArray  = `{${walletIds.join(',')}}`;

    const walletMatchCount = await countQuery(pool,
      `SELECT COUNT(*)::int AS cnt FROM wallet_matches WHERE wallet_a_id = ANY($1::uuid[]) OR wallet_b_id = ANY($1::uuid[])`,
      [pgUuidArray]
    );

    const profileMatchCount = await countQuery(pool,
      `SELECT COUNT(*)::int AS cnt FROM profile_matches WHERE profile_a_id = $1 OR profile_b_id = $1`,
      [profile.id]
    );

    const cexDepositCount = await countQuery(pool,
      `SELECT COUNT(*)::int AS cnt FROM deposit_transfer_evidence WHERE wallet_id = ANY($1::uuid[])`,
      [pgUuidArray]
    );

    // First funder signals — filter out CEX addresses before scoring
    const allFfSignals = walletIds.length > 0
      ? await database
          .select({ walletId: firstFunderSignals.walletId, funderAddress: firstFunderSignals.funderAddress, chain: firstFunderSignals.chain })
          .from(firstFunderSignals)
          .where(inArray(firstFunderSignals.walletId, walletIds))
      : [];

    // Split: CEX funders (data kept, not scored) vs real funders (scored)
    const realFfSignals = allFfSignals.filter(s => !cexSet.has(s.funderAddress.toLowerCase()));
    const firstFunderMatchCount = allFfSignals.length; // total count incl CEX (for info only)

    const fundingHubConnection = realFfSignals.some(s => hubSet.has(`${s.funderAddress}::${s.chain}`));

    // Shared first funder — only non-CEX funders
    let sharedFirstFunder = false;
    if (realFfSignals.length > 0) {
      const realFunderAddrs   = realFfSignals.map(s => s.funderAddress);
      const realFunderChains  = realFfSignals.map(s => s.chain);
      // Find any other profile's wallet that shares a non-CEX first funder with us
      const sharedCount = await countQuery(pool,
        `SELECT COUNT(DISTINCT ffs2.wallet_id)::int AS cnt
         FROM first_funder_signals ffs1
         JOIN first_funder_signals ffs2
           ON ffs2.funder_address = ffs1.funder_address
          AND ffs2.chain = ffs1.chain
          AND ffs2.wallet_id != ffs1.wallet_id
         JOIN wallets w2 ON w2.id = ffs2.wallet_id
         WHERE ffs1.wallet_id = ANY($1::uuid[])
           AND w2.profile_id != $2
           AND ffs1.funder_address != ALL($3::text[])`,
        [pgUuidArray, profile.id, `{${realFunderAddrs.map(a => `"${a}"`).join(',')}}`]
      );
      sharedFirstFunder = sharedCount > 0;
    }

    // Score — CEX first funders contribute zero
    const breakdown: Record<string, number> = {};
    let score = 0;

    const profileMatchScore = Math.min(profileMatchCount * W.perProfileMatch, W.maxProfileMatchScore);
    if (profileMatchScore > 0) { breakdown.profileMatches = profileMatchScore; score += profileMatchScore; }

    const walletMatchScore = Math.min(walletMatchCount * W.perWalletMatch, W.maxWalletMatchScore);
    if (walletMatchScore > 0) { breakdown.walletMatches = walletMatchScore; score += walletMatchScore; }

    if (sharedFirstFunder)    { breakdown.sharedFirstFunder    = W.sharedFirstFunder;    score += W.sharedFirstFunder; }
    if (fundingHubConnection) { breakdown.fundingHubConnection = W.fundingHubConnection; score += W.fundingHubConnection; }
    // firstFunderExists: only score if funder is non-CEX (means someone specifically funded this wallet)
    if (realFfSignals.length > 0) { breakdown.firstFunderExists = W.firstFunderExists; score += W.firstFunderExists; }

    const tier = toTier(score);
    tierCounts[tier]++;

    await database
      .insert(profileScores)
      .values({
        profileId: profile.id,
        externalProfileId: profile.externalProfileId,
        totalScore: score.toFixed(2),
        riskTier: tier,
        walletMatchCount,
        profileMatchCount,
        firstFunderMatchCount,
        fundingHubConnection,
        cexDepositCount,
        signalBreakdown: breakdown,
        computedAt: new Date(),
      })
      .onConflictDoUpdate({
        target: [profileScores.profileId],
        set: {
          totalScore: score.toFixed(2),
          riskTier: tier,
          walletMatchCount,
          profileMatchCount,
          firstFunderMatchCount,
          fundingHubConnection,
          cexDepositCount,
          signalBreakdown: breakdown,
          computedAt: new Date(),
        },
      });

    processed++;
    if (processed % 500 === 0) process.stdout.write(`\r  scored ${processed.toLocaleString()}/${allProfiles.length.toLocaleString()}  `);
  }

  console.log(`\n[intel] Scoring done — low:${tierCounts.low} medium:${tierCounts.medium} high:${tierCounts.high} critical:${tierCounts.critical}`);
  return tierCounts;
}

// ─────────────────────────────────────────────────────────────────────────────
// Step 3 — Discord Report
// ─────────────────────────────────────────────────────────────────────────────
async function postDiscordReport(
  database: ReturnType<typeof getDb>,
  hubCount: number,
  tierCounts: Record<string, number>,
) {
  const token = process.env['DISCORD_BOT_TOKEN'];
  if (!token) { console.log('[intel] No DISCORD_BOT_TOKEN — skipping Discord report'); return; }

  const top = await database
    .select({ externalProfileId: profileScores.externalProfileId, totalScore: profileScores.totalScore, riskTier: profileScores.riskTier })
    .from(profileScores)
    .orderBy(sql`total_score DESC`)
    .limit(5);

  const [scanRow] = await database.execute(sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'done')::int AS done,
      COUNT(*) FILTER (WHERE status = 'pending')::int AS pending
    FROM wallet_scan_jobs
  `).then(r => r.rows as Array<{ done: number; pending: number }>);

  const done    = scanRow?.done    ?? 0;
  const pending = scanRow?.pending ?? 0;
  const total   = done + pending;
  const pct     = total > 0 ? Math.round((done / total) * 100) : 0;

  const tierIcon: Record<string, string> = { low: '🟢', medium: '🟡', high: '🟠', critical: '🔴' };
  const topLines = top
    .filter(p => parseFloat(p.totalScore ?? '0') > 0)
    .map(p => `  ${tierIcon[p.riskTier] ?? '⚪'} Profile #${p.externalProfileId} — score ${parseFloat(p.totalScore ?? '0').toFixed(0)} (${p.riskTier})`)
    .join('\n');

  const msg = [
    `🔍 **Intel update**`,
    `├─ Backfill: ${done.toLocaleString()}/${total.toLocaleString()} wallets (${pct}%)`,
    `├─ Non-CEX funding hubs: **${hubCount}**`,
    `├─ Risk tiers: 🔴 ${tierCounts.critical} critical  🟠 ${tierCounts.high} high  🟡 ${tierCounts.medium} medium  🟢 ${tierCounts.low} low`,
    `└─ Top profiles by score:`,
    topLines || '  _(scores still low — backfill early)_',
  ].join('\n');

  try {
    const res = await fetch(`https://discord.com/api/v10/channels/${DISCORD_CHANNEL}/messages`, {
      method: 'POST',
      headers: { Authorization: `Bot ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({ content: msg }),
    });
    if (!res.ok) console.error('[intel] Discord post failed:', res.status, await res.text());
    else {
      console.log('[intel] Discord report posted');
      const mcUrl = process.env['MISSION_CONTROL_URL'];
      const mcSecret = process.env['MISSION_CONTROL_SECRET'];
      if (mcUrl) {
        const intelEvent = {
          id: crypto.randomUUID(),
          type: 'intel_run',
          ts: Date.now(),
          meta: {
            critical: tierCounts.critical,
            high: tierCounts.high,
            medium: tierCounts.medium,
            low: tierCounts.low,
            hubCount,
            backfillDone: done,
            backfillTotal: total,
            backfillPct: pct,
            topProfiles: top.map(p => ({
              externalProfileId: p.externalProfileId,
              score: parseFloat(p.totalScore ?? '0'),
              riskTier: p.riskTier,
            })),
          },
        };
        const mcHeaders: Record<string, string> = { 'Content-Type': 'application/json' };
        if (mcSecret) mcHeaders['Authorization'] = `Bearer ${mcSecret}`;
        try {
          await fetch(mcUrl, { method: 'POST', headers: mcHeaders, body: JSON.stringify(intelEvent) });
          console.log('[intel] MC intel_run event emitted');
        } catch (mcErr) {
          console.error('[intel] MC emit failed:', mcErr);
        }
      }
    }
  } catch (err) {
    console.error('[intel] Discord post error:', err);
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────
async function runOnce() {
  const database = getDb();
  const start = Date.now();
  console.log(`[intel] Run started at ${new Date().toISOString()}`);
  try {
    const cexSet     = await loadCexAddresses(database);
    const hubCount   = await runFundingHubAnalysis(database, cexSet);
    const tierCounts = await runProfileScoring(database, cexSet);
    await postDiscordReport(database, hubCount, tierCounts);
    console.log(`[intel] Run complete in ${((Date.now() - start) / 1000).toFixed(1)}s`);
  } catch (err) {
    console.error('[intel] Run failed:', err);
  }
}

async function main() {
  console.log(`[intel] Intel daemon starting — interval ${RUN_INTERVAL_MS / 60000}min`);
  await runOnce();
  setInterval(runOnce, RUN_INTERVAL_MS);
}

main().catch(err => { console.error('[intel] Fatal:', err); process.exit(1); });
