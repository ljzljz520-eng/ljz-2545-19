'use strict';
// 覆盖计算核心：
// 观察绑定 (人员, 几何版本, 实际覆盖路段[start,end,observedAt])
// 支持带误差轨迹(matchTrack) 与人工范围(rangeToArcs)；漂移/漏段 -> 未核
// 两种有效期模型：wholeRoute（整路线）/ perSegment（分段覆盖）
const geo = require('./geo');

const EPS = 1e-6;

// 取某条路线在 refTime 的“当前几何版本”（改线前补交的旧回访绑定旧版本）
function geometryAt(route, refMs) {
  const versions = route.versions.slice().sort((a, b) => a.effectiveFromMs - b.effectiveFromMs);
  let cur = versions[0];
  for (const v of versions) if (v.effectiveFromMs <= refMs) cur = v;
  return cur;
}

// 把区间裁剪到几何 [0,length]，消除人工范围/数值误差造成的微小超界
function clampIntervals(ivs, len) {
  return ivs.map(i => ({ ...i, start: Math.max(0, Math.min(i.start, len)), end: Math.max(0, Math.min(i.end, len)) }))
    .filter(i => i.end - i.start > EPS);
}

function intervalsFromEvent(ev, coords) {
  const len = geo.polylineLength(coords);
  if (ev.manualRange) {
    const arc = geo.rangeToArcs(ev.manualRange, coords);
    return {
      intervals: clampIntervals([arc], len),
      track: null
    };
  }
  if (ev.track && ev.track.points && ev.track.points.length) {
    const m = geo.matchTrack(ev.track.points, coords, ev.track.toleranceM ?? 30, ev.track.maxGapM ?? 80);
    return { intervals: clampIntervals(m.intervals, len), track: m };
  }
  // 无轨迹也无人工范围：仅点核（观察位置附近 5m）
  const pt = geo.rangeToArcs({ fromCoord: ev.geo, toCoord: ev.geo }, coords);
  const s = pt.start;
  return {
    intervals: clampIntervals([{ start: s - 2.5, end: s + 2.5 }], len),
    track: { pointCount: 1, driftCount: pt.perp > 30 ? 1 : 0, gapCount: 0, gapLength: 0, matchedCount: pt.perp > 30 ? 0 : 1, coveredLen: 5 }
  };
}

// 构建某路线某几何版本（或全部版本）的覆盖状态
function buildCoverage(store, route, opts = {}) {
  const refMs = opts.refMs ?? Date.now();
  const personId = opts.personId ?? null;
  const events = store.filter('events', e =>
    e.routeId === route.routeId &&
    e.status !== 'rejected' &&
    (!personId || e.personId === personId));

  const versions = {};
  for (const v of route.versions) {
    versions[v.versionId] = {
      versionId: v.versionId,
      coords: v.coords,
      length: geo.polylineLength(v.coords),
      // 每个区间携带“观察时刻”，时间判定时必须 interval.observedAt <= ref
      intervals: [],
      // 轨迹质量问题（用于显示未核原因）
      trackIssues: []
    };
  }

  for (const ev of events) {
    const ver = versions[ev.geometryVersion];
    if (!ver) continue; // 已废弃且无版本留存的事件不参与计算
    const { intervals, track } = intervalsFromEvent(ev, ver.coords);
    for (const iv of intervals) {
      ver.intervals.push({ start: iv.start, end: iv.end, observedAt: ev.observedAtMs, eventId: ev.eventId, personId: ev.personId });
    }
    if (track && (track.driftCount > 0 || track.gapCount > 0)) {
      ver.trackIssues.push({
        eventId: ev.eventId, personId: ev.personId, observedAt: ev.observedAtMs,
        driftCount: track.driftCount, gapCount: track.gapCount, gapLength: Math.round(track.gapLength),
        matchedCount: track.matchedCount, pointCount: track.pointCount
      });
    }
  }

  // 时间线：按所有端点切分最小单元，每个单元取覆盖它的“最新观察时刻”。
  // 关键：相邻但不同时期的观察（如 2天前走 0-300、45天前走 300-600）
  // 不能被合并成同一个时间戳，否则部分路线会错误刷新整条复查日期。
  for (const vid of Object.keys(versions)) {
    const ver = versions[vid];
    ver.timeline = buildTimeline(ver.intervals, ver.length);
    // 展示用并集区间：observedAt 取该并集内“最旧的单元时刻”（最短板）
    const merged = [];
    for (const cell of ver.timeline) {
      const last = merged[merged.length - 1];
      if (last && cell.start <= last.end + EPS) {
        last.end = cell.end;
        last.observedAt = Math.min(last.observedAt, cell.observedAt);
        last.cells.push(cell);
      } else {
        merged.push({ start: cell.start, end: cell.end, observedAt: cell.observedAt, cells: [cell] });
      }
    }
    ver.coveredIntervals = merged.map(m => ({
      start: m.start, end: m.end, observedAt: m.observedAt,
      sources: m.cells.flatMap(c => c.sources).reduce((acc, s) => {
        if (!acc.find(x => x.eventId === s.eventId)) acc.push(s);
        return acc;
      }, [])
    }));
    ver.coveredLen = geo.intervalsLength(ver.coveredIntervals);
    ver.fraction = ver.length > 0 ? ver.coveredLen / ver.length : 0;
    ver.activeIntervals = ver.timeline.filter(i => i.observedAt <= refMs);
    ver.activeLen = geo.intervalsLength(ver.activeIntervals);
    ver.activeFraction = ver.length > 0 ? ver.activeLen / ver.length : 0;
    delete ver.intervals;
  }

  return versions;
}

// 端点细分法构造时间线单元：每个单元携带覆盖它的最新观察时刻
function buildTimeline(intervals, routeLen) {
  // 先把区间裁剪到 [0,routeLen]（人工范围可能略超实际几何长度）
  const ivs = intervals
    .map(i => ({
      ...i,
      start: Math.max(0, Math.min(i.start, routeLen)),
      end: routeLen === Infinity ? i.end : Math.min(routeLen, i.end)
    }))
    .filter(i => i.end - i.start > EPS);
  if (!ivs.length) return [];
  const bounds = new Set();
  for (const iv of ivs) { bounds.add(iv.start); bounds.add(iv.end); }
  const bs = [...bounds].sort((a, b) => a - b);
  const cells = [];
  for (let k = 0; k + 1 < bs.length; k++) {
    const a = bs[k], b = bs[k + 1];
    if (b - a <= EPS) continue;
    const mid = (a + b) / 2;
    const cov = ivs.filter(iv => iv.start <= mid + EPS && iv.end >= mid - EPS);
    if (!cov.length) continue;
    const winner = cov.reduce((w, iv) => (iv.observedAt > w.observedAt ? iv : w));
    cells.push({ start: a, end: b, observedAt: winner.observedAt, sources: cov.map(iv => ({ eventId: iv.eventId, personId: iv.personId, observedAt: iv.observedAt })) });
  }
  return cells;
}

// 区间在 [start,end] 上的“最晚全覆盖时刻”（入参为时间线单元）：
// 覆盖单元必须连续填满 [start,end]，锚点 = 所需单元的最小观察时刻（短板决定）。
// 调用方负责只传入 observedAt<=参考时刻 的单元（未来观察不计入）。
function lastFullCoverTime(cells, start, end) {
  const civs = cells
    .filter(c => c.end > start + EPS && c.start < end - EPS)
    .sort((a, b) => a.start - b.start);
  let cursor = start;
  let minT = Infinity;
  for (const c of civs) {
    if (c.start > cursor + EPS) return null; // 缺口 -> 该范围从未被整段核过
    minT = Math.min(minT, c.observedAt);
    cursor = Math.max(cursor, c.end);
    if (cursor + EPS >= end) return minT;
  }
  return cursor + EPS >= end ? minT : null;
}

// 计算有效期视图。validityDays 来自路线（或覆盖策略）。
// model: 'wholeRoute' | 'perSegment'
function computeValidity(store, route, opts = {}) {
  const refMs = opts.refMs ?? Date.now();
  const model = opts.model || route.validityModel || 'wholeRoute';
  const validityDays = route.validityDays ?? 30;
  const T = validityDays * 86400 * 1000;
  const versions = buildCoverage(store, route, { refMs, personId: opts.personId });

  const current = versions[route.currentVersion];
  const result = {
    routeId: route.routeId,
    model,
    validityDays,
    refMs,
    length: current.length,
    coveredLen: current.activeLen,
    fraction: current.activeFraction,
    coveredIntervals: current.coveredIntervals,
    timeline: current.timeline.map(c => ({ start: c.start, end: c.end, observedAt: c.observedAt })),
    trackIssues: current.trackIssues,
    segments: [],
    whole: null,
    newestConfirmedAt: null,
    conflicts: detectConflicts(store, route)
  };

  // 只采用“观察时刻不晚于参考时刻”的时间线单元（未来观察不能计入今天覆盖）
  const knownCells = current.timeline.filter(c => c.observedAt <= refMs);

  // 分段覆盖有效期：每个定义分段独立判定（分段边界按当前几何长度归一）
  for (const rawSeg of route.segments || []) {
    const seg = { ...rawSeg, start: Math.max(0, Math.min(rawSeg.start, current.length)), end: Math.max(0, Math.min(rawSeg.end, current.length)) };
    const t = lastFullCoverTime(knownCells, seg.start, seg.end);
    const expiredAt = t == null ? null : t + T;
    result.segments.push({
      segmentId: seg.segmentId, name: seg.name, start: seg.start, end: seg.end,
      lastCoveredMs: t,
      expiredMs: expiredAt,
      status: t == null ? 'uncovered'
        : expiredAt < refMs ? 'expired'
        : 'valid',
      validAtMs: t != null && expiredAt >= refMs ? t : null
    });
  }

  if (model === 'wholeRoute') {
    // 整路线有效期：必须有一次（可由多人/多事件合并的）全覆盖；
    // 有效期锚点 = 完成全覆盖所需各段观察时刻中的“最早者”（短板决定）
    const t = lastFullCoverTime(knownCells, 0, current.length);
    const expiredAt = t == null ? null : t + T;
    result.whole = {
      lastCoveredMs: t,
      expiredMs: expiredAt,
      status: t == null ? 'uncovered' : expiredAt < refMs ? 'expired' : 'valid'
    };
    result.status = result.whole.status;
    result.lastCoveredMs = t;
    result.expiredMs = expiredAt;
  } else {
    // 分段模型：路线整体有效 = 所有分段有效
    const all = result.segments.length > 0 && result.segments.every(s => s.status === 'valid');
    const anyExpired = result.segments.some(s => s.status === 'expired');
    result.status = all ? 'valid' : anyExpired ? 'expired' : 'uncovered';
    // 分段模型下“最近可确认的覆盖时点”：各分段最近全覆盖时刻的最小值
    const ts = result.segments.map(s => s.lastCoveredMs).filter(x => x != null);
    result.lastCoveredMs = ts.length ? Math.min(...ts) : null;
    result.expiredMs = result.lastCoveredMs == null ? null : result.lastCoveredMs + T;
  }

  // 页面展示：最近可确认的覆盖时点（只说明信息新近度，不代表安全保证）
  result.newestConfirmedAt = (() => {
    if (model === 'wholeRoute' && result.whole && result.whole.lastCoveredMs != null) {
      return { kind: 'whole', ms: result.whole.lastCoveredMs };
    }
    const segTs = result.segments
      .filter(s => s.lastCoveredMs != null)
      .map(s => ({ kind: 'segment', segmentId: s.segmentId, ms: s.lastCoveredMs }));
    if (!segTs.length) return null;
    return segTs.reduce((a, b) => (b.ms > a.ms ? b : a));
  })();

  return result;
}

// 两人观察冲突：同一几何版本、同一位置 30m 内、72h 内，关键字段不一致
function detectConflicts(store, route, windowMs = 72 * 3600 * 1000, radiusM = 30) {
  const evs = store.filter('events', e => e.routeId === route.routeId && e.status !== 'rejected');
  const conflicts = [];
  for (let i = 0; i < evs.length; i++) {
    for (let j = i + 1; j < evs.length; j++) {
      const a = evs[i], b = evs[j];
      if (a.personId === b.personId || a.geometryVersion !== b.geometryVersion) continue;
      if (Math.abs(a.observedAtMs - b.observedAtMs) > windowMs) continue;
      const d = geo.haversine(a.geo, b.geo);
      if (d > radiusM) continue;
      const diffs = [];
      if (a.observation.surface !== b.observation.surface) diffs.push('surface');
      if (a.observation.traffic !== b.observation.traffic) diffs.push('traffic');
      if (categorizeNoise(a.observation.noiseDb) !== categorizeNoise(b.observation.noiseDb)) diffs.push('noiseLevel');
      if (a.observation.hazards?.join('|') !== b.observation.hazards?.join('|')) diffs.push('hazards');
      if (diffs.length) {
        conflicts.push({
          eventIds: [a.eventId, b.eventId], people: [a.personId, b.personId],
          atMs: Math.max(a.observedAtMs, b.observedAtMs), distanceM: Math.round(d),
          fields: diffs, status: 'open'
        });
      }
    }
  }
  return conflicts;
}

function categorizeNoise(db) {
  if (db == null) return null;
  if (db < 55) return 'low';
  if (db < 70) return 'medium';
  return 'high';
}

// 附件完整性：至少 1 张照片 + 噪声读数 + 轨迹/人工范围其一
function attachmentCompleteness(store, ev) {
  const atts = store.filter('attachments', a => a.eventId === ev.eventId && a.status === 'stored');
  const photos = atts.filter(a => a.kind === 'photo');
  const missing = [];
  if (!photos.length) missing.push('photo');
  if (ev.observation.noiseDb == null) missing.push('noise');
  if (!ev.track && !ev.manualRange) missing.push('coverage');
  return { complete: missing.length === 0, missing, photoCount: photos.length };
}

module.exports = {
  geometryAt, buildCoverage, computeValidity, lastFullCoverTime,
  intervalsFromEvent, buildTimeline,
  detectConflicts, categorizeNoise, attachmentCompleteness
};
