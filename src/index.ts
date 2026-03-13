import 'dotenv/config';
import { serve } from '@hono/node-server';
import { env } from './config/env.js';
import { checkDbConnection, closeDb } from './db/client.js';
import { startWorker, stopWorker } from './workers/index.js';
import app from './api/index.js';

async function main() {
  console.log(`[boot] ethos-wallet-intel starting (${env.NODE_ENV})`);

  // Verify DB connection
  const dbOk = await checkDbConnection();
  if (!dbOk) {
    console.error('[boot] ❌ Failed to connect to database. Check DATABASE_URL.');
    process.exit(1);
  }
  console.log('[boot] ✅ Database connected');

  // Start background worker
  startWorker();

  // Start HTTP server
  const server = serve({
    fetch: app.fetch,
    port: env.PORT,
  });

  console.log(`[boot] ✅ HTTP server listening on port ${env.PORT}`);

  // Graceful shutdown
  const shutdown = async (signal: string) => {
    console.log(`[boot] ${signal} received — shutting down`);
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
