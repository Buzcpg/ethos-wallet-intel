import { Hono } from 'hono';
import { z } from 'zod';
import { isValidChain } from '../../chains/index.js';
import type { ChainSlug } from '../../chains/index.js';
import { WalletScanner } from '../../scanner/walletScanner.js';
import { createTask } from '../taskRegistry.js';

const rescan = new Hono();

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const deltaWalletSchema = z.object({
  walletId: z.string().uuid(),
  chain: z.string().refine(isValidChain, { message: 'Invalid chain' }),
});

const deltaBatchSchema = z.object({
  chain: z.string().refine(isValidChain, { message: 'Invalid chain' }),
  limit: z.coerce.number().int().positive().default(50),
});

// ---------------------------------------------------------------------------
// POST /rescan/delta-wallet — delta scan a single wallet (synchronous)
// ---------------------------------------------------------------------------

rescan.post('/delta-wallet', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = deltaWalletSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const { walletId, chain } = parsed.data;
  const scanner = new WalletScanner();
  const result = await scanner.deltaScanWallet(walletId, chain as ChainSlug);
  return c.json(result);
});

// ---------------------------------------------------------------------------
// POST /rescan/delta-batch
// H7 — Long-running: returns 202 immediately; poll GET /tasks/:taskId for results.
// ---------------------------------------------------------------------------

rescan.post('/delta-batch', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = deltaBatchSchema.safeParse(body);
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const { chain, limit } = parsed.data;

  const taskId = createTask(async () => {
    const scanner = new WalletScanner();
    const walletIds = await scanner.getWalletsDueForRescan(chain as ChainSlug, 0, limit);
    if (walletIds.length === 0) {
      return {
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
      };
    }
    return scanner.deltaScanBatch(walletIds, chain as ChainSlug);
  });

  return c.json({ taskId, status: 'accepted' }, 202);
});

export default rescan;
