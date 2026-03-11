import { describe, it, expect, vi, beforeEach } from 'vitest';
import { LabelResolver } from '../labelResolver.js';

// ---------------------------------------------------------------------------
// Mock DB helpers
// ---------------------------------------------------------------------------

const DRIZZLE_NAME = Symbol.for('drizzle:Name');
function tableName(t: unknown): string {
  return (t as Record<symbol, string>)[DRIZZLE_NAME] ?? '';
}

interface LabelRow {
  id: string;
  chain: string;
  address: string;
  labelValue: string;
  labelKind: string;
  source: string;
  confidence: string;
}

function makeMockDb(storedLabels: LabelRow[] = []) {
  const labels: LabelRow[] = [...storedLabels];

  const db = {
    _labels: labels,

    select: (_fields: unknown) => ({
      from: (_table: unknown) => ({
        where: (_cond: unknown) => ({
          limit: (_n: number) => Promise.resolve(labels.length > 0 ? [labels[0]] : []),
        }),
      }),
    }),

    insert: (_table: unknown) => ({
      values: (vals: Record<string, unknown>) => {
        labels.push(vals as unknown as LabelRow);
        return Promise.resolve();
      },
    }),
  };

  return db;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('LabelResolver', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('resolves from DB cache first (does not hit seed or Blockscout)', async () => {
    const cachedLabel: LabelRow = {
      id: 'lbl-1',
      chain: 'ethereum',
      address: '0xcached',
      labelValue: 'TestExchange',
      labelKind: 'exchange_hot_wallet',
      source: 'manual',
      confidence: '1.0',
    };
    const db = makeMockDb([cachedLabel]);
    const resolver = new LabelResolver(() => db as never);

    const result = await resolver.resolveLabel('0xcached', 'ethereum');

    expect(result).not.toBeNull();
    expect(result!.labelValue).toBe('TestExchange');
    expect(result!.source).toBe('manual');
    // Should NOT have inserted anything new
    expect(db._labels).toHaveLength(1);
  });

  it('falls back to seed list when not in DB, caches result', async () => {
    const db = makeMockDb([]); // empty DB
    const resolver = new LabelResolver(() => db as never);

    // Known Binance address from seedData
    const binanceAddr = '0x28c6c06298d514db089934071355e5743bf21d60';
    const result = await resolver.resolveLabel(binanceAddr, 'ethereum');

    expect(result).not.toBeNull();
    expect(result!.labelValue).toBe('Binance');
    expect(result!.labelKind).toBe('exchange_hot_wallet');
    expect(result!.source).toBe('seed_list');
    // Should have cached in DB
    expect(db._labels).toHaveLength(1);
    expect(db._labels[0]!.address).toBe(binanceAddr);
  });

  it('returns null for unknown address with no Blockscout match', async () => {
    const db = makeMockDb([]);
    const resolver = new LabelResolver(() => db as never);

    // Mock fetch to return a Blockscout response with no relevant tags
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: 'Some Random EOA',
        public_tags: [],
        private_tags: [],
      }),
    }));

    const result = await resolver.resolveLabel('0xdeadbeefdeadbeefdeadbeefdeadbeef00000001', 'ethereum');
    expect(result).toBeNull();
    expect(db._labels).toHaveLength(0);
  });

  it('caches Blockscout result when exchange tag found', async () => {
    const db = makeMockDb([]);
    const resolver = new LabelResolver(() => db as never);

    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        name: null,
        public_tags: [{ label: 'Binance Hot Wallet', display_name: 'Binance' }],
        private_tags: [],
      }),
    }));

    const result = await resolver.resolveLabel('0xsomeaddr', 'ethereum');
    expect(result).not.toBeNull();
    expect(result!.labelValue).toBe('Binance');
    expect(result!.source).toBe('blockscout');
    expect(result!.labelKind).toBe('exchange_hot_wallet');
    expect(db._labels).toHaveLength(1);
  });

  it('seedFromStaticList inserts seed labels (idempotent)', async () => {
    const db = makeMockDb([]);
    const resolver = new LabelResolver(() => db as never);

    await resolver.seedFromStaticList();
    const firstRun = db._labels.length;
    expect(firstRun).toBeGreaterThan(0);

    // Second call should not add duplicates (DB mock returns the first item always,
    // so simulate idempotency by checking existing before insert)
    // For this mock, the select returns labels[0] if labels.length > 0, so second run skips all
    await resolver.seedFromStaticList();
    expect(db._labels.length).toBe(firstRun); // no new inserts
  });
});
