import { randomUUID } from 'crypto';

// ---------------------------------------------------------------------------
// H7 — In-memory task registry for long-running async operations.
// Tasks expire after TASK_TTL_MS (1 hour) and are cleaned up automatically.
// ---------------------------------------------------------------------------

export type TaskStatus = 'accepted' | 'running' | 'done' | 'error';

export interface Task {
  taskId: string;
  status: TaskStatus;
  startedAt: Date;
  finishedAt?: Date;
  result?: unknown;
  error?: string;
}

const TASK_TTL_MS = 60 * 60 * 1000; // 1 hour

const tasks = new Map<string, Task>();

/**
 * Create a new task, fire the work function in the background, and return the taskId.
 */
export function createTask(work: () => Promise<unknown>): string {
  const taskId = randomUUID();
  const task: Task = {
    taskId,
    status: 'running',
    startedAt: new Date(),
  };
  tasks.set(taskId, task);

  // Fire-and-forget — errors are captured in the task record
  work()
    .then((result) => {
      const t = tasks.get(taskId);
      if (t) {
        t.status = 'done';
        t.finishedAt = new Date();
        t.result = result;
      }
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`[taskRegistry] task ${taskId} failed:`, err);
      const t = tasks.get(taskId);
      if (t) {
        t.status = 'error';
        t.finishedAt = new Date();
        t.error = message;
      }
    });

  // Schedule cleanup after TTL
  setTimeout(() => {
    tasks.delete(taskId);
  }, TASK_TTL_MS);

  return taskId;
}

export function getTask(taskId: string): Task | null {
  return tasks.get(taskId) ?? null;
}
