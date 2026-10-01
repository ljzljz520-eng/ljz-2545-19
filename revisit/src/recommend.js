import { buildCoverage } from './coverage.js';

// 推荐：列出最需要回访的“几何版本-分段”，优先冲突 > 漏段/漂移 > 时间不可信 > 超期，附标识物
export function buildRecommendations(store, nowMs) {
  const versions = store.all('versions').filter((v) => v.active);
  const out = [];
  for (const v of versions) {
    const obs = store.filter('observations', (o) => o.versionId === v.id && o.status !== 'rejected');
    const cov = buildCoverage(v, obs, nowMs);
    cov.segments.forEach((s) => {
      let priority = 0, reason = [];
      if (s.conflict) { priority = Math.max(priority, 100); reason.push('观察冲突'); }
      if (s.status === 'unverified-missing') { priority = Math.max(priority, 70); reason.push('漏段'); }
      if (s.status === 'unverified-drift') { priority = Math.max(priority, 60); reason.push('GPS漂移未核'); }
      if (s.timeState === 'time-unverifiable') { priority = Math.max(priority, 50); reason.push('时间不可信'); }
      if (s.timeState === 'expired') { priority = Math.max(priority, 40); reason.push('超期'); }
      if (s.status === 'none') { priority = Math.max(priority, 30); reason.push('从未回访'); }
      if (priority === 0) return;
      const marker = store.find('markers', (mk) => mk.routeId === v.routeId && mk.segmentIndex === s.segmentIndex);
      out.push({
        routeId: v.routeId, versionId: v.id, segmentIndex: s.segmentIndex,
        priority, reasons: reason,
        marker: marker ? { id: marker.id, label: marker.label, updatedAt: marker.updatedAt || marker.createdAt } : null,
        latestConfirmedAt: s.latestConfirmedAt, dueAt: s.dueAt,
      });
    });
  }
  return out.sort((a, b) => b.priority - a.priority || a.segmentIndex - b.segmentIndex);
}
