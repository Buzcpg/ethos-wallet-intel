import { Hono } from 'hono';
import { z } from 'zod';
import { sql } from 'drizzle-orm';
import { createTask } from '../taskRegistry.js';
import { isValidChain, CHAIN_SLUGS } from '../../chains/index.js';
import type { ChainSlug } from '../../chains/index.js';
import { WalletScanner } from '../../scanner/walletScanner.js';
import { db as getDb } from '../../db/client.js';
import {
  wallets,
  firstFunderSignals,
  walletMatches,
  depositTransferEvidence,
} from '../../db/schema/index.js';

const scanner = new Hono();

const scanWalletSchema = z.object({
  walletId: z.string().uuid(),
  chain: z.string().refine(isValidChain, { message: 'Invalid chain' }),
});

const scanBatchSchema = z.object({
  chain: z.string().refine(isValidChain, { message: 'Invalid chain' }),
  limit: z.coerce.number().int().positive().default(50),
});

// POST /scanner/full-scan-wallet — synchronous single-wallet scan
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

// POST /scanner/full-scan-batch — async batch scan (returns taskId, poll /tasks/:taskId)
scanner.post('/full-scan-batch', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = scanBatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const { chain, limit } = parsed.data;

  const taskId = createTask(async () => {
    const walletScanner = new WalletScanner();
    const walletIds = await walletScanner.getUnscannedWallets(chain as ChainSlug, limit);
    if (walletIds.length === 0) {
      return { chain, scanned: 0, skipped: 0, errors: 0, totalTransactionsFetched: 0,
        totalFirstFundersFound: 0, totalDepositEvidenceFound: 0, totalP2PMatchesFound: 0,
        durationMs: 0, results: [] };
    }
    return walletScanner.scanBatch(walletIds, chain as ChainSlug);
  });

  return c.json({ taskId, status: 'accepted' }, 202);
});

// GET /scanner/stats — coverage overview per chain
scanner.get('/stats', async (c) => {
  const database = getDb();
  const countRows = async (query: ReturnType<typeof sql>): Promise<number> => {
    const result = await database.execute<{ count: string }>(query);
    return parseInt(result.rows[0]?.count ?? '0', 10);
  };

  try {
    const chains: Record<string, {
      totalWallets: number; scanned: number; withFirstFunder: number;
      matches: number; depositEvidence: number; p2pMatches: number;
    }> = {};

    await Promise.all(CHAIN_SLUGS.map(async (chain) => {
      const [total, scanned, withFirstFunder, matches, depositEvidenceCount, p2pMatchCount] =
        await Promise.all([
          countRows(sql`SELECT count(*)::text AS count FROM ${wallets} WHERE chain = ${chain}`),
          countRows(sql`SELECT count(*)::text AS count FROM ${wallets} WHERE chain = ${chain} AND last_scanned_at IS NOT NULL`),
          countRows(sql`SELECT count(*)::text AS count FROM ${firstFunderSignals} WHERE chain = ${chain}`),
          countRows(sql`SELECT count(*)::text AS count FROM ${walletMatches} WHERE chain = ${chain}`),
          countRows(sql`SELECT count(*)::text AS count FROM ${depositTransferEvidence} WHERE chain = ${chain}`),
          countRows(sql`SELECT count(*)::text AS count FROM ${walletMatches} WHERE chain = ${chain} AND match_type = 'direct_wallet_interaction'`),
        ]);
      chains[chain] = { totalWallets: total, scanned, withFirstFunder, matches, depositEvidence: depositEvidenceCount, p2pMatches: p2pMatchCount };
    }));

    return c.json({ chains });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[scanner] stats failed:', err);
    return c.json({ error: 'Failed to fetch stats', details: message }, 500);
  }
});

// GET /scanner/deposit-stats
scanner.get('/deposit-stats', async (c) => {
  const database = getDb();
  const countRows = async (query: ReturnType<typeof sql>): Promise<number> => {
    const result = await database.execute<{ count: string }>(query);
    return parseInt(result.rows[0]?.count ?? '0', 10);
  };

  try {
    const chains: Record<string, { depositEvidenceCount: number }> = {};
    await Promise.all(CHAIN_SLUGS.map(async (chain) => {
      const count = await countRows(sql`SELECT count(*)::text AS count FROM ${depositTransferEvidence} WHERE chain = ${chain}`);
      chains[chain] = { depositEvidenceCount: count };
    }));
    return c.json({ chains });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch deposit stats', details: message }, 500);
  }
});

// GET /scanner/p2p-stats
scanner.get('/p2p-stats', async (c) => {
  const database = getDb();
  const countRows = async (query: ReturnType<typeof sql>): Promise<number> => {
    const result = await database.execute<{ count: string }>(query);
    return parseInt(result.rows[0]?.count ?? '0', 10);
  };

  try {
    const chains: Record<string, { p2pMatchCount: number }> = {};
    await Promise.all(CHAIN_SLUGS.map(async (chain) => {
      const count = await countRows(sql`SELECT count(*)::text AS count FROM ${walletMatches} WHERE chain = ${chain} AND match_type = 'direct_wallet_interaction'`);
      chains[chain] = { p2pMatchCount: count };
    }));
    return c.json({ chains });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return c.json({ error: 'Failed to fetch p2p stats', details: message }, 500);
  }
});

export default scanner;
