import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
  // H1 — number of jobs to process concurrently per poll tick
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  WEBHOOK_SECRET: z.string().optional(),
  // Ethos API client settings
  ETHOS_API_CONCURRENCY: z.coerce.number().int().positive().default(20),
  ETHOS_API_SLEEP_MS: z.coerce.number().int().nonnegative().default(150),
  ETHOS_API_BATCH_SIZE: z.coerce.number().int().positive().default(100),
  ETHOS_API_MAX_RETRIES: z.coerce.number().int().positive().default(3),
  // Chain API keys (all optional — free tier works, just rate-limited more aggressively)
  ETHERSCAN_API_KEY: z.string().optional(),
  POLYGONSCAN_API_KEY: z.string().optional(),
  SNOWTRACE_API_KEY: z.string().optional(),
  // Supabase — profile ID enumeration (faster than Ethos API pagination)
  SUPABASE_URL: z.string().url().optional(),
  SUPABASE_ANON_KEY: z.string().optional(),
  // Scanner settings
  SCANNER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  SCANNER_DELAY_MS: z.coerce.number().int().nonnegative().default(200),
  // Transaction window scan strategy:
  // Fetch first SCAN_WINDOW_FIRST txs (asc) + last SCAN_WINDOW_LAST txs (desc).
  // Covers early funding signals and recent deposit/P2P activity. Skips the middle.
  // Wallets with a gap are marked partial=true and eligible for overnight deep_scan.
  SCAN_WINDOW_FIRST: z.coerce.number().int().positive().default(100),
  SCAN_WINDOW_LAST:  z.coerce.number().int().positive().default(300),
  // Delay between pages during overnight deep_scan jobs (stay within rate limits)
  DEEP_SCAN_PAGE_DELAY_MS: z.coerce.number().int().nonnegative().default(2000),
  // Delta rescan settings
  // Number of hours between rescans; wallets scanned within this window are skipped
  RESCAN_INTERVAL_HOURS: z.coerce.number().int().positive().default(24),
  // Max consecutive 404s before stopping new profile ID probe (IDs have gaps)
  NEW_USER_PROBE_MAX_MISSES: z.coerce.number().int().positive().default(200),
  // Max pages to fetch in a delta scan (only new transactions since last_scanned_block)
  SCAN_MAX_PAGES_DELTA: z.coerce.number().int().positive().default(10),
});

const parsed = envSchema.safeParse(process.env);

if (!parsed.success) {
  console.error('❌ Invalid environment variables:');
  for (const [field, issues] of Object.entries(parsed.error.flatten().fieldErrors)) {
    console.error(`  ${field}: ${(issues as string[]).join(', ')}`);
  }
  process.exit(1);
}

export const env = parsed.data;
export type Env = typeof env;
