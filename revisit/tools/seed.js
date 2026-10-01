'use strict';
// 重置并写入演示数据：整线有效、分段超期/未核、两人冲突、晚上传、带GPS照片
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
process.env.REVISIT_DATA = process.env.REVISIT_DATA || path.join(__dirname, '..', 'data');
// 清空旧库
const dir = process.env.REVISIT_DATA;
fs.rmSync(path.join(dir, 'db.json'), { force: true });
fs.rmSync(path.join(dir, 'originals'), { recursive: true, force: true });
fs.rmSync(path.join(dir, 'public'), { recursive: true, force: true });

const store = require('../server/lib/store');
const photo = require('../server/lib/photo');
const geo = require('../server/lib/geo');
const clock = require('../server/lib/clock');

const NOW = clock.now().getTime();
const H = 3600 * 1000, D = 24 * H;

// ---- 人员 ----
const alice = { personId: 'p_alice', name: '林爱华', role: 'inspector' };
const bob = { personId: 'p_bob', name: '王博文', role: 'inspector' };
const admin = { personId: 'p_admin', name: '管理员', role: 'admin' };
[alice, bob, admin].forEach(p => store.insert('people', p));

// ---- 几何：一条东西向直线 ----
function straightRoute(lat0, lng0, meters, stepM = 50) {
  const coords = [];
  const n = Math.round(meters / stepM);
  for (let i = 0; i <= n; i++) {
    coords.push({ lat: lat0, lng: lng0 + (i * stepM) / (111320 * Math.cos(lat0 * Math.PI / 180)) });
  }
  return coords;
}
function segmentsByLen(coords, cuts) {
  // cuts: 分段切点(米)，如 [0,333,666,1000]
  return cuts.slice(0, -1).map((c, i) => ({
    segmentId: `seg-${i + 1}`, name: `分段${i + 1}`, start: c, end: cuts[i + 1]
  }));
}
function trackAlong(coords, fromM, toM, opts = {}) {
  // 沿路线采样；drift: 在某点抛到带外
  const len = geo.polylineLength(coords);
  const step = opts.step || 25;
  const pts = [];
  for (let s = fromM; s <= toM + 0.1; s += step) {
    const f = Math.min(1, s / len);
    const total = coords.length - 1;
    const fi = f * total;
    const i0 = Math.floor(fi); const t = fi - i0;
    const a = coords[i0], b = coords[Math.min(total, i0 + 1)];
    pts.push({ lat: a.lat + (b.lat - a.lat) * t + (opts.jitter || 0), lng: a.lng + (b.lng - a.lng) * t, t: null });
  }
  if (opts.driftAt != null) {
    const idx = Math.floor(opts.driftAt / step);
    if (pts[idx]) pts[idx].lat += 0.0012; // ~130m，出 30m 缓冲带 -> 漂移点
  }
  return pts;
}

function makeRoute(routeId, name, coords, model, validityDays, segs, versionId = 'v1', fromMs = 0) {
  const route = {
    routeId, name, currentVersion: versionId, validityModel: model, validityDays,
    versions: [{ versionId, effectiveFromMs: fromMs, coords, length: geo.polylineLength(coords) }],
    segments: segs
  };
  store.insert('routes', route);
  return route;
}

let seq = 0;
function addEvent(route, person, observedAgoMs, trackPts, manualRange, obs, overrides = {}) {
  const ver = route.versions[0];
  const ev = {
    eventId: `evt_seed_${++seq}`,
    clientEventId: `seed-${seq}`,
    routeId: route.routeId, personId: person.personId, observerName: person.name,
    geometryVersion: overrides.version || ver.versionId,
    observedAt: new Date(NOW - observedAgoMs).toISOString(), observedAtMs: NOW - observedAgoMs,
    receivedAt: new Date(overrides.receivedAgoMs != null ? NOW - overrides.receivedAgoMs : NOW - observedAgoMs).toISOString(),
    receivedAtMs: overrides.receivedAgoMs != null ? NOW - overrides.receivedAgoMs : NOW - observedAgoMs,
    clockTrusted: overrides.trusted ?? true, lateUpload: overrides.late ?? false,
    clockDeltaMs: 0,
    geo: overrides.geo || (trackPts ? trackPts[Math.floor(trackPts.length / 2)] : ver.coords[0]),
    observation: Object.assign({ surface: 'good', traffic: 'light', noiseDb: 60, hazards: [], note: '' }, obs),
    track: trackPts ? { points: trackPts, toleranceM: 30, maxGapM: 80 } : null,
    manualRange: manualRange || null,
    status: 'active',
    clientPayloadHash: crypto.randomBytes(8).toString('hex'),
    attachmentsComplete: false, attachmentsMissing: []
  };
  store.insert('events', ev);
  return ev;
}

// ---------- EXIF GPS JPEG 构造（仅用于演示脱敏） ----------
function buildExifGps(lat, lng) {
  const latRef = lat >= 0 ? 'N' : 'S'; const lngRef = lng >= 0 ? 'E' : 'W';
  lat = Math.abs(lat); lng = Math.abs(lng);
  const dms = v => {
    const d = Math.floor(v); const m = Math.floor((v - d) * 60);
    const sec = Math.round((((v - d) * 60 - m) * 60) * 100) / 100;
    return [[d, 1], [m, 1], [Math.round(sec * 100), 100]];
  };
  const latR = dms(lat), lngR = dms(lng);
  // 统一的 TIFF 绝对布局（小端）：
  // 0..7 头；8..25 IFD0；26..79 GPS IFD(4项)；80..103 纬度；104..127 经度
  const HDR = 8;
  const ifd0Off = 8;
  const gpsOff = ifd0Off + 2 + 12 + 4;          // 26
  const latValOff = gpsOff + 2 + 4 * 12 + 4;    // 80
  const lngValOff = latValOff + 24;             // 104
  const tiff = Buffer.alloc(lngValOff + 24);
  tiff.write('II', 0, 'ascii');
  tiff.writeUInt16LE(0x2a, 2);
  tiff.writeUInt32LE(ifd0Off, 4);
  // IFD0
  tiff.writeUInt16LE(1, ifd0Off);
  tiff.writeUInt16LE(0x8825, ifd0Off + 2);   // tag @+2
  tiff.writeUInt16LE(4, ifd0Off + 4);       // type @+4
  tiff.writeUInt32LE(1, ifd0Off + 6);       // count @+6
  tiff.writeUInt32LE(gpsOff, ifd0Off + 10); // value @+10
  tiff.writeUInt32LE(0, ifd0Off + 16);      // next IFD ptr @条目后(+14..+17)
  // GPS IFD
  const ge = i => gpsOff + 2 + i * 12;
  tiff.writeUInt16LE(4, gpsOff);
  tiff.writeUInt16LE(1, ge(0)); tiff.writeUInt16LE(2, ge(0) + 2); tiff.writeUInt32LE(2, ge(0) + 4);
  tiff.write(`${latRef}\0`, ge(0) + 8, 'ascii');
  tiff.writeUInt16LE(2, ge(1)); tiff.writeUInt16LE(2, ge(1) + 2); tiff.writeUInt32LE(2, ge(1) + 4);
  tiff.write(`${lngRef}\0`, ge(1) + 8, 'ascii');
  tiff.writeUInt16LE(3, ge(2)); tiff.writeUInt16LE(5, ge(2) + 2); tiff.writeUInt32LE(3, ge(2) + 4); tiff.writeUInt32LE(latValOff, ge(2) + 8);
  tiff.writeUInt16LE(5, ge(3)); tiff.writeUInt16LE(5, ge(3) + 2); tiff.writeUInt32LE(3, ge(3) + 4); tiff.writeUInt32LE(lngValOff, ge(3) + 8);
  tiff.writeUInt32LE(0, gpsOff + 2 + 4 * 12);
  let o = latValOff;
  for (const [num, den] of latR) { tiff.writeUInt32LE(num, o); tiff.writeUInt32LE(den, o + 4); o += 8; }
  for (const [num, den] of lngR) { tiff.writeUInt32LE(num, o); tiff.writeUInt32LE(den, o + 4); o += 8; }

  const exifPayload = Buffer.concat([Buffer.from('Exif\0\0', 'ascii'), tiff]);
  const app1 = Buffer.alloc(2 + 2 + exifPayload.length);
  app1[0] = 0xff; app1[1] = 0xe1;
  app1.writeUInt16BE(exifPayload.length + 2, 2);
  exifPayload.copy(app1, 4);
  return app1;
}
function jpegWithGps(lat, lng) {
  const app0 = Buffer.from([0xFF, 0xE0, 0x00, 0x10, 0x4A, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const app1 = buildExifGps(lat, lng);
  const sos = Buffer.from([0xFF, 0xDA, 0x00, 0x02]);
  const eoi = Buffer.from([0xFF, 0xD9]);
  return Buffer.concat([Buffer.from([0xFF, 0xD8]), app0, app1, sos, eoi]);
}

let photoSeq = 0;
function addPhoto(ev, lat, lng, label) {
  const buf = jpegWithGps(lat, lng);
  const id = `att_seed_${++photoSeq}`;
  fs.writeFileSync(path.join(store.dir, 'originals', `${id}.bin`), buf, { mode: 0o600 });
  const gps = photo.extractGps(buf);
  const san = photo.sanitize(buf);
  fs.writeFileSync(path.join(store.dir, 'public', `${id}.jpg`), san.sanitized);
  const att = {
    attachmentId: id, clientAttachmentId: `seed-att-${photoSeq}`, eventId: ev.eventId, routeId: ev.routeId,
    personId: ev.personId, kind: 'photo', fileName: `${label}.jpg`, contentType: 'image/jpeg',
    size: buf.length, sha256: crypto.createHash('sha256').update(buf).digest('hex'), status: 'stored',
    uploadedAt: new Date(NOW).toISOString(), uploadedAtMs: NOW, observedAtMs: ev.observedAtMs,
    publicAvailable: true, exifGps: gps, strippedSegments: san.stripped,
    originalRetentionUntilMs: NOW + 90 * D
  };
  store.insert('attachments', att);
}

// ============ 路线 1：整路线模型，昨天刚全覆盖（有效） ============
{
  const coords = straightRoute(31.2300, 121.4700, 1000);
  const r = makeRoute('r_riverside', '滨水北路', coords, 'wholeRoute', 30, segmentsByLen(coords, [0, 340, 680, 1000]));
  // 40 天前只走了前 400m（部分路线）——不能刷新整条复查日期
  addEvent(r, alice, 40 * D, trackAlong(coords, 0, 400), null, { surface: 'fair', noiseDb: 64 }, {});
  // 昨天走完全线（含一个漂移点用于展示未核原因）
  const ev2 = addEvent(r, alice, 1 * D, trackAlong(coords, 0, 1000, { driftAt: 500 }), null,
    { surface: 'good', traffic: 'light', noiseDb: 61, hazards: [], note: '全线复查，途中一处GPS漂移已标注' });
  addPhoto(ev2, coords[10].lat, coords[10].lng, 'riverside-full');
  ev2.attachmentsComplete = true;
}

// ============ 路线 2：分段模型，seg1 有效 / seg2 超期 / seg3 未核 ============
{
  const coords = straightRoute(31.2400, 121.4800, 900);
  const cuts = [0, 300, 600, 900];
  const r = makeRoute('r_xuefu', '学府大道', coords, 'perSegment', 30, segmentsByLen(coords, cuts));
  addEvent(r, bob, 2 * D, trackAlong(coords, 0, 300), null, { surface: 'good', noiseDb: 58 });
  addEvent(r, bob, 45 * D, trackAlong(coords, 300, 600), null, { surface: 'poor', noiseDb: 72, hazards: ['pothole'] });
  // seg3 从未覆盖
}

// ============ 路线 3：两人观察冲突（同点 10 小时内，结论不一致） ============
{
  const coords = straightRoute(31.2500, 121.4900, 600);
  const r = makeRoute('r_park', '公园前路', coords, 'wholeRoute', 30, segmentsByLen(coords, [0, 300, 600]));
  const pt = coords[6];
  addEvent(r, alice, 10 * H, trackAlong(coords, 0, 600), null,
    { surface: 'good', traffic: 'light', noiseDb: 55 }, { geo: { ...pt } });
  addEvent(r, bob, 2 * H, trackAlong(coords, 0, 600), null,
    { surface: 'poor', traffic: 'jam', noiseDb: 75, hazards: ['debris'] }, { geo: { lat: pt.lat + 0.00005, lng: pt.lng } });
}

// ============ 路线 4：晚上传（3 天前走的，1 小时前才传到服务器） ============
{
  const coords = straightRoute(31.2600, 121.5000, 500);
  const r = makeRoute('r_oldtown', '老城环线', coords, 'wholeRoute', 30, segmentsByLen(coords, [0, 250, 500]));
  addEvent(r, alice, 3 * D, trackAlong(coords, 0, 500), null,
    { surface: 'fair', noiseDb: 66, note: '离线采集，信号恢复后上传' },
    { late: true, receivedAgoMs: 1 * H });
}

// ============ 路线 5：改线演示（v1 旧线，v2 新线明天生效；旧回访绑定 v1） ============
{
  const coordsV1 = straightRoute(31.2700, 121.5100, 800);
  const r = makeRoute('r_realign', '新港东路', coordsV1, 'wholeRoute', 30, segmentsByLen(coordsV1, [0, 400, 800]), 'v1', 0);
  // 旧几何上的回访（5 天前）
  const oldEv = addEvent(r, bob, 5 * D, trackAlong(coordsV1, 0, 800), null,
    { surface: 'good', noiseDb: 60, note: '改线前旧线位复查' }, { version: 'v1' });
  // 明天起 v2 生效（新线位向北偏移 ~60m），验收时通过 POST /realign 触发；种子保留 v1 即可
}

store.insert('audit', { id: store.id('aud'), at: new Date().toISOString(), atMs: NOW, action: 'seed', detail: { events: seq } });
store.save();
console.log('seed done:', {
  people: store.db.people.length, routes: store.db.routes.length,
  events: store.db.events.length, attachments: store.db.attachments.length, dataDir: dir
});
