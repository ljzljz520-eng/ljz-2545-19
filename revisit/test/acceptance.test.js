import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { newApp, start, api, setupRoute, trackFor, driftPoint, lowAccPoint, eventBody, jpegWithExif } from './helpers.js';

const app = newApp();
const { base, server } = await start(app);
after(() => server.close());

const sim = (iso) => ({ 'x-simulated-time': iso });
const TRAVEL_ON = process.env.REVISIT_ALLOW_TIME_TRAVEL;
process.env.REVISIT_ALLOW_TIME_TRAVEL = '1'; // 测试需要模拟“当时收到/现在评估”

test('1. 走完部分路线不刷新整条复查日期；漏段显示未核', async () => {
  const { route, v1, p1 } = await setupRoute(app, base);
  // 先在 10 天前走完整线（服务器也是 10 天前收到 → 设备时间可信）
  const tenDaysAgo = '2026-09-21T10:00:00.000Z';
  await api(base, 'POST', '/api/events', eventBody({
    routeId: route.id, versionId: v1.id, personId: p1.id,
    track: trackFor([0, 1, 2], v1.polyline), deviceTime: tenDaysAgo,
  }), sim(tenDaysAgo));
  // 今天只走第 1 段（服务器今天收到）
  const today = '2026-10-01T10:00:00.000Z';
  await api(base, 'POST', '/api/events', eventBody({
    routeId: route.id, versionId: v1.id, personId: p1.id,
    track: trackFor([0], v1.polyline), roadCond: 'rough', deviceTime: today,
  }), sim(today));
  const cov = (await api(base, 'GET', `/api/routes/${route.id}/coverage`, null, sim(today))).json.coverage;
  const s0 = cov.segments.find((s) => s.segmentIndex === 0);
  assert.equal(s0.status, 'covered');
  assert.equal(s0.timeState, 'fresh');
  // 部分路段刷新：第 1 段更新为今天，2/3 段仍是 10 天前；整线按最旧段 → 仍 fresh
  assert.equal(cov.wholeRoute.state, 'fresh');
  assert.equal(cov.perSegment.fresh, 3);
  // 现在把旧观察改成 35 天前，今天只补第 1 段
  const app2 = newApp(); const { server: s2 } = await start(app2);
  after(() => s2.close());
  const b2base = `http://localhost:${s2.address().port}`;
  const ctx = await setupRoute(app2, b2base);
  const old2 = '2026-08-27T10:00:00.000Z';
  await api(b2base, 'POST', '/api/events', eventBody({
    routeId: ctx.route.id, versionId: ctx.v1.id, personId: ctx.p1.id,
    track: trackFor([0, 1, 2], ctx.v1.polyline), deviceTime: old2,
  }), sim(old2));
  await api(b2base, 'POST', '/api/events', eventBody({
    routeId: ctx.route.id, versionId: ctx.v1.id, personId: ctx.p1.id,
    track: trackFor([0], ctx.v1.polyline), roadCond: 'rough', deviceTime: today,
  }), sim(today));
  const cov2 = (await api(b2base, 'GET', `/api/routes/${ctx.route.id}/coverage`)).json.coverage;
  // 部分路线：第 1 段 fresh，第 2/3 段 expired，整线按最旧段 → expired（不是 fresh）
  assert.equal(cov2.segments[0].timeState, 'fresh');
  assert.equal(cov2.segments[1].timeState, 'expired');
  assert.equal(cov2.segments[2].timeState, 'expired');
  assert.equal(cov2.wholeRoute.state, 'expired');
  assert.ok(cov2.perSegment.fresh === 1 && cov2.perSegment.expired === 2);
});

test('2. GPS 漂移与低精度点不参与覆盖，显示未核；漏段显示未核', async () => {
  const { route, v1, p1 } = await setupRoute(app, base);
  const body = eventBody({
    routeId: route.id, versionId: v1.id, personId: p1.id,
    track: trackFor([0], v1.polyline, { drift: [driftPoint(v1.polyline, 1), lowAccPoint(v1.polyline, 2)] }),
  });
  await api(base, 'POST', '/api/events', body);
  const cov = (await api(base, 'GET', `/api/routes/${route.id}/coverage`)).json.coverage;
  assert.equal(cov.segments[0].status, 'covered');
  assert.equal(cov.segments[1].status, 'unverified-drift');
  // 低精度点归入第 2 段最近线段，也显示漂移未核
  assert.equal(cov.segments[2].status, 'unverified-drift');
  assert.equal(cov.wholeRoute.state, 'partial');
});

test('3. 设备时间与服务器收到时间分开；晚上传不能冒充今天刚走', async () => {
  process.env.REVISIT_ALLOW_TIME_TRAVEL = '1';
  const { route, v1, p1 } = await setupRoute(app, base);
  // 服务器“今天”，设备声称 3 天前（偏差远超 5 分钟）
  const serverNow = '2026-10-01T10:00:00.000Z';
  const deviceSays = new Date(Date.parse(serverNow) - 3 * 86400000).toISOString();
  const r = await api(base, 'POST', '/api/events', eventBody({
    routeId: route.id, versionId: v1.id, personId: p1.id,
    track: trackFor([0, 1, 2], v1.polyline), deviceTime: deviceSays,
  }), sim(serverNow));
  assert.equal(r.json.deviceTimeInfo.trusted, false);
  assert.equal(r.json.receivedAt, serverNow);
  const detail = (await api(base, 'GET', `/api/routes/${route.id}/coverage`, null, sim(serverNow))).json;
  assert.equal(detail.coverage.wholeRoute.state, 'time-unverifiable');
  assert.ok(detail.explanation.some((l) => l.includes('不能计为今天刚走')));
  // 反方向：设备时钟快 3 天也不可信
  const r2 = await api(base, 'POST', '/api/events', eventBody({
    routeId: route.id, versionId: v1.id, personId: p1.id,
    track: trackFor([0, 1, 2], v1.polyline),
    deviceTime: new Date(Date.parse(serverNow) + 3 * 86400000).toISOString(),
  }), sim(serverNow));
  assert.equal(r2.json.deviceTimeInfo.trusted, false);
  process.env.REVISIT_ALLOW_TIME_TRAVEL = TRAVEL_ON;
});

test('4. 路线改线后可补交旧版本回访，且不污染新版覆盖', async () => {
  const { route, v1, p1 } = await setupRoute(app, base);
  // 发布 v2 改线（平移经度）
  const newPoly = v1.polyline.map((q) => ({ lat: q.lat, lon: q.lon + 0.0005 }));
  const v2 = (await api(base, 'POST', `/api/admin/routes/${route.id}/versions`, { polyline: newPoly, reason: '道路改线' })).json;
  assert.equal(v2.active, true);
  // 补交旧回访：显式指定 v1
  const r = await api(base, 'POST', '/api/events', eventBody({
    routeId: route.id, versionId: v1.id, personId: p1.id,
    track: trackFor([0, 1, 2], v1.polyline),
  }));
  assert.equal(r.json.status, 'complete');
  const obs = app.store.find('observations', (o) => o.id === r.json.observationId);
  assert.equal(obs.flags.submittedAgainstVersion, true);
  // 当前（v2）覆盖不受旧观察影响
  const activeCov = (await api(base, 'GET', `/api/routes/${route.id}/coverage`)).json;
  assert.equal(activeCov.version.id, v2.id);
  assert.ok(activeCov.coverage.segments.every((s) => s.status === 'none'));
  // v1 覆盖可单独查询，并提示有更新版本
  const oldCov = (await api(base, 'GET', `/api/routes/${route.id}/coverage?versionId=${v1.id}`)).json;
  assert.equal(oldCov.version.id, v1.id);
  assert.equal(oldCov.newerVersionAvailable.id, v2.id);
  assert.ok(oldCov.coverage.segments.every((s) => s.status === 'covered'));
});

test('5. 两人观察冲突：两段都保留并标记，进入推荐', async () => {
  const { route, v1, p1, p2 } = await setupRoute(app, base);
  await api(base, 'POST', '/api/events', eventBody({
    routeId: route.id, versionId: v1.id, personId: p1.id,
    track: trackFor([0, 1, 2], v1.polyline), roadCond: 'good',
  }));
  await api(base, 'POST', '/api/events', eventBody({
    routeId: route.id, versionId: v1.id, personId: p2.id,
    track: trackFor([0, 1, 2], v1.polyline), roadCond: 'blocked',
  }));
  const cov = (await api(base, 'GET', `/api/routes/${route.id}/coverage`)).json.coverage;
  assert.equal(cov.hasConflict, true);
  assert.ok(cov.segments[0].conflict);
  assert.deepEqual(cov.segments[0].conflict.roadConds.sort(), ['blocked', 'good']);
  const recs = (await api(base, 'GET', '/api/recommendations')).json.items;
  assert.ok(recs.some((r) => r.versionId === v1.id && r.reasons.includes('观察冲突')));
  // 两人各一条观察都在库里（不覆盖）
  const n = app.store.filter('observations', (o) => o.versionId === v1.id).length;
  assert.equal(n, 2);
});

test('6. 附件缺失：先标记 incomplete，重试补传后幂等完成', async () => {
  const { route, v1, p1 } = await setupRoute(app, base);
  const cid = 'photo-1';
  const body = eventBody({
    routeId: route.id, versionId: v1.id, personId: p1.id,
    track: trackFor([0], v1.polyline),
    expectedAttachments: [{ clientAttachmentId: cid }], photos: [],
  });
  const r1 = await api(base, 'POST', '/api/events', body);
  assert.deepEqual(r1.json.attachmentsMissing, [cid]);
  assert.equal(r1.json.status, 'incomplete');
  // 网络重试：同一个 clientEventId，这次带图
  const jpg = jpegWithExif().toString('base64');
  const retry = { ...body, photos: [{ clientAttachmentId: cid, dataBase64: jpg, contentType: 'image/jpeg', filename: 'p.jpg' }] };
  const r2 = await api(base, 'POST', '/api/events', retry);
  assert.equal(r2.json.duplicate, true);
  assert.equal(r2.json.status, 'complete');
  assert.deepEqual(r2.json.attachmentsMissing, []);
  // 事件与观察仍然只有一条（重试不产生重复）
  const events = app.store.filter('events', (e) => e.clientEventId === body.clientEventId);
  assert.equal(events.length, 1);
  const obs = app.store.find('observations', (o) => o.clientEventId === body.clientEventId);
  assert.equal(obs.status, 'complete');
  assert.deepEqual(obs.attachmentsMissing, []);
  assert.equal(obs.attachments.filter((a) => a.status === 'received').length, 1);
});

test('7. 超期：超过有效期的整路线为 expired，分段口径独立', async () => {
  process.env.REVISIT_ALLOW_TIME_TRAVEL = '1';
  const { route, v1, p1 } = await setupRoute(app, base);
  const visitAt = '2026-08-20T08:00:00.000Z'; // 42 天前
  await api(base, 'POST', '/api/events', eventBody({
    routeId: route.id, versionId: v1.id, personId: p1.id,
    track: trackFor([0, 1, 2], v1.polyline), deviceTime: visitAt,
  }), sim(visitAt));
  const cov = (await api(base, 'GET', `/api/routes/${route.id}/coverage`, null, sim('2026-10-01T08:00:00.000Z'))).json.coverage;
  assert.equal(cov.wholeRoute.state, 'expired');
  assert.equal(cov.perSegment.expired, 3);
  assert.ok(cov.segments.every((s) => s.dueAt === s.latestConfirmedAt ? false : !!s.dueAt));
  process.env.REVISIT_ALLOW_TIME_TRAVEL = TRAVEL_ON;
});

test('8. 网络重试幂等：重复 clientEventId 不产生重复事件/观察', async () => {
  const { route, v1, p1 } = await setupRoute(app, base);
  const body = eventBody({
    routeId: route.id, versionId: v1.id, personId: p1.id,
    track: trackFor([0], v1.polyline),
  });
  const a = await api(base, 'POST', '/api/events', body);
  const b = await api(base, 'POST', '/api/events', body);
  assert.equal(b.json.duplicate, true);
  assert.equal(b.json.eventId, a.json.eventId);
  assert.equal(app.store.filter('events', (e) => e.clientEventId === body.clientEventId).length, 1);
  assert.equal(app.store.filter('observations', (o) => o.clientEventId === body.clientEventId).length, 1);
});

test('9. 照片地理元数据脱敏：公开副本无 EXIF，原件受限保留并审计', async () => {
  const { route, v1, p1 } = await setupRoute(app, base);
  const jpg = jpegWithExif().toString('base64');
  const r = await api(base, 'POST', '/api/events', eventBody({
    routeId: route.id, versionId: v1.id, personId: p1.id,
    track: trackFor([0], v1.polyline),
    expectedAttachments: [{ clientAttachmentId: 'x' }],
    photos: [{ clientAttachmentId: 'x', dataBase64: jpg, contentType: 'image/jpeg' }],
  }));
  const att = r.json.attachments[0];
  assert.deepEqual(att.strippedMetadata, ['EXIF/XMP']);
  assert.equal(att.originalRetained, true);
  const pub = await fetch(base + att.publicUrl);
  const pubBuf = Buffer.from(await pub.arrayBuffer());
  assert.ok(!pubBuf.toString('latin1').includes('Exif'));
  // 原件无令牌拒绝
  const denied = await fetch(base + `/api/admin/photos/${att.photoId}/original`);
  assert.equal(denied.status, 403);
  // 带令牌可取原件（含 EXIF），并留下审计
  const ok = await fetch(base + `/api/admin/photos/${att.photoId}/original`, { headers: { 'x-admin-token': 'restricted-demo-token' } });
  assert.equal(ok.status, 200);
  const origBuf = Buffer.from(await ok.arrayBuffer());
  assert.ok(origBuf.toString('latin1').includes('Exif'));
  const access = app.store.find('attachmentAccess', (a) => a.photoId === att.photoId);
  assert.ok(access && access.granted);
});

test('10. 标识更新/几何版本更新使依赖推荐缓存失效', async () => {
  const { route, v1 } = await setupRoute(app, base);
  const first = await api(base, 'GET', '/api/recommendations');
  assert.equal(first.json.cache, 'MISS');
  const second = await api(base, 'GET', '/api/recommendations');
  assert.equal(second.json.cache, 'HIT');
  // 更新标识物 → marker 依赖版本提升 → 缓存失效
  await api(base, 'POST', '/api/admin/markers', { routeId: route.id, versionId: v1.id, segmentIndex: 0, label: '新警示牌' });
  const third = await api(base, 'GET', '/api/recommendations');
  assert.equal(third.json.cache, 'MISS');
  const mine = third.json.items.find((it) => it.routeId === route.id);
  assert.equal(mine.marker.label, '新警示牌');
  const fourth = await api(base, 'GET', '/api/recommendations');
  assert.equal(fourth.json.cache, 'HIT');
  // 发布新几何版本 → geometry 依赖提升 → 缓存失效
  await api(base, 'POST', `/api/admin/routes/${route.id}/versions`, { polyline: v1.polyline, reason: '微调' });
  const fifth = await api(base, 'GET', '/api/recommendations');
  assert.equal(fifth.json.cache, 'MISS');
});

test('11. 覆盖解释包含最近可确认时点与“非安全保证”声明；人工范围可补覆盖', async () => {
  const { route, v1, p1 } = await setupRoute(app, base);
  // 只用人工范围声明第 2 段（轨迹缺失时的人工补录）
  const r = await api(base, 'POST', '/api/events', eventBody({
    routeId: route.id, versionId: v1.id, personId: p1.id,
    track: [], manualRanges: [{ segmentIndex: 1 }],
  }));
  const detail = (await api(base, 'GET', `/api/routes/${route.id}/coverage`)).json;
  assert.equal(detail.coverage.segments[1].status, 'covered');
  assert.equal(detail.coverage.segments[1].coverSource, 'manual');
  assert.equal(detail.coverage.segments[1].flagged, 'manual-range');
  assert.ok(detail.explanation.some((l) => l.includes('整条路线的复查日期不会刷新')));
  assert.ok(detail.explanation.some((l) => l.includes('不构成对当前路况或通行安全的保证')));
});
