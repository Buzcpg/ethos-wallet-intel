import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    env: {
      DATABASE_URL: 'postgresql://postgres:test@localhost:5432/ethos_wallet_intel_test',
      NODE_ENV: 'test',
    },
  },
});
