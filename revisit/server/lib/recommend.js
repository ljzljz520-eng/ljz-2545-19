'use strict';
// 依赖推荐 + 标签化缓存失效
// 推荐结果依赖：路线版本、覆盖事件、附件、冲突；任一变化 -> 标签版本前进 -> 旧缓存失效
const { computeValidity } = require('./coverage');
const clock = require('./clock');

const TAG_DEPS = {
  routes: 'routes',
  events: 'events',
  attachments: 'attachments',
  geometry: 'routes' // 改线作用于 routes 标签
};

class RecommendCache {
  constructor() {
    this.tags = { routes: 0, events: 0, attachments: 0 };
    this.entries = new Map(); // key -> {snapshot, value, at}
  }

  bump(collection) {
    const tag = TAG_DEPS[collection];
    if (tag) this.tags[tag]++;
  }

  _snapshot() {
    return { ...this.tags };
  }

  static _same(a, b) {
    return a.routes === b.routes && a.events === b.events && a.attachments === b.attachments;
  }

  get(key, loader) {
    const snap = this._snapshot();
    const hit = this.entries.get(key);
    if (hit && RecommendCache._same(hit.snapshot, snap)) {
      return { value: hit.value, cached: true, at: hit.at };
    }
    const value = loader();
    this.entries.set(key, { snapshot: snap, value, at: clock.now().getTime() });
    return { value, cached: false, at: clock.now().getTime() };
  }

  stats() {
    return { tags: { ...this.tags }, entries: this.entries.size };
  }
}

const cache = new RecommendCache();

// 给某人推荐“最该回访的路线”：超期 > 未覆盖 > 即将到期
function recommendFor(store, personId, opts = {}) {
  const refMs = opts.refMs ?? clock.now().getTime();
  return cache.get(`rec:${personId}:${opts.model || 'default'}`, () => {
    const rows = store.db.routes.map(route => {
      const v = computeValidity(store, route, { refMs, model: opts.model });
      let urgency;
      if (v.status === 'expired') urgency = 0;
      else if (v.status === 'uncovered') urgency = 1;
      else urgency = 2 + (v.expiredMs ? (v.expiredMs - refMs) / (v.validityDays * 86400e3) : 1);
      return {
        routeId: route.routeId, name: route.name, status: v.status,
        fraction: v.fraction, lastCoveredMs: v.lastCoveredMs, expiredMs: v.expiredMs,
        model: v.model, urgency
      };
    }).sort((a, b) => a.urgency - b.urgency || a.routeId.localeCompare(b.routeId));
    return { generatedAt: refMs, personId, items: rows };
  });
}

module.exports = { cache, recommendFor };
