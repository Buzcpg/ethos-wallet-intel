import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { isValidChain, CHAIN_SLUGS } from '../../chains/index.js';
import type { ChainSlug } from '../../chains/index.js';
import { FirstFunderScanner } from '../../scanner/firstFunderScanner.js';
import { FirstFunderMatcher } from '../../matcher/firstFunderMatcher.js';
import { WalletScanner } from '../../scanner/walletScanner.js';
import { LabelResolver } from '../../labels/labelResolver.js';
import { db as getDb } from '../../db/client.js';
import {
  wallets,
  firstFunderSignals,
  walletMatches,
  depositTransferEvidence,
} from '../../db/schema/index.js';

const scanner = new Hono();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const scanWalletSchema = z.object({
  walletId: z.string().uuid(),
  chain: z.string().refine(isValidChain, { message: 'Invalid chain' }),
});

const scanBatchSchema = z.object({
  chain: z.string().refine(isValidChain, { message: 'Invalid chain' }),
  limit: z.coerce.number().int().positive().default(50),
});

const detectMatchesSchema = z.object({
  chain: z
    .string()
    .refine(isValidChain, { message: 'Invalid chain' })
    .optional(),
});

const labelResolveSchema = z.object({
  address: z.string().min(1),
  chain: z.string().refine(isValidChain, { message: 'Invalid chain' }),
});

// ---------------------------------------------------------------------------
// Legacy first-funder-only scan routes (preserved for backward compat)
// ---------------------------------------------------------------------------

// POST /scanner/scan-wallet
scanner.post('/scan-wallet', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = scanWalletSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const { walletId, chain } = parsed.data;
  const svc = new FirstFunderScanner();
  const result = await svc.scanWallet(walletId, chain as ChainSlug);
  return c.json(result);
});

// POST /scanner/scan-batch
scanner.post('/scan-batch', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = scanBatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const { chain, limit } = parsed.data;
  const svc = new FirstFunderScanner();
  const walletIds = await svc.getUnscannedWallets(chain as ChainSlug, limit);
  if (walletIds.length === 0) {
    return c.json({ scanned: 0, found: 0, skipped: 0, errors: 0, results: [] });
  }
  const result = await svc.scanBatch(walletIds, chain as ChainSlug);
  return c.json(result);
});

// POST /scanner/detect-matches
scanner.post('/detect-matches', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = detectMatchesSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const matcher = new FirstFunderMatcher();
  if (parsed.data.chain) {
    const stats = await matcher.detectMatches(parsed.data.chain as ChainSlug);
    return c.json({ [parsed.data.chain]: stats });
  }
  const stats = await matcher.detectAllChains();
  return c.json(stats);
});

// ---------------------------------------------------------------------------
// M4: Full unified scan routes
// ---------------------------------------------------------------------------

// POST /scanner/full-scan-wallet
scanner.post('/full-scan-wallet', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = scanWalletSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const { walletId, chain } = parsed.data;
  const walletScanner = new WalletScanner();
  const result = await walletScanner.scanWallet(walletId, chain as ChainSlug);
  return c.json(result);
});

// POST /scanner/full-scan-batch
scanner.post('/full-scan-batch', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = scanBatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const { chain, limit } = parsed.data;
  const walletScanner = new WalletScanner();
  const walletIds = await walletScanner.getUnscannedWallets(chain as ChainSlug, limit);
  if (walletIds.length === 0) {
    return c.json({
      chain,
      scanned: 0,
      skipped: 0,
      errors: 0,
      totalTransactionsFetched: 0,
      totalFirstFundersFound: 0,
      totalDepositEvidenceFound: 0,
      totalP2PMatchesFound: 0,
      durationMs: 0,
      results: [],
    });
  }
  const result = await walletScanner.scanBatch(walletIds, chain as ChainSlug);
  return c.json(result);
});

// GET /scanner/deposit-stats
scanner.get('/deposit-stats', async (c) => {
  const database = getDb();

  const countRows = async (query: ReturnType<typeof sql>): Promise<number> => {
    const result = await database.execute<{ count: string }>(query);
    return parseInt(result.rows[0]?.count ?? '0', 10);
  };

  const chains: Record<string, { depositEvidenceCount: number }> = {};
  for (const chain of CHAIN_SLUGS) {
    const count = await countRows(
      sql`SELECT count(*)::text AS count FROM ${depositTransferEvidence} WHERE chain = ${chain}`,
    );
    chains[chain] = { depositEvidenceCount: count };
  }

  return c.json({ chains });
});

// GET /scanner/p2p-stats
scanner.get('/p2p-stats', async (c) => {
  const database = getDb();

  const countRows = async (query: ReturnType<typeof sql>): Promise<number> => {
    const result = await database.execute<{ count: string }>(query);
    return parseInt(result.rows[0]?.count ?? '0', 10);
  };

  const chains: Record<string, { p2pMatchCount: number }> = {};
  for (const chain of CHAIN_SLUGS) {
    const count = await countRows(
      sql`SELECT count(*)::text AS count FROM ${walletMatches} WHERE chain = ${chain} AND match_type = 'direct_wallet_interaction'`,
    );
    chains[chain] = { p2pMatchCount: count };
  }

  return c.json({ chains });
});

// ---------------------------------------------------------------------------
// M4: Label routes
// ---------------------------------------------------------------------------

// POST /labels/seed
scanner.post('/labels/seed', async (c) => {
  const resolver = new LabelResolver();
  await resolver.seedFromStaticList();
  return c.json({ success: true, message: 'Label seed complete (idempotent)' });
});

// POST /labels/resolve
scanner.post('/labels/resolve', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = labelResolveSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const { address, chain } = parsed.data;
  const resolver = new LabelResolver();
  const label = await resolver.resolveLabel(address, chain as ChainSlug);
  if (!label) {
    return c.json({ address, chain, label: null });
  }
  return c.json({ address, chain, label });
});

// ---------------------------------------------------------------------------
// Legacy stats (preserved)
// ---------------------------------------------------------------------------

// GET /scanner/stats
scanner.get('/stats', async (c) => {
  const database = getDb();

  const countRows = async (query: ReturnType<typeof sql>): Promise<number> => {
    const result = await database.execute<{ count: string }>(query);
    return parseInt(result.rows[0]?.count ?? '0', 10);
  };

  const chains: Record<
    string,
    {
      totalWallets: number;
      scanned: number;
      withFirstFunder: number;
      matches: number;
      depositEvidence: number;
      p2pMatches: number;
    }
  > = {};

  for (const chain of CHAIN_SLUGS) {
    const [total, scanned, withFirstFunder, matches, depositEvidenceCount, p2pMatchCount] =
      await Promise.all([
        countRows(sql`SELECT count(*)::text AS count FROM ${wallets} WHERE chain = ${chain}`),
        countRows(
          sql`SELECT count(*)::text AS count FROM ${wallets} WHERE chain = ${chain} AND last_scanned_at IS NOT NULL`,
        ),
        countRows(
          sql`SELECT count(*)::text AS count FROM ${firstFunderSignals} WHERE chain = ${chain}`,
        ),
        countRows(sql`SELECT count(*)::text AS count FROM ${walletMatches} WHERE chain = ${chain}`),
        countRows(
          sql`SELECT count(*)::text AS count FROM ${depositTransferEvidence} WHERE chain = ${chain}`,
        ),
        countRows(
          sql`SELECT count(*)::text AS count FROM ${walletMatches} WHERE chain = ${chain} AND match_type = 'direct_wallet_interaction'`,
        ),
      ]);

    chains[chain] = {
      totalWallets: total,
      scanned,
      withFirstFunder,
      matches,
      depositEvidence: depositEvidenceCount,
      p2pMatches: p2pMatchCount,
    };
  }

  return c.json({ chains });
});

export default scanner;
