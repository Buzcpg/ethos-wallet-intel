import { Hono } from 'hono';
import { z } from 'zod';
import { ProfileSyncService } from '../../sync/profileSync.js';
import type { FullSyncOptions } from '../../sync/profileSync.js';

const sync = new Hono();

const fullSyncSchema = z.object({
  dryRun: z.boolean().optional(),
  batchSize: z.number().int().positive().optional(),
});

/**
 * POST /sync/profiles
 * Trigger a full profile sync. Returns SyncStats on completion.
 * Body: { "dryRun"?: boolean, "batchSize"?: number }
 */
sync.post('/profiles', async (c) => {
  const body = await c.req.json().catch(() => ({}));
  const parsed = fullSyncSchema.safeParse(body);

  if (!parsed.success) {
    return c.json({ error: 'Invalid request', details: parsed.error.flatten() }, 400);
  }

  // Build options object without undefined values (exactOptionalPropertyTypes)
  const opts: FullSyncOptions = {};
  if (parsed.data.dryRun !== undefined) opts.dryRun = parsed.data.dryRun;
  if (parsed.data.batchSize !== undefined) opts.batchSize = parsed.data.batchSize;

  const service = new ProfileSyncService();

  try {
    const stats = await service.runFullSync(opts);
    return c.json({ stats });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('[sync] runFullSync failed:', err);
    return c.json({ error: 'Sync failed', details: message }, 500);
  }
});

/**
 * POST /sync/profile/:id
 * Sync a single profile by Ethos profile ID (integer).
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
