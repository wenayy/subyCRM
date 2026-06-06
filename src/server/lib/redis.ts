import IORedis from "ioredis";

const REDIS_URL = process.env.REDIS_URL || "redis://localhost:6379";

console.log("[redis] REDIS_URL env:", process.env.REDIS_URL ? process.env.REDIS_URL.replace(/:([^:@]+)@/, ":***@") : "NOT SET — using localhost fallback");

declare const globalThis: { __redis?: IORedis };

const tlsOptions = REDIS_URL.startsWith("rediss://") ? { tls: { rejectUnauthorized: false } } : {};

export const redis: IORedis =
  globalThis.__redis ??
  (globalThis.__redis = new IORedis(REDIS_URL, { maxRetriesPerRequest: null, ...tlsOptions }));

export const redisConnection = { connection: redis };
