import { config } from './config.js';
import { buildSegments, nearestOnSegment } from './geo.js';

const FOOTPRINT_M = 15; // 单个有效轨迹点在沿路线方向上的覆盖半径（位置误差的保守解释）

function mergeIntervals(iv) {
  if (!iv.length) return [];
  iv.sort((a, b) => a[0] - b[0]);
  const out = [iv[0].slice()];
  for (const [s, e] of iv.slice(1)) {
    const last = out[out.length - 1];
    if (s <= last[1]) last[1] = Math.max(last[1], e);
    else out.push([s, e]);
  }
  return out;
}
const unionLen = (iv) => iv.reduce((n, [s, e]) => n + (e - s), 0);

// 分析一次观察的轨迹对各线段的覆盖；漂移点（超精度或偏离走廊）单独统计，绝不参与覆盖。
export function analyzeTrack(track, segments, cfg = config) {
  const perSeg = segments.map((seg) => ({ intervals: [], used: 0, drift: 0, driftSamples: 0 }));
  const points = track || [];
  for (const pt of points) {
    let best = null;
    segments.forEach((seg, i) => {
      const n = nearestOnSegment(pt, seg.a, seg.b);
      if (!best || n.distM < best.distM) best = { ...n, segIndex: i };
    });
    const row = perSeg[best.segIndex];
    const inaccurate = (pt.accuracy ?? 0) > cfg.maxAccuracyM;
    if (!inaccurate && best.distM <= cfg.corridorM) {
      row.used += 1;
      row.intervals.push([
        Math.max(0, best.alongM - FOOTPRINT_M),
        Math.min(best.lengthM, best.alongM + FOOTPRINT_M),
      ]);
    } else {
      row.drift += 1; // GPS 漂移 / 低精度点
      row.driftSamples += 1;
    }
  }
  return perSeg.map((r, i) => {
    const intervals = mergeIntervals(r.intervals);
    const len = segments[i].lengthM;
    return {
      segmentIndex: i,
      ratio: len > 0 ? Math.min(1, unionLen(intervals) / len) : 1,
      intervals,
      usedPoints: r.used,
      driftPoints: r.drift,
      source: 'track',
    };
  });
}

// 合并人工范围（人工指定的覆盖范围，标注 source=manual 供审计）
export function mergeManual(trackCov, manual, segments) {
  const out = trackCov.map((c) => ({ ...c, flagged: null }));
  for (const m of manual || []) {
    const seg = segments[m.segmentIndex];
    if (!seg) continue;
    let iv;
    if (typeof m.fromAlongM === 'number' && typeof m.toAlongM === 'number') {
      iv = [[Math.max(0, m.fromAlongM), Math.min(seg.lengthM, m.toAlongM)]];
    } else {
      iv = [[0, seg.lengthM]];
    }
    const cur = out[m.segmentIndex];
    const manualRatio = seg.lengthM > 0 ? unionLen(iv) / seg.lengthM : 1;
    if (manualRatio >= cur.ratio) {
      cur.intervals = iv; cur.ratio = Math.min(1, manualRatio); cur.source = 'manual';
    }
    cur.flagged = 'manual-range';
  }
  return out;
}

function temporal(obs, intervalDays, nowMs) {
  // 设备时间不可信时，不能据此宣称“新鲜”；只能确认“不早于服务器收到时间”。
  if (!obs.deviceTimeInfo?.trusted) {
    return { state: 'time-unverifiable', latestConfirmedAt: null, dueAt: null };
  }
  const latest = Date.parse(obs.confirmedAt);
  const due = latest + intervalDays * 86400000;
  return {
    state: nowMs > due ? 'expired' : 'fresh',
    latestConfirmedAt: obs.confirmedAt,
    dueAt: new Date(due).toISOString(),
  };
}

// 核心：以带误差的轨迹或人工范围计算覆盖（部分路线不刷新整条复查日期）
export function buildCoverage(version, observations, nowMs = Date.now(), cfg = config) {
  const segments = buildSegments(version.polyline);
  const intervalDays = version.intervalDays ?? cfg.defaultIntervalDays;
  const analyzed = observations.map((obs) => {
    const track = analyzeTrack(obs.track, segments, cfg);
    const cov = mergeManual(track, obs.manualRanges, segments);
    return { obs, cov };
  });

  const anyObservation = observations.length > 0;
  const segResults = segments.map((seg, i) => {
    const contribs = analyzed
      .map(({ obs, cov }) => ({ obs, c: cov[i] }))
      .filter((x) => x.c.usedPoints > 0 || x.c.driftPoints > 0 || x.c.flagged === 'manual-range');

    const covering = contribs.filter((x) => x.c.ratio >= cfg.coverRatio);
    // 选择“最近可确认覆盖时点”的依据：优先可信时间、取最新
    covering.sort((a, b) => {
      const ta = a.obs.deviceTimeInfo?.trusted ? Date.parse(a.obs.confirmedAt) : -Infinity;
      const tb = b.obs.deviceTimeInfo?.trusted ? Date.parse(b.obs.confirmedAt) : -Infinity;
      return tb - ta;
    });
    const chosen = covering[0] || null;

    let status;
    if (chosen) status = 'covered';
    else if (contribs.some((x) => x.c.driftPoints > 0)) status = 'unverified-drift';
    else if (anyObservation) status = 'unverified-missing'; // 走了别的段 → 漏段
    else status = 'none';

    // 两人观察冲突：同段被不同观察覆盖，但路况结论不一致（两者都保留）
    const conflicts = [];
    if (covering.length > 1) {
      for (let k = 1; k < covering.length; k++) {
        const a = covering[0].obs, b = covering[k].obs;
        if (a.roadCond && b.roadCond && a.roadCond !== b.roadCond) {
          conflicts.push({ observationIds: [a.id, b.id], personIds: [a.personId, b.personId], roadConds: [a.roadCond, b.roadCond] });
        }
      }
    }

    const t = chosen ? temporal(chosen.obs, intervalDays, nowMs) : { state: status, latestConfirmedAt: null, dueAt: null };
    return {
      segmentIndex: i,
      lengthM: Math.round(seg.lengthM),
      status,
      coverSource: chosen ? chosen.c.source : null,
      flagged: chosen ? chosen.c.flagged : null,
      coveredRatio: chosen ? Number(chosen.c.ratio.toFixed(3)) : Math.max(0, ...contribs.map((x) => x.c.ratio)),
      observationId: chosen ? chosen.obs.id : null,
      personId: chosen ? chosen.obs.personId : null,
      timeState: t.state,
      latestConfirmedAt: t.latestConfirmedAt,
      dueAt: t.dueAt,
      conflict: conflicts[0] || null,
      contributions: contribs.map((x) => ({
        observationId: x.obs.id, personId: x.obs.personId, ratio: Number(x.c.ratio.toFixed(3)),
        source: x.c.source, flagged: x.c.flagged, usedPoints: x.c.usedPoints, driftPoints: x.c.driftPoints,
      })),
    };
  });

  // —— 两种有效期口径对比 ——
  const coveredSegs = segResults.filter((s) => s.status === 'covered');
  const allCovered = coveredSegs.length === segResults.length;
  // 整路线：必须所有分段均覆盖，最近可确认时点取“最旧的一段”（短板决定）
  let whole;
  if (!allCovered) {
    whole = { policy: 'whole-route', state: anyObservation ? 'partial' : 'none', latestConfirmedAt: null, dueAt: null, note: '仅走完部分路线，整条复查日期不刷新' };
  } else if (segResults.some((s) => s.timeState === 'time-unverifiable')) {
    whole = { policy: 'whole-route', state: 'time-unverifiable', latestConfirmedAt: null, dueAt: null, note: '设备时间不可信，整路线新近性无法确认' };
  } else {
    const oldest = coveredSegs.map((s) => Date.parse(s.latestConfirmedAt)).sort((a, b) => a - b)[0];
    const due = oldest + intervalDays * 86400000;
    whole = {
      policy: 'whole-route',
      state: nowMs > due ? 'expired' : 'fresh',
      latestConfirmedAt: new Date(oldest).toISOString(),
      dueAt: new Date(due).toISOString(),
      note: '以最旧分段的最近确认时点为准',
    };
  }
  // 分段：各段独立有效期
  const perSegment = {
    policy: 'per-segment',
    fresh: segResults.filter((s) => s.timeState === 'fresh').length,
    expired: segResults.filter((s) => s.timeState === 'expired').length,
    timeUnverifiable: segResults.filter((s) => s.timeState === 'time-unverifiable').length,
    uncovered: segResults.filter((s) => s.status !== 'covered').length,
  };

  return {
    versionId: version.id,
    routeId: version.routeId,
    evaluatedAt: new Date(nowMs).toISOString(),
    intervalDays,
    segments: segResults,
    wholeRoute: whole,
    perSegment,
    hasConflict: segResults.some((s) => s.conflict),
  };
}

// 页面文案：解释“最近可确认的覆盖时点”，信息新近不等于安全保证
export function explainCoverage(cov) {
  const lines = [];
  if (cov.wholeRoute.state === 'partial') {
    const miss = cov.segments.filter((s) => s.status !== 'covered').map((s) => `第${s.segmentIndex + 1}段`);
    lines.push(`本次只覆盖了部分路段（${miss.join('、')}未核），整条路线的复查日期不会刷新。`);
  } else if (cov.wholeRoute.state === 'fresh') {
    lines.push(`整路线最近可确认覆盖时点：${cov.wholeRoute.latestConfirmedAt}（以最旧分段为准），有效期至 ${cov.wholeRoute.dueAt}。`);
  } else if (cov.wholeRoute.state === 'expired') {
    lines.push(`整路线最近可确认覆盖时点为 ${cov.wholeRoute.latestConfirmedAt}，已超过 ${cov.intervalDays} 天有效期。`);
  } else if (cov.wholeRoute.state === 'time-unverifiable') {
    lines.push('设备时间与服务器时间偏差过大，无法确认覆盖发生时间；该覆盖只能视为“不早于服务器收到时间”，不能计为今天刚走。');
  } else {
    lines.push('该几何版本暂无任何回访观察。');
  }
  for (const s of cov.segments) {
    if (s.status === 'unverified-drift') lines.push(`第${s.segmentIndex + 1}段：只有漂移/低精度轨迹点，显示为未核。`);
    if (s.status === 'unverified-missing') lines.push(`第${s.segmentIndex + 1}段：漏段（未走到），显示为未核。`);
    if (s.timeState === 'time-unverifiable') lines.push(`第${s.segmentIndex + 1}段：几何覆盖成立但时间不可信，不计入新近性。`);
    if (s.conflict) lines.push(`第${s.segmentIndex + 1}段：两人观察结论冲突（${s.conflict.roadConds.join(' vs ')}），需复查。`);
  }
  lines.push('提示：覆盖信息只反映最近一次可确认的观察时点，不构成对当前路况或通行安全的保证。');
  return lines;
}
