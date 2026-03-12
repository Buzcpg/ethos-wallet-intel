import type { Config } from 'drizzle-kit';

export default {
  schema: [
    './src/db/schema/profiles.ts',
    './src/db/schema/wallets.ts',
    './src/db/schema/jobs.ts',
    './src/db/schema/signals.ts',
    './src/db/schema/labels.ts',
    './src/db/schema/matches.ts',
  ],
  out: './src/db/migrations',
  dialect: 'postgresql',
  dbCredentials: {
    url: process.env['DATABASE_URL'] ?? '',
  },
} satisfies Config;
