/**
 * Global token bucket rate limiter for the Alchemy API.
 *
 * Alchemy free tier: 330 CU/sec. Each alchemy_getAssetTransfers call ≈ 150 CU.
 * Conservative cap: 2 calls/sec (300 CU/sec, leaves ~10% headroom).
 *
 * Bucket parameters:
 *   - Capacity: 2 tokens (max burst)
 *   - Refill rate: 2 tokens / second (one token every 500 ms)
 *
 * Usage:
 *   import { acquireToken } from '../lib/rateLimiter.js';
 *   await acquireToken();
 *   const resp = await fetch(url);
 */

const MAX_TOKENS = 2;
const REFILL_INTERVAL_MS = 500; // 1000 / 2 = one token every 500 ms

let tokens = MAX_TOKENS;
let lastRefillTime = Date.now();

// FIFO queue of pending waiters
const resolveQueue: Array<() => void> = [];
let processingQueue = false;

/** Refill tokens proportional to elapsed time since last refill. */
function refillTokens(): void {
  const now = Date.now();
  const elapsed = now - lastRefillTime;
  const newTokens = Math.floor(elapsed / REFILL_INTERVAL_MS);
  if (newTokens > 0) {
    tokens = Math.min(MAX_TOKENS, tokens + newTokens);
    lastRefillTime += newTokens * REFILL_INTERVAL_MS;
  }
}

/**
 * Drain the queue: dispatch waiters one-by-one as tokens become available.
 * Only one instance of this loop runs at a time.
 */
async function processQueue(): Promise<void> {
  if (processingQueue) return;
  processingQueue = true;

  while (resolveQueue.length > 0) {
    refillTokens();

    if (tokens >= 1) {
      tokens -= 1;
      const resolve = resolveQueue.shift()!;
      resolve();
    } else {
      const msUntilNext = REFILL_INTERVAL_MS - (Date.now() - lastRefillTime) + 1;
      await new Promise<void>((r) => setTimeout(r, Math.max(10, msUntilNext)));
    }
  }

  processingQueue = false;
}

/**
 * Acquire one token from the global rate limiter.
 * Resolves as soon as a token is available. Callers are served in FIFO order.
 */
export function acquireToken(): Promise<void> {
  return new Promise<void>((resolve) => {
    resolveQueue.push(resolve);
    void processQueue();
  });
}

/**
 * Reset the bucket to full capacity (useful in tests).
 */
export function resetBucket(): void {
  tokens = MAX_TOKENS;
  lastRefillTime = Date.now();
  resolveQueue.length = 0;
  processingQueue = false;
}
