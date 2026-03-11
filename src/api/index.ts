import { Hono } from 'hono';
import { logger } from 'hono/logger';
import healthRoutes from './routes/health.js';
import statusRoutes from './routes/status.js';
import jobRoutes from './routes/jobs.js';
import syncRoutes from './routes/sync.js';

const app = new Hono();

app.use('*', logger());

app.route('/health', healthRoutes);
app.route('/status', statusRoutes);
app.route('/jobs', jobRoutes);
app.route('/sync', syncRoutes);

app.notFound((c) => c.json({ error: 'Not found' }, 404));

app.onError((err, c) => {
  console.error('[api] unhandled error:', err);
  return c.json({ error: 'Internal server error' }, 500);
});

export default app;
