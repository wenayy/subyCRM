import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

if (!process.env.REDIS_URL) {
  console.warn("[redis] REDIS_URL not set — using localhost:6379. Add REDIS_URL in Railway Variables.");
} else {
  console.log("[redis] REDIS_URL:", REDIS_URL.replace(/:([^:@]+)@/, ":***@"));
}

declare const globalThis: { __redis?: IORedis };

const tlsOptions = REDIS_URL.startsWith("rediss://") ? { tls: { rejectUnauthorized: false } } : {};

export const redis: IORedis =
  globalThis.__redis ??
  (globalThis.__redis = new IORedis(REDIS_URL, {
    maxRetriesPerRequest: null,
    // Exponential backoff capped at 30s, stop logging after first failure
    retryStrategy: (times: number) => {
      if (times === 1) console.error("[redis] Cannot connect to Redis. Set REDIS_URL in Railway Variables.");
      return Math.min(times * 500, 30_000);
    },
    ...tlsOptions,
  }));

// Cast to any: BullMQ bundles its own ioredis copy, causing TS structural type mismatch.
// Runtime behavior is identical — same connection instance.
export const redisConnection = { connection: redis as any };
