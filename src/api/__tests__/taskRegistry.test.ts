import { describe, it, expect, vi } from 'vitest';
import { createTask, getTask } from '../taskRegistry.js';

// ---------------------------------------------------------------------------
// H7 — Task registry tests
// ---------------------------------------------------------------------------

describe('taskRegistry (H7)', () => {
  it('createTask returns a UUID-shaped string', () => {
    const id = createTask(async () => 'result');
    expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
  });

  it('task starts in running status immediately after creation', () => {
    const id = createTask(() => new Promise(() => {})); // never resolves
    const task = getTask(id);
    expect(task).not.toBeNull();
    expect(task!.status).toBe('running');
    expect(task!.startedAt).toBeInstanceOf(Date);
    expect(task!.finishedAt).toBeUndefined();
  });

  it('transitions to done when work resolves', async () => {
    const id = createTask(async () => ({ count: 42 }));

    // Flush microtask queue to let the promise chain settle
    await new Promise((r) => setTimeout(r, 10));

    const task = getTask(id)!;
    expect(task.status).toBe('done');
    expect(task.result).toEqual({ count: 42 });
    expect(task.finishedAt).toBeInstanceOf(Date);
    expect(task.error).toBeUndefined();
  });

  it('transitions to error status when work rejects', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const id = createTask(() => Promise.reject(new Error('something went wrong')));

    await new Promise((r) => setTimeout(r, 10));

    const task = getTask(id)!;
    expect(task.status).toBe('error');
    expect(task.error).toBe('something went wrong');
    expect(task.finishedAt).toBeInstanceOf(Date);

    consoleError.mockRestore();
  });

  it('captures non-Error rejection as string', async () => {
    const consoleError = vi.spyOn(console, 'error').mockImplementation(() => {});

    const id = createTask(() => Promise.reject('plain string error'));

    await new Promise((r) => setTimeout(r, 10));

    const task = getTask(id)!;
    expect(task.status).toBe('error');
    expect(task.error).toBe('plain string error');

    consoleError.mockRestore();
  });

  it('getTask returns null for unknown taskId', () => {
    expect(getTask('00000000-0000-0000-0000-000000000000')).toBeNull();
  });

  it('each createTask call returns a unique taskId', () => {
    const id1 = createTask(async () => {});
    const id2 = createTask(async () => {});
    expect(id1).not.toBe(id2);
  });
});
