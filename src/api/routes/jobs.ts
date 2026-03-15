import { Hono } from 'hono';
import { z } from 'zod';
import { enqueueJob, getJob } from '../../queue/index.js';
import { isValidChain } from '../../chains/index.js';

const jobs = new Hono();

const backfillSchema = z.object({
  walletId: z.string().uuid(),
  chain: z.string().refine(isValidChain, { message: 'Invalid chain' }),
});

const scanWalletSchema = z.object({
  walletId: z.string().uuid(),
  chain: z.string().refine(isValidChain, { message: 'Invalid chain' }),
  type: z.enum(['manual', 'delta', 'backfill']).default('manual'),
});

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

jobs.get('/:id', async (c) => {
  const id = c.req.param('id');

  if (!UUID_RE.test(id)) {
    return c.json({ error: 'Invalid job ID — must be a UUID' }, 400);
  }

  const job = await getJob(id);

  if (!job) {
    return c.json({ error: 'Job not found' }, 404);
  }

  return c.json(job);
});

jobs.post('/backfill', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = backfillSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { walletId, chain } = parsed.data;
  const job = await enqueueJob(walletId, chain, 'backfill');
  return c.json({ jobId: job.id }, 201);
});

jobs.post('/scan-wallet', async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = scanWalletSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const { walletId, chain, type } = parsed.data;
  const job = await enqueueJob(walletId, chain, type);
  return c.json({ jobId: job.id }, 201);
});

export default jobs;
