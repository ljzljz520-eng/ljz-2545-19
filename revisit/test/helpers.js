import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createApp } from '../src/app.js';
import { listen } from '../src/http.js';

export function newApp() {
  const dir = mkdtempSync(join(tmpdir(), 'revisit-'));
  return createApp({ dataDir: dir });
}
export async function start(app) {
  const server = await listen(app.handler, 0);
  const base = `http://localhost:${server.address().port}`;
  return { base, server };
}
export async function api(base, method, path, body, headers = {}) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, json: await res.json() };
}

export async function setupRoute(app, base) {
  const { store } = app;
  const p1 = store.insert('persons', { name: '王巡查', employeeNo: 'P001' });
  const p2 = store.insert('persons', { name: '李回访', employeeNo: 'P002' });
  const r = await api(base, 'POST', '/api/admin/routes', {
    name: '测试路', intervalDays: 30,
    polyline: [
      { lat: 31.230000, lon: 121.470000 },
      { lat: 31.230770, lon: 121.470000 },
      { lat: 31.231540, lon: 121.470000 },
      { lat: 31.232310, lon: 121.470000 },
    ],
  });
  const route = r.json;
  const versions = app.store.filter('versions', (v) => v.routeId === route.id);
  return { p1, p2, route, v1: versions[0] };
}

// 沿每段生成密集轨迹；segIndexes 指定覆盖哪些段（含完整起止点）；opts 可注入漂移点
export function trackFor(segIndexes, polyline, { accuracy = 8, pointsPerSeg = 7, drift = [] } = {}) {
  const pts = [];
  const si = new Set(segIndexes);
  for (let i = 0; i < polyline.length - 1; i++) {
    const a = polyline[i], b = polyline[i + 1];
    if (si.has(i)) {
      for (let k = 0; k < pointsPerSeg; k++) {
        const t = k / (pointsPerSeg - 1);
        pts.push({ lat: a.lat + (b.lat - a.lat) * t, lon: a.lon + (b.lon - a.lon) * t, accuracy, t: null });
      }
    }
  }
  return pts.concat(drift);
}

export function driftPoint(polyline, seg = 1) {
  const a = polyline[seg];
  return { lat: a.lat, lon: a.lon + 0.0020, accuracy: 10, t: null }; // 偏东约 170m，超出走廊
}
export function lowAccPoint(polyline, seg = 2) {
  const a = polyline[seg], b = polyline[seg + 1];
  return { lat: (a.lat + b.lat) / 2, lon: a.lon, accuracy: 90, t: null };
}

export function eventBody({ routeId, versionId, personId, track, roadCond = 'good', noiseDb = 62,
  deviceTime = new Date().toISOString(), photos = [], expectedAttachments = [], manualRanges = [], note = '' }) {
  return {
    clientEventId: `evt-${Math.random().toString(36).slice(2)}`,
    routeId, versionId, personId, deviceTime, deviceInfo: { ua: 'test' },
    roadCond, noiseDb, note, track, manualRanges,
    photos, expectedAttachments,
  };
}

// 构造一个带 EXIF(APP1) 段的最小 JPEG（段解析只需标记合法）
export function jpegWithExif(extraPayload = 'GPS:31.23,121.47') {
  const exifPayload = Buffer.from(`Exif\0\0${extraPayload}`);
  const app1Len = Buffer.alloc(2); app1Len.writeUInt16BE(exifPayload.length + 2);
  // SOI + APP1 + 一个空 DQT + SOF0 骨架 + SOS + 1 字节扫描 + EOI
  const dqt = Buffer.from([0xFF, 0xDB, 0x00, 0x02]);
  return Buffer.concat([
    Buffer.from([0xFF, 0xD8]),
    Buffer.from([0xFF, 0xE1]), app1Len, exifPayload,
    dqt,
    Buffer.from([0xFF, 0xDA, 0x00, 0x02, 0x00, 0xFF, 0xD9]),
  ]);
}
