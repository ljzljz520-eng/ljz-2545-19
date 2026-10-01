// 初始化演示数据：两人、一条三段路线（v1）、一个标识物、一条 45 天前的整线旧回访（当前已超期）
import { createApp } from './app.js';
import { join, dirname } from 'node:path';
import { buildSegments } from './geo.js';

import { fileURLToPath } from 'node:url';
const __dirname = dirname(fileURLToPath(import.meta.url));
const dataDir = process.env.REVISIT_DATA_DIR || join(__dirname, '..', 'data');
const { store, cache } = createApp({ dataDir });

if (store.all('routes').length) {
  console.log('数据已存在，跳过 seed。');
  process.exit(0);
}

const persons = [
  store.insert('persons', { name: '王巡查', employeeNo: 'P001' }),
  store.insert('persons', { name: '李回访', employeeNo: 'P002' }),
];

// 约每段 85m 的折线（沿纬度方向）
const lat = 31.230000, lon = 121.470000, step = 0.00077;
const polyline = [0, 1, 2, 3].map((i) => ({ lat: lat + step * i, lon }));
const route = store.insert('routes', { name: '示范路 A 线', intervalDays: 30 });
const v1 = store.insert('versions', { routeId: route.id, version: 1, active: true, polyline, intervalDays: 30, reason: '初版' });

store.insert('markers', { routeId: route.id, versionId: v1.id, segmentIndex: 0, label: '桥头限高架', kind: 'sign' });

// 45 天前整线回访（轨迹密集覆盖全部三段）
const received = new Date(Date.now() - 45 * 86400000).toISOString();
const segs = buildSegments(polyline);
const track = [];
for (const s of segs) {
  for (let k = 0; k <= 6; k++) {
    const t = k / 6;
    track.push({
      lat: s.a.lat + (s.b.lat - s.a.lat) * t,
      lon: s.a.lon + (s.b.lon - s.a.lon) * t,
      accuracy: 8, t: received,
    });
  }
}
store.insert('events', {
  clientEventId: 'seed-event-old', routeId: route.id, versionId: v1.id, personId: persons[0].id,
  type: 'road-revisit', deviceTime: received, deviceInfo: 'seed', receivedAt: received,
  expectedAttachmentIds: [], payload: { roadCond: 'good', noiseDb: 61, note: '45 天前整线回访' },
});
store.insert('observations', {
  eventId: store.all('events')[0].id, clientEventId: 'seed-event-old',
  routeId: route.id, versionId: v1.id, personId: persons[0].id,
  roadCond: 'good', noiseDb: 61, note: '45 天前整线回访', track, manualRanges: [],
  deviceTime: received, deviceInfo: 'seed',
  deviceTimeInfo: { trusted: true, skewMs: 0 },
  receivedAt: received, confirmedAt: received,
  attachments: [], attachmentsMissing: [], expectedCount: 0, receivedCount: 0, status: 'complete',
  flags: { submittedAgainstVersion: false, staleGeometry: false, lateUpload: false },
});
cache.bump(`observations:route:${route.id}`);
console.log('seed 完成：路线', route.id, '版本', v1.id, '人员', persons.map((p) => p.id).join(','));
