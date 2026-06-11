import { redis } from "./redis";

export const cache = {
  async get<T>(key: string): Promise<T | null> {
    const val = await redis.get(key);
    if (!val) return null;
    try {
      return JSON.parse(val) as T;
    } catch {
      return null;
    }
  },

  async set(key: string, value: unknown, ttlSeconds = 900): Promise<void> {
    await redis.set(key, JSON.stringify(value), "EX", ttlSeconds);
  },

  async del(key: string): Promise<void> {
    await redis.del(key);
  },

  async invalidateContacts(): Promise<void> {
    const keys = await redis.keys("contacts:*");
    if (keys.length > 0) {
      await redis.del(...keys);
    }
  },
};

export const CACHE_KEYS = {
  contactSummary: (id: string) => `contact:${id}:summary`,
  contactBriefing: (id: string) => `contact:${id}:briefing`,
  suggestions: (userId: string) => `suggestions:${userId}`,
  contactsList: (userId: string, filters: any) => `contacts:list:${userId}:${JSON.stringify(filters)}`,
  contactsStats: (userId: string) => `contacts:stats:${userId}`,
};
