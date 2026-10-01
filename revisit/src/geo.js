// 等距圆柱投影下的局部平面几何（回访尺度 < 数公里，误差可忽略）
const R = 6371000;
const toRad = (d) => (d * Math.PI) / 180;

export function project(lat, lon, lat0, lon0) {
  return {
    x: R * toRad(lon - lon0) * Math.cos(toRad(lat0)),
    y: R * toRad(lat - lat0),
  };
}

export function segmentLengthM(a, b) {
  const lat0 = (a.lat + b.lat) / 2;
  const p = project(a.lat, a.lon, lat0, a.lon);
  const q = project(b.lat, b.lon, lat0, a.lon);
  return Math.hypot(q.x - p.x, q.y - p.y);
}

// 点到线段的最近点：返回 {t:[0,1], distM, alongM, lat,lon}
export function nearestOnSegment(point, a, b) {
  const lat0 = (a.lat + b.lat) / 2;
  const p = project(point.lat, point.lon, lat0, a.lon);
  const s = project(a.lat, a.lon, lat0, a.lon);
  const e = project(b.lat, b.lon, lat0, a.lon);
  const dx = e.x - s.x, dy = e.y - s.y;
  const len2 = dx * dx + dy * dy;
  let t = len2 === 0 ? 0 : ((p.x - s.x) * dx + (p.y - s.y) * dy) / len2;
  t = Math.max(0, Math.min(1, t));
  const cx = s.x + t * dx, cy = s.y + t * dy;
  const distM = Math.hypot(p.x - cx, p.y - cy);
  const lengthM = Math.hypot(dx, dy);
  const alongM = t * lengthM;
  const lon = a.lon + ((cx / R) * 180) / Math.PI / Math.cos(toRad(lat0));
  const lat = a.lat + ((cy / R) * 180) / Math.PI;
  return { t, distM, alongM, lengthM, lat, lon };
}

// 从折线顶点生成线段
export function buildSegments(polyline) {
  const segs = [];
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i], b = polyline[i + 1];
    segs.push({ index: i, a, b, lengthM: segmentLengthM(a, b) });
  }
  return segs;
}
