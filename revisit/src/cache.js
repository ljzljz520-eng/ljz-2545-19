// 依赖推荐缓存：缓存键 + 依赖键(marker / geometry / observation 版本)。
// 标识更新（标识物、几何版本）时提升对应依赖版本，所有依赖它的推荐缓存立即失效。
export class DepCache {
  constructor(store) { this.store = store; }

  _get(key) {
    return this.store.find('depVersions', (d) => d.key === key);
  }
  version(key) {
    const d = this._get(key);
    return d ? d.version : 0;
  }
  bump(key) {
    const d = this._get(key);
    if (d) { d.version += 1; d.at = new Date().toISOString(); }
    else this.store.insert('depVersions', { key, version: 1, at: new Date().toISOString() });
    this.store.persist();
    return this.version(key);
  }

  // deps: { depKey -> 当前版本 }；任一依赖版本变化或缺失即缓存未命中
  get(cacheKey, deps) {
    const entry = this.store.find('cacheEntries', (e) => e.cacheKey === cacheKey);
    if (!entry) return { hit: false, reason: 'no-entry' };
    for (const [k, v] of Object.entries(deps)) {
      if (entry.deps[k] !== v) return { hit: false, reason: `dep:${k}` };
    }
    return { hit: true, value: entry.value, cachedAt: entry.cachedAt };
  }
  set(cacheKey, deps, value) {
    const entry = {
      cacheKey, deps: { ...deps }, value,
      cachedAt: new Date().toISOString(),
    };
    this.store.upsert('cacheEntries', (e) => e.cacheKey === cacheKey, entry);
    this.store.persist();
    return entry;
  }
  stats() {
    const rows = this.store.all('cacheEntries');
    return { entries: rows.length, keys: rows.map((r) => r.cacheKey) };
  }
}
