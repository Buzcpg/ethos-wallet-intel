import { Hono } from 'hono';
import { createRequire } from 'module';
import { checkDbConnection } from '../../db/client.js';
import { isRunning } from '../../workers/index.js';
import { getQueueCounts } from '../../queue/index.js';
import { env } from '../../config/env.js';
import { CHAIN_SLUGS } from '../../chains/index.js';

const require = createRequire(import.meta.url);
// eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
const pkg = require('../../../package.json') as { version: string };

const status = new Hono();

status.get('/', async (c) => {
  const [dbOk, queue] = await Promise.all([
    checkDbConnection(),
    getQueueCounts(),
  ]);

  return c.json({
    version: pkg.version,
    db: dbOk ? 'connected' : 'disconnected',
    worker: {
      running: isRunning(),
      pollIntervalMs: env.WORKER_POLL_INTERVAL_MS,
    },
    queue,
    chains: CHAIN_SLUGS,
  });
});

export default status;
