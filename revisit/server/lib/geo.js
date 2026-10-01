'use strict';
// 地理几何：等距圆柱投影 + 哈弗辛距离，轨迹->路段匹配（带误差缓冲带）
const R = 6371000; // 地球半径(米)

const toRad = d => (d * Math.PI) / 180;

function haversine(a, b) {
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const la1 = toRad(a.lat), la2 = toRad(b.lat);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(la1) * Math.cos(la2) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

// 点到线段投影：返回最近点、沿线位置(米)、垂距(米)
function projectOnSegment(p, a, b) {
  const lat0 = (a.lat + b.lat) / 2;
  const mx = 111320 * Math.cos(toRad(lat0));
  const my = 110540;
  const ax = a.lng * mx, ay = a.lat * my;
  const bx = b.lng * mx, by = b.lat * my;
  const px = p.lng * mx, py = p.lat * my;
  const dx = bx - ax, dy = by - ay;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((px - ax) * dx + (py - ay) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = ax + t * dx, cy = ay + t * dy;
  const along = t * Math.hypot(dx, dy);
  const perp = Math.hypot(px - cx, py - cy);
  return { along, perp };
}

// 计算折线累计长度
function polylineLength(coords) {
  let len = 0;
  for (let i = 1; i < coords.length; i++) len += haversine(coords[i - 1], coords[i]);
  return len;
}

// 将“起止桩号/坐标”归一为沿路线 [0,length] 区间
// range: {from?, to?, fromM?, toM?, fromCoord?, toCoord?}
function rangeToArcs(range, coords) {
  const at = c => {
    let best = Infinity, bestS = 0, acc = 0;
    for (let i = 0; i + 1 < coords.length; i++) {
      const pr = projectOnSegment(c, coords[i], coords[i + 1]);
      if (pr.perp < best) { best = pr.perp; bestS = acc + pr.along; }
      acc += haversine(coords[i], coords[i + 1]);
    }
    return { s: bestS, perp: best };
  };
  let s0, s1;
  const fromM = range.fromM ?? range.from;
  const toM = range.toM ?? range.to;
  if (typeof fromM === 'number' && typeof toM === 'number') {
    s0 = fromM; s1 = toM;
  } else {
    const a = at(range.fromCoord); const b = at(range.toCoord);
    s0 = a.s; s1 = b.s;
  }
  if (s1 < s0) [s0, s1] = [s1, s0];
  return { start: s0, end: s1 };
}

function mergeIntervals(ivs) {
  const sorted = ivs.filter(i => i.end > i.start).sort((a, b) => a.start - b.start);
  const out = [];
  for (const iv of sorted) {
    const last = out[out.length - 1];
    if (last && iv.start <= last.end) last.end = Math.max(last.end, iv.end);
    else out.push({ start: iv.start, end: iv.end });
  }
  return out;
}

function intervalsLength(ivs) {
  return ivs.reduce((n, i) => n + (i.end - i.start), 0);
}

// 轨迹点 -> 沿路线区间集合。
// toleranceM: 缓冲带宽度；连续在带内且相邻匹配点间隔 <= maxGapM 才视为连续覆盖。
// 落在带外的点计为漂移(drift)；带内但缺口 > maxGapM 计为漏段(gap)。
function matchTrack(points, coords, toleranceM, maxGapM) {
  const segCount = coords.length - 1;
  const segLens = [];
  let acc = 0;
  const segStart = [];
  for (let i = 0; i < segCount; i++) {
    segStart.push(acc);
    const l = haversine(coords[i], coords[i + 1]);
    segLens.push(l);
    acc += l;
  }
  const totalLen = acc;

  const raw = points.map(p => {
    let best = { perp: Infinity, seg: -1, s: 0 };
    for (let i = 0; i < segCount; i++) {
      const pr = projectOnSegment(p, coords[i], coords[i + 1]);
      if (pr.perp < best.perp) best = { perp: pr.perp, seg: i, s: segStart[i] + pr.along };
    }
    return {
      s: best.s,
      perp: best.perp,
      on: best.perp <= toleranceM,
      acc: typeof p.acc === 'number' ? p.acc : null,
      t: p.t || null
    };
  });

  const matched = raw.filter(r => r.on).sort((a, b) => a.s - b.s);
  const driftCount = raw.length - matched.length;

  // 沿路线方向做连续区间；相邻匹配点间距过大则断段（漏段）
  const rawIntervals = [];
  let gapCount = 0;
  let gapLength = 0;
  for (let i = 0; i < matched.length; i++) {
    if (i === 0) { rawIntervals.push({ start: matched[i].s, end: matched[i].s });; continue; }
    const d = matched[i].s - matched[i - 1].s;
    const last = rawIntervals[rawIntervals.length - 1];
    if (d <= maxGapM) {
      last.end = matched[i].s;
    } else {
      gapCount++;
      gapLength += d;
      rawIntervals.push({ start: matched[i].s, end: matched[i].s });
    }
  }
  const intervals = mergeIntervals(rawIntervals);
  const coveredLen = intervalsLength(intervals);

  return {
    totalLen,
    intervals,
    coveredLen,
    driftCount,
    gapCount,
    gapLength,
    pointCount: points.length,
    matchedCount: matched.length
  };
}

module.exports = { haversine, projectOnSegment, polylineLength, rangeToArcs, mergeIntervals, intervalsLength, matchTrack };
