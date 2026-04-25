// Minimal in-memory cache for provider credential caching (Azure Entra, AWS STS, etc.)
const cache = new Map<string, { value: any; expiresAt: number }>();

class SimpleCache {
  async get<T>(key: string, _options?: any): Promise<T | null> {
    const entry = cache.get(key);
    if (!entry) return null;
    if (Date.now() > entry.expiresAt) {
      cache.delete(key);
      return null;
    }
    return entry.value as T;
  }

  async set(key: string, value: any, options?: { ttl?: number }): Promise<void> {
    const ttl = options?.ttl ?? 300; // default 5 minutes
    cache.set(key, { value, expiresAt: Date.now() + ttl * 1000 });
  }
}

const instance = new SimpleCache();

export function requestCache(_env?: any): SimpleCache {
  return instance;
}
