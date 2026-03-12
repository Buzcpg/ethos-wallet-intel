import { Hono } from 'hono';
import { z } from 'zod';
import { ProfileSyncService } from '../../sync/profileSync.js';
import type { FullSyncOptions } from '../../sync/profileSync.js';
import { createTask } from '../taskRegistry.js';

const sync = new Hono();

const fullSyncSchema = z.object({
  dryRun: z.boolean().optional(),
  batchSize: z.number().int().positive().optional(),
});

/**
 * POST /sync/profiles
 * H7 — Returns 202 Accepted immediately with a taskId.
 * The full profile sync runs in the background; poll GET /tasks/:taskId for results.
 */
sync.post('/profiles', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = fullSyncSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  const opts: FullSyncOptions = {};
  if (parsed.data.dryRun !== undefined) opts.dryRun = parsed.data.dryRun;
  if (parsed.data.batchSize !== undefined) opts.batchSize = parsed.data.batchSize;

  const taskId = createTask(async () => {
    const service = new ProfileSyncService();
    return service.runFullSync(opts);
  });

  return c.json({ taskId, status: 'accepted' }, 202);
});

/**
 * POST /sync/profile/:id
 * Sync a single profile by Ethos profile ID (integer). Synchronous — fast enough.
 */
sync.post('/profile/:id', async (c) => {
  const rawId = c.req.param('id');
  const profileId = parseInt(rawId, 10);

  if (!Number.isInteger(profileId) || profileId <= 0) {
    return c.json({ error: 'Invalid profile ID — must be a positive integer' }, 400);
  }

  const service = new ProfileSyncService();

  try {
    const result = await service.syncProfile(profileId);
    return c.json({ profileId, walletsUpserted: result.walletsUpserted });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error(`[sync] syncProfile(${profileId}) failed:`, err);
    return c.json({ error: 'Sync failed', details: message }, 500);
  }
});

export default sync;
