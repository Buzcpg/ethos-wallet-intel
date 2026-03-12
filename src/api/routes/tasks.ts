import { Hono } from 'hono';
import { getTask } from '../taskRegistry.js';

const tasks = new Hono();

/**
 * GET /tasks/:taskId
 * Returns the current status of a background task.
 */
tasks.get('/:taskId', (c) => {
  const taskId = c.req.param('taskId');

  // Basic UUID format check
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(taskId)) {
    return c.json({ error: 'Invalid taskId format' }, 400);
  }

  const task = getTask(taskId);
  if (!task) {
    return c.json({ error: 'Task not found (may have expired)' }, 404);
  }

  return c.json({
    taskId: task.taskId,
    status: task.status,
    startedAt: task.startedAt.toISOString(),
    finishedAt: task.finishedAt?.toISOString() ?? null,
    result: task.result ?? null,
    error: task.error ?? null,
  });
});

export default tasks;
