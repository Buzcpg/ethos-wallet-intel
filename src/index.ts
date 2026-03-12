import 'dotenv/config';
import { serve } from '@hono/node-server';
import { env } from './config/env.js';
import { checkDbConnection, closeDb } from './db/client.js';
import { startWorker, stopWorker } from './workers/index.js';
import app from './api/index.js';
import { RescanOrchestrator } from './scanner/rescanOrchestrator.js';
import { LabelResolver } from './labels/labelResolver.js';

async function main() {
  console.log(`[boot] ethos-wallet-intel starting (${env.NODE_ENV})`);

  // Verify DB connection
  const dbOk = await checkDbConnection();
  if (!dbOk) {
    console.error('[boot] ❌ Failed to connect to database. Check DATABASE_URL.');
    process.exit(1);
  }
  console.log('[boot] ✅ Database connected');

  // Seed CEX label list on startup
  const labelResolver = new LabelResolver();
  await labelResolver.seedFromStaticList().catch((err: unknown) => {
    console.warn('[boot] label seed failed (non-fatal):', err);
  });
  console.log('[boot] ✅ CEX label seed complete');

  // Start background worker
  startWorker();

  // New-profile probe cron — runs every 30 minutes
  // Probes IDs forward from highest known profile ID, stops after NEW_USER_PROBE_MAX_MISSES misses
  const orchestrator = new RescanOrchestrator();
  const NEW_PROFILE_POLL_MS = 30 * 60 * 1000; // 30 minutes

  const runNewProfileProbe = () => {
    orchestrator.syncNewProfiles()
      .then(({ newProfiles, highestIdProbed }) => {
        if (newProfiles > 0) {
          console.info(`[cron] new-profile probe: found ${newProfiles} new profiles (highest ID probed: ${highestIdProbed})`);
        }
      })
      .catch((err: unknown) => {
        console.warn('[cron] new-profile probe failed:', err);
      });
  };

  // Run once at startup (catches profiles added since last service restart)
  runNewProfileProbe();
  const newProfileInterval = setInterval(runNewProfileProbe, NEW_PROFILE_POLL_MS);
  console.log('[boot] ✅ New-profile probe cron started (every 30 min)');

  // Start HTTP server
  const server = serve({
    fetch: app.fetch,
    port: env.PORT,
  });

  console.log(`[boot] ✅ HTTP server listening on port ${env.PORT}`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[boot] ${signal} received — shutting down`);
    clearInterval(newProfileInterval);
    stopWorker();
    await closeDb();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((err) => {
  console.error('[boot] fatal error:', err);
  process.exit(1);
});
