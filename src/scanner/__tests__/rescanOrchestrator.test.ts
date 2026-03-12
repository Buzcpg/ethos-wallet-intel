import { describe, it, expect, vi, beforeEach } from 'vitest';
import { RescanOrchestrator } from '../rescanOrchestrator.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

vi.mock('../walletScanner.js', () => ({
  WalletScanner: vi.fn(),
}));

vi.mock('../../queue/index.js', () => ({
  enqueueJob: vi.fn(),
}));

vi.mock('../../config/env.js', () => ({
  env: {
    RESCAN_INTERVAL_HOURS: 24,
    SCANNER_CONCURRENCY: 5,
    ETHOS_API_CONCURRENCY: 20,
    ETHOS_API_SLEEP_MS: 150,
    ETHOS_API_BATCH_SIZE: 100,
    ETHOS_API_MAX_RETRIES: 3,
  },
}));

vi.mock('../../db/client.js', () => ({
  db: vi.fn(),
}));

vi.mock('../../../sync/profileSync.js', () => ({
  ProfileSyncService: vi.fn(),
}));

import { WalletScanner } from '../walletScanner.js';
import { enqueueJob } from '../../queue/index.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CHAIN = 'ethereum' as const;

function makeWalletScanner(walletIds: string[], forceIds?: string[]) {
  return {
    getWalletsDueForRescan: vi.fn().mockImplementation(
      (_chain: string, intervalHours: number) => {
        if (intervalHours === 0) return Promise.resolve(forceIds ?? walletIds);
        return Promise.resolve(walletIds);
      },
    ),
    deltaScanWallet: vi.fn(),
    deltaScanBatch: vi.fn(),
    scanWallet: vi.fn(),
    scanBatch: vi.fn(),
    getUnscannedWallets: vi.fn().mockResolvedValue([]),
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('RescanOrchestrator', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(enqueueJob).mockResolvedValue({
      id: 'job-1',
      walletId: 'w-1',
      chain: CHAIN,
      jobType: 'delta',
      status: 'pending',
      fromBlock: null,
      toBlock: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      startedAt: null,
      finishedAt: null,
      statsJson: null,
      error: null,
    });
  });

  it('enqueues delta jobs for wallets past their rescan interval', async () => {
    const walletIds = ['w-1', 'w-2', 'w-3'];
    vi.mocked(WalletScanner).mockImplementation(
      () => makeWalletScanner(walletIds) as never,
    );

    const orchestrator = new RescanOrchestrator();
    const { enqueued } = await orchestrator.scheduleRescan(CHAIN);

    expect(enqueueJob).toHaveBeenCalledTimes(3);
    for (const id of walletIds) {
      expect(enqueueJob).toHaveBeenCalledWith(id, CHAIN, 'delta', {});
    }
    expect(enqueued).toBe(3);
  });

  it('skips wallets scanned within interval (returns 0 when all up to date)', async () => {
    vi.mocked(WalletScanner).mockImplementation(
      () => makeWalletScanner([]) as never, // nothing due
    );

    const orchestrator = new RescanOrchestrator();
    const { enqueued } = await orchestrator.scheduleRescan(CHAIN);

    expect(enqueueJob).not.toHaveBeenCalled();
    expect(enqueued).toBe(0);
  });

  it('force=true enqueues all wallets regardless of scan recency', async () => {
    const allWallets = ['w-1', 'w-2'];
    const mockScanner = makeWalletScanner([], allWallets);
    vi.mocked(WalletScanner).mockImplementation(() => mockScanner as never);

    const orchestrator = new RescanOrchestrator();
    const { enqueued } = await orchestrator.scheduleRescan(CHAIN, { force: true });

    // force=true should pass intervalHours=0, returning allWallets
    expect(mockScanner.getWalletsDueForRescan).toHaveBeenCalledWith(CHAIN, 0);
    expect(enqueued).toBe(2);
  });

  it('scheduleAllChains returns correct counts per chain', async () => {
    const walletIds = ['w-1'];
    vi.mocked(WalletScanner).mockImplementation(
      () => makeWalletScanner(walletIds) as never,
    );

    const orchestrator = new RescanOrchestrator();
    const results = await orchestrator.scheduleAllChains();

    const chains = Object.keys(results);
    expect(chains.length).toBeGreaterThan(0);
    for (const count of Object.values(results)) {
      expect(count).toBe(1);
    }
  });

  it('returns correct counts from scheduleRescan', async () => {
    const walletIds = ['a', 'b', 'c', 'd', 'e'];
    vi.mocked(WalletScanner).mockImplementation(
      () => makeWalletScanner(walletIds) as never,
    );

    const orchestrator = new RescanOrchestrator();
    const { enqueued } = await orchestrator.scheduleRescan(CHAIN);

    expect(enqueued).toBe(5);
  });
});
