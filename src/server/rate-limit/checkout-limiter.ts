/**
 * Checkout rate limiter — FR-5, Section 7.2
 *
 * Database-backed via the RateLimitBucket model, incremented with a
 * single atomic UPDATE ... RETURNING statement (AGENTS.md Section 2).
 * Never an in-memory counter, never a read-then-write. The counter
 * lives in the same PostgreSQL the rest of the system uses, so it
 * stays correct across concurrent requests and multiple instances.
 *
 * 10 requests per minute per authenticated user (illustrative placeholder).
 */

import { prisma } from "@/server/db/prisma";

const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_SECONDS = 60; // 1 minute

// Key format is load-bearing: it must stay "checkout:{userId}" across
// all call sites (schema RateLimitBucket comment, AGENTS.md Section 2).
const bucketKey = (userId: string): string => `checkout:${userId}`;

export interface RateLimitResult {
  allowed: boolean;
  currentCount: number;
  limit: number;
  windowResetAt: Date;
}

/**
 * Check and increment the rate limit for checkout initiation.
 *
 * One atomic UPDATE...RETURNING does the increment; it returns zero rows
 * when no bucket exists yet or the current window has rolled over, in
 * which case a fresh window is opened (count 1). Row creation/refresh
 * and the increment stay non-overlapping so two concurrent requests
 * can never both observe the same count.
 */
export async function checkCheckoutRateLimit(
  userId: string
): Promise<RateLimitResult> {
  const now = new Date();
  const windowStartMs =
    Math.floor(now.getTime() / (RATE_LIMIT_WINDOW_SECONDS * 1000)) *
    (RATE_LIMIT_WINDOW_SECONDS * 1000);
  const windowStart = new Date(windowStartMs);
  const windowResetAt = new Date(windowStartMs + RATE_LIMIT_WINDOW_SECONDS * 1000);

  // FR-5: key stays stable for the user; the window is tracked by
  // windowStart on the bucket itself, so we never key on the window.
  const key = bucketKey(userId);

  try {
    const count = await prisma.$queryRaw<{ count: number }[]>`
      UPDATE "RateLimitBucket"
      SET count = count + 1
      WHERE key = ${key} AND "windowStart" = ${windowStart}
      RETURNING count
    `;

    let currentCount: number;
    const [incremented] = count;
    if (incremented) {
      currentCount = incremented.count;
    } else {
      // Fresh window — single atomic upsert so concurrent callers with
      // an expired/missing bucket race safely and only one lands at 1.
      const upserted = await prisma.rateLimitBucket.upsert({
        where: { key },
        update: {
          count: { set: 1 },
          windowStart,
        },
        create: {
          key,
          count: 1,
          windowStart,
        },
        select: { count: true },
      });
      currentCount = upserted.count;
    }

    return {
      allowed: currentCount <= RATE_LIMIT_MAX,
      currentCount,
      limit: RATE_LIMIT_MAX,
      windowResetAt,
    };
  } catch (err) {
    // Fail closed: an unavailable rate-limit store blocks the request
    // rather than letting unbounded traffic reach Paystack, but the
    // ingestion error is still surfaced so the operator sees it.
    console.error(
      "Checkout rate limiting failed; failing closed to protect endpoint:",
      err
    );
    return {
      allowed: false,
      currentCount: RATE_LIMIT_MAX + 1,
      limit: RATE_LIMIT_MAX,
      windowResetAt,
    };
  }
}