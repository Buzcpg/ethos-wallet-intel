/**
 * Global token bucket rate limiter for the Blockscout PRO API.
 *
 * The PRO free tier allows 5 RPS TOTAL across all chains combined.
 * This module exposes a single shared bucket that all fetchers must
 * acquire from before firing an HTTP request.
 *
 * Bucket parameters:
 *   - Capacity: 5 tokens (max burst)
 *   - Refill rate: 5 tokens / second (one token every 200 ms)
 *
 * Usage:
 *   import { acquireToken } from '../lib/rateLimiter.js';
 *   await acquireToken();
 *   const resp = await fetch(url);
 */

const MAX_TOKENS = 5;
const REFILL_INTERVAL_MS = 200; // 1000 / 5 = one token every 200 ms

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
    lastRefillTime += newTokens * REFILL_INTERVAL_MS; // don't lose fractional time
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
      // Wait for the next token slot
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
