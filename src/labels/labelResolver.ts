import { eq, and } from 'drizzle-orm';
import { type Db, db as getDb } from '../db/client.js';
import { addressLabels } from '../db/schema/index.js';
import type { ChainSlug } from '../chains/index.js';
import { CEX_SEED_LABELS, CEX_KEYWORDS } from './seedData.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AddressLabel {
  address: string;
  chain: ChainSlug;
  labelValue: string;
  labelKind: 'cex_deposit' | 'exchange_hot_wallet' | 'manual' | 'heuristic';
  source: 'etherscan_html' | 'blockscout' | 'manual' | 'seed_list' | 'heuristic';
  confidence: number;
}

// ---------------------------------------------------------------------------
// Blockscout base URLs (must match transactionFetcher.ts, kept local to avoid coupling)
// ---------------------------------------------------------------------------

const BLOCKSCOUT_BASE: Record<string, string> = {
  ethereum: 'https://eth.blockscout.com/api/v2',
  base: 'https://base.blockscout.com/api/v2',
  arbitrum: 'https://arbitrum.blockscout.com/api/v2',
  optimism: 'https://optimism.blockscout.com/api/v2',
  polygon: 'https://polygon.blockscout.com/api/v2',
};

// ---------------------------------------------------------------------------
// LabelResolver
// ---------------------------------------------------------------------------

export class LabelResolver {
  private readonly getDbFn: () => Db;

  constructor(dbFn?: () => Db) {
    this.getDbFn = dbFn ?? getDb;
  }

  /**
   * Resolve a label for an address + chain.
   * Lookup order: 1. DB cache  2. seed data  3. Blockscout tag API
   */
  async resolveLabel(address: string, chain: ChainSlug): Promise<AddressLabel | null> {
    const addr = address.toLowerCase();
    const database = this.getDbFn();

    // 1. DB cache
    const cached = await database
      .select()
      .from(addressLabels)
      .where(and(eq(addressLabels.address, addr), eq(addressLabels.chain, chain)))
      .limit(1);

    if (cached.length > 0) {
      const row = cached[0]!;
      return {
        address: row.address,
        chain: row.chain as ChainSlug,
        labelValue: row.labelValue,
        labelKind: row.labelKind as AddressLabel['labelKind'],
        source: row.source as AddressLabel['source'],
        confidence: parseFloat(row.confidence ?? '1.0'),
      };
    }

    // 2. In-memory seed list
    const seedMatch = CEX_SEED_LABELS.find(
      (s) => s.address.toLowerCase() === addr && s.chain === chain,
    );
    if (seedMatch) {
      const label: AddressLabel = {
        address: addr,
        chain,
        labelValue: seedMatch.label,
        labelKind: seedMatch.kind,
        source: 'seed_list',
        confidence: 1.0,
      };
      await this.cacheLabel(addr, chain, label, database);
      return label;
    }

    // 3. Blockscout tag API (only for chains with a Blockscout instance)
    const blockscoutLabel = await this.fetchBlockscoutLabel(addr, chain);
    if (blockscoutLabel) {
      const label: AddressLabel = {
        address: addr,
        chain,
        labelValue: blockscoutLabel,
        labelKind: 'exchange_hot_wallet',
        source: 'blockscout',
        confidence: 0.9,
      };
      await this.cacheLabel(addr, chain, label, database);
      return label;
    }

    return null;
  }

  /**
   * Seed the DB from CEX_SEED_LABELS (idempotent).
   * Safe to call at startup — uses ON CONFLICT DO NOTHING via upsert.
   */
  /**
   * Seed the DB from CEX_SEED_LABELS (idempotent).
   * Uses a single batch INSERT … ON CONFLICT DO NOTHING to replace the
   * previous N*2 round-trip loop.
   */
  async seedFromStaticList(): Promise<void> {
    if (CEX_SEED_LABELS.length === 0) return;
    const database = this.getDbFn();

    await database
      .insert(addressLabels)
      .values(
        CEX_SEED_LABELS.map((seed) => ({
          chain: seed.chain,
          address: seed.address.toLowerCase(),
          labelValue: seed.label,
          labelKind: seed.kind,
          source: 'seed_list' as const,
          confidence: '1.0',
        })),
      )
      .onConflictDoNothing();
  }

  /**
   * Try to resolve a label via Blockscout's address metadata endpoint.
   * Returns the exchange name if found via public/private tags, null otherwise.
   */
  private async fetchBlockscoutLabel(
    address: string,
    chain: ChainSlug,
  ): Promise<string | null> {
    const baseUrl = BLOCKSCOUT_BASE[chain];
    if (!baseUrl) return null; // chain has no Blockscout instance

    const url = `${baseUrl}/addresses/${address}`;
    let data: BlockscoutAddressResponse;

    try {
      const resp = await fetch(url);
      if (!resp.ok) return null;
      data = (await resp.json()) as BlockscoutAddressResponse;
    } catch {
      return null;
    }

    // Check public tags and private tags
    const allTags: string[] = [
      ...(data.public_tags ?? []).map((t) => t.label ?? t.display_name ?? ''),
      ...(data.private_tags ?? []).map((t) => t.label ?? t.display_name ?? ''),
      data.name ?? '',
    ];

    for (const tag of allTags) {
      const lower = tag.toLowerCase();
      for (const keyword of CEX_KEYWORDS) {
        if (lower.includes(keyword)) {
          // Return the keyword capitalised as the exchange name
          return keyword.charAt(0).toUpperCase() + keyword.slice(1);
        }
      }
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  private async cacheLabel(
    address: string,
    chain: ChainSlug,
    label: AddressLabel,
    database: Db,
  ): Promise<void> {
    try {
      await database.insert(addressLabels).values({
        chain,
        address,
        labelValue: label.labelValue,
        labelKind: label.labelKind,
        source: label.source,
        confidence: label.confidence.toFixed(2),
      });
    } catch {
      // Unique constraint violation (race condition) — safe to ignore
    }
  }
}

// ---------------------------------------------------------------------------
// Blockscout address response types
// ---------------------------------------------------------------------------

interface BlockscoutTag {
  label?: string;
  display_name?: string;
}

interface BlockscoutAddressResponse {
  name?: string;
  public_tags?: BlockscoutTag[];
  private_tags?: BlockscoutTag[];
}
