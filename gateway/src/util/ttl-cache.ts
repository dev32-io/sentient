/**
 * TTL cache with stale-on-miss accessor.
 *
 * Used by catalog endpoints (OpenRouter models, Ollama models) to keep
 * slow / rate-limited upstream responses warm. `get` returns the
 * value only within the TTL window; `getStale` returns the last value ever
 * stored regardless of expiry, so callers can prefer fresh and fall back
 * to stale on upstream error.
 */

interface Entry<T> {
  value: T;
  expiresAt: number;
}

export interface TtlCache<T> {
  get(key: string): T | undefined;
  getStale(key: string): T | undefined;
  set(key: string, value: T, ttlMs: number): void;
  clear(): void;
}

export interface TtlCacheOptions {
  now?: () => number;
}

export function createTtlCache<T>(opts: TtlCacheOptions = {}): TtlCache<T> {
  const now = opts.now ?? Date.now;
  const map = new Map<string, Entry<T>>();
  return {
    get(key) {
      const entry = map.get(key);
      if (entry === undefined) return undefined;
      if (now() >= entry.expiresAt) return undefined;
      return entry.value;
    },
    getStale(key) {
      return map.get(key)?.value;
    },
    set(key, value, ttlMs) {
      map.set(key, { value, expiresAt: now() + ttlMs });
    },
    clear() {
      map.clear();
    },
  };
}
