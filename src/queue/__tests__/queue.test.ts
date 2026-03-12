import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the db client before importing queue functions
vi.mock('../../db/client.js', () => ({
  db: vi.fn(),
}));

import { db } from '../../db/client.js';
import {
  enqueueJob,
  dequeueNext,
  markDone,
  markFailed,
  getQueueCounts,
  resetStaleJobs,
} from '../index.js';

// ---------------------------------------------------------------------------
// DB mock builders
// ---------------------------------------------------------------------------

function makeInsertReturning(rows: unknown[]) {
  return {
    insert: (_table: unknown) => ({
      values: (_vals: unknown) => ({
        returning: () => Promise.resolve(rows),
      }),
    }),
  };
}

function makeExecute(rows: unknown[]) {
  return {
    execute: (_sql: unknown) => Promise.resolve({ rows }),
  };
}

interface UpdateCapture { vals: Record<string, unknown>[] }

function makeUpdate(): { update: (_t: unknown) => object; _captured: UpdateCapture } {
  const captured: UpdateCapture = { vals: [] };
  return {
    update: (_table: unknown) => ({
      set: (vals: Record<string, unknown>) => ({
        where: (_cond: unknown) => {
          captured.vals.push(vals);
          return Promise.resolve();
        },
      }),
    }),
    _captured: captured,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('queue/index.ts', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // -------------------------------------------------------------------------
  // enqueueJob
  // -------------------------------------------------------------------------

  describe('enqueueJob', () => {
    it('inserts a pending job row and returns it', async () => {
      const job = {
        id: 'job-uuid-1',
        walletId: 'wallet-uuid-1',
        chain: 'ethereum',
        jobType: 'backfill',
        status: 'pending',
        createdAt: new Date(),
      };
      vi.mocked(db).mockReturnValue(makeInsertReturning([job]) as never);

      const result = await enqueueJob('wallet-uuid-1', 'ethereum', 'backfill', {});

      expect(result.id).toBe('job-uuid-1');
      expect(result.status).toBe('pending');
      expect(result.chain).toBe('ethereum');
    });

    it('throws when DB returns no row', async () => {
      vi.mocked(db).mockReturnValue(makeInsertReturning([]) as never);

      await expect(enqueueJob('w', 'ethereum', 'backfill', {})).rejects.toThrow(
        'Failed to enqueue job',
      );
    });
  });

  // -------------------------------------------------------------------------
  // dequeueNext
  // -------------------------------------------------------------------------

  describe('dequeueNext', () => {
    it('returns the dequeued job when one exists', async () => {
      const job = { id: 'job-1', status: 'running', walletId: 'w1', chain: 'ethereum', jobType: 'delta' };
      vi.mocked(db).mockReturnValue(makeExecute([job]) as never);

      const result = await dequeueNext();

      expect(result).not.toBeNull();
      expect(result!.id).toBe('job-1');
    });

    it('returns null when no pending jobs exist', async () => {
      vi.mocked(db).mockReturnValue(makeExecute([]) as never);

      const result = await dequeueNext();

      expect(result).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // markDone
  // -------------------------------------------------------------------------

  describe('markDone', () => {
    it('sets status to done with optional stats', async () => {
      const { update, _captured } = makeUpdate();
      vi.mocked(db).mockReturnValue({ update } as never);

      await markDone('job-id-1', { scanned: 5 });

      expect(_captured.vals[0]).toMatchObject({ status: 'done' });
      expect(_captured.vals[0]!['statsJson']).toEqual({ scanned: 5 });
    });

    it('sets statsJson to null when no stats provided', async () => {
      const { update, _captured } = makeUpdate();
      vi.mocked(db).mockReturnValue({ update } as never);

      await markDone('job-id-2');

      expect(_captured.vals[0]!['statsJson']).toBeNull();
    });
  });

  // -------------------------------------------------------------------------
  // markFailed
  // -------------------------------------------------------------------------

  describe('markFailed', () => {
    it('sets status to failed with the error string', async () => {
      const { update, _captured } = makeUpdate();
      vi.mocked(db).mockReturnValue({ update } as never);

      await markFailed('job-id-3', 'Network timeout after 3 retries');

      expect(_captured.vals[0]).toMatchObject({
        status: 'failed',
        error: 'Network timeout after 3 retries',
      });
    });
  });

  // -------------------------------------------------------------------------
  // getQueueCounts
  // -------------------------------------------------------------------------

  describe('getQueueCounts', () => {
    it('returns counts for all three statuses', async () => {
      const rows = [
        { status: 'pending', count: '7' },
        { status: 'running', count: '2' },
        { status: 'failed', count: '4' },
      ];
      vi.mocked(db).mockReturnValue(makeExecute(rows) as never);

      const counts = await getQueueCounts();

      expect(counts.pending).toBe(7);
      expect(counts.running).toBe(2);
      expect(counts.failed).toBe(4);
    });

    it('returns zeros when no jobs exist', async () => {
      vi.mocked(db).mockReturnValue(makeExecute([]) as never);

      const counts = await getQueueCounts();

      expect(counts).toEqual({ pending: 0, running: 0, failed: 0 });
    });

    it('handles partial status results (missing statuses default to 0)', async () => {
      vi.mocked(db).mockReturnValue(makeExecute([{ status: 'pending', count: '3' }]) as never);

      const counts = await getQueueCounts();

      expect(counts.pending).toBe(3);
      expect(counts.running).toBe(0);
      expect(counts.failed).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // resetStaleJobs (C3)
  // -------------------------------------------------------------------------

  describe('resetStaleJobs (C3)', () => {
    it('returns count of jobs reset', async () => {
      const rows = [{ id: 'stale-1' }, { id: 'stale-2' }, { id: 'stale-3' }];
      vi.mocked(db).mockReturnValue(makeExecute(rows) as never);

      const count = await resetStaleJobs(5 * 60 * 1000);

      expect(count).toBe(3);
    });

    it('returns 0 when no stale jobs exist', async () => {
      vi.mocked(db).mockReturnValue(makeExecute([]) as never);

      const count = await resetStaleJobs(30 * 60 * 1000);

      expect(count).toBe(0);
    });
  });
});
