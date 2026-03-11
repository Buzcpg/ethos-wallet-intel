import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { isValidChain, CHAIN_SLUGS } from '../../chains/index.js';
import type { ChainSlug } from '../../chains/index.js';
import { FirstFunderScanner } from '../../scanner/firstFunderScanner.js';
import { FirstFunderMatcher } from '../../matcher/firstFunderMatcher.js';
import { db as getDb } from '../../db/client.js';
import { wallets, firstFunderSignals, walletMatches } from '../../db/schema/index.js';

const scanner = new Hono();

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

// GET /scanner/stats
scanner.get('/stats', async (c) => {
  const database = getDb();

  const countRows = async (query: ReturnType<typeof sql>): Promise<number> => {
    const result = await database.execute<{ count: string }>(query);
    const row = result.rows[0];
    return parseInt(row?.count ?? '0', 10);
  };

  const chains: Record<string, {
    totalWallets: number;
    scanned: number;
    withFirstFunder: number;
    matches: number;
  }> = {};

  for (const chain of CHAIN_SLUGS) {
    const [total, scanned, withFirstFunder, matches] = await Promise.all([
      countRows(sql`SELECT count(*)::text AS count FROM ${wallets} WHERE chain = ${chain}`),
      countRows(sql`SELECT count(*)::text AS count FROM ${wallets} WHERE chain = ${chain} AND last_scanned_at IS NOT NULL`),
      countRows(sql`SELECT count(*)::text AS count FROM ${firstFunderSignals} WHERE chain = ${chain}`),
      countRows(sql`SELECT count(*)::text AS count FROM ${walletMatches} WHERE chain = ${chain}`),
    ]);

    chains[chain] = { totalWallets: total, scanned, withFirstFunder, matches };
  }

  return c.json({ chains });
});

export default scanner;
