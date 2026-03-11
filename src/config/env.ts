import 'dotenv/config';
import { z } from 'zod';

const envSchema = z.object({
  DATABASE_URL: z.string().min(1, 'DATABASE_URL is required'),
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z.enum(['development', 'production', 'test']).default('development'),
  LOG_LEVEL: z.enum(['debug', 'info', 'warn', 'error']).default('info'),
  WORKER_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(5000),
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
  // Scanner settings
  SCANNER_CONCURRENCY: z.coerce.number().int().positive().default(5),
  SCANNER_DELAY_MS: z.coerce.number().int().nonnegative().default(200),
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
