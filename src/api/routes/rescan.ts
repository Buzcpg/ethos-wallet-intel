import { Hono } from 'hono';
import { z } from 'zod';
import { isValidChain, CHAIN_SLUGS } from '../../chains/index.js';
import type { ChainSlug } from '../../chains/index.js';
import { WalletScanner } from '../../scanner/walletScanner.js';
import { RescanOrchestrator } from '../../scanner/rescanOrchestrator.js';
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

const scheduleSchema = z.object({
  chain: z
    .string()
    .refine(isValidChain, { message: 'Invalid chain' })
    .optional(),
  force: z.boolean().default(false),
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

// ---------------------------------------------------------------------------
// POST /rescan/schedule — enqueue delta jobs for wallets due for rescan
// ---------------------------------------------------------------------------

rescan.post('/schedule', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = scheduleSchema.safeParse(body ?? {});
  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }
  const { chain, force } = parsed.data;
  const orchestrator = new RescanOrchestrator();

  if (chain) {
    const { enqueued } = await orchestrator.scheduleRescan(chain as ChainSlug, { force });
    return c.json({ chain, enqueued });
  }

  const results = await orchestrator.scheduleAllChains({ force });
  const totalEnqueued = Object.values(results).reduce((sum, n) => sum + n, 0);
  return c.json({ results, totalEnqueued });
});

// ---------------------------------------------------------------------------
// POST /rescan/sync-profiles
// H7 — Long-running: returns 202 immediately; poll GET /tasks/:taskId for results.
// ---------------------------------------------------------------------------

rescan.post('/sync-profiles', async (c) => {
  const taskId = createTask(async () => {
    const orchestrator = new RescanOrchestrator();
    return orchestrator.syncNewProfiles();
  });

  return c.json({ taskId, status: 'accepted' }, 202);
});

// ---------------------------------------------------------------------------
// GET /rescan/due-count — count wallets due for rescan per chain
// ---------------------------------------------------------------------------

rescan.get('/due-count', async (c) => {
  const orchestrator = new RescanOrchestrator();
  const counts = await orchestrator.getDueCounts();
  const total = Object.values(counts).reduce((sum, n) => sum + n, 0);
  return c.json({ counts, total });
});

export default rescan;
