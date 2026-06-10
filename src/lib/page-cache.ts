// Module-level cache that survives React unmount/remount during navigation.
// Stale-while-revalidate: return cached data immediately, refresh in background.

const store = new Map<string, { data: unknown; ts: number }>();

export function getCached<T>(key: string, maxAgeMs = 60_000): T | null {
  const entry = store.get(key);
  if (!entry) return null;
  if (Date.now() - entry.ts > maxAgeMs) return null;
  return entry.data as T;
}

export function setCached(key: string, data: unknown) {
  store.set(key, { data, ts: Date.now() });
}

export function invalidateCache(key: string) {
  store.delete(key);
}

export function clearAllCache() {
  store.clear();
}
