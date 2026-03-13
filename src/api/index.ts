import { Hono } from 'hono';
import { logger } from 'hono/logger';
import { env } from '../config/env.js';
import healthRoutes from './routes/health.js';
import statusRoutes from './routes/status.js';
import jobRoutes from './routes/jobs.js';
import scannerRoutes from './routes/scanner.js';
import rescanRoutes from './routes/rescan.js';
import tasksRoutes from './routes/tasks.js';

const app = new Hono();

app.use('*', logger());

// C2/H10 — Bearer token auth on all non-health routes.
// If WEBHOOK_SECRET is not set, log a startup warning but allow all requests
// (backwards-compatible with dev setups).
if (!env.WEBHOOK_SECRET) {
  console.warn('[api] WEBHOOK_SECRET not set — all routes are unauthenticated (dev mode)');
}

app.use('*', async (c, next) => {
  // Skip auth for health checks
  if (c.req.path === '/health' || c.req.path.startsWith('/health/')) {
    return next();
  }

  if (!env.WEBHOOK_SECRET) {
    return next(); // dev mode — no secret configured
  }

  const authHeader = c.req.header('Authorization');
  if (!authHeader || authHeader !== `Bearer ${env.WEBHOOK_SECRET}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  return next();
});

app.route('/health', healthRoutes);
app.route('/status', statusRoutes);
app.route('/jobs', jobRoutes);
app.route('/scanner', scannerRoutes);
app.route('/rescan', rescanRoutes);
app.route('/tasks', tasksRoutes);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error('[api] unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
