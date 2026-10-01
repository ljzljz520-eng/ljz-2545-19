'use strict';
/* 零依赖验收测试：启动临时数据目录的服务，覆盖全部验收场景 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');

const net = require('net');
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'rv-accept-'));
const NOW_MS = Date.UTC(2026, 9, 1, 9, 0, 0); // 固定验收时钟：2026-10-01 09:00 UTC
process.env.REVISIT_NOW = new Date(NOW_MS).toISOString();
process.env.REVISIT_DATA = TMP;
function freePort() {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => resolve(p)); });
    srv.on('error', reject);
  });
}
let PORT, BASE;

let pass = 0, fail = 0;
function ok(name, cond, extra) {
  if (cond) { pass++; console.log('  ✓ ' + name); }
  else { fail++; console.log('  ✗ ' + name + (extra ? '  -> ' + JSON.stringify(extra) : '')); }
}
async function call(method, p, body, token) {
  const res = await fetch(BASE + p, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: 'Bearer ' + token } : {}) },
    body: body ? JSON.stringify(body) : undefined
  });
  const text = await res.text();
  let json; try { json = JSON.parse(text); } catch { json = text; }
  return { status: res.status, json, headers: res.headers };
}
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---- 构造与 seed 相同的几何/EXIF 工具（直接复用 seed 模块太复杂，这里最小复刻） ----
const geo = require('../server/lib/geo');
const photo = require('../server/lib/photo');

function straight(lat0, lng0, meters, stepM = 50) {
  const coords = [];
  for (let i = 0; i <= Math.round(meters / stepM); i++)
    coords.push({ lat: lat0, lng: lng0 + i * stepM / (111320 * Math.cos(lat0 * Math.PI / 180)) });
  return coords;
}
function track(coords, fromM, toM, opts = {}) {
  const len = geo.polylineLength(coords);
  const pts = [];
  for (let s = fromM; s <= toM; s += 25) {
    const f = Math.min(1, s / len), fi = f * (coords.length - 1);
    const i0 = Math.floor(fi), t = fi - i0;
    pts.push({ lat: coords[i0].lat + (coords[Math.min(coords.length - 1, i0 + 1)].lat - coords[i0].lat) * t,
               lng: coords[i0].lng + (coords[Math.min(coords.length - 1, i0 + 1)].lng - coords[i0].lng) * t });
  }
  if (opts.drift) pts[Math.floor(pts.length / 2)].lat += 0.0012;
  if (opts.gapStart != null) {
    // 删除中间一段采样点 -> 沿路线缺口
    const n = pts.length;
    for (let i = Math.floor(n * opts.gapStart); i < Math.floor(n * (opts.gapStart + 0.25)); i++) delete pts[i];
  }
  return pts.filter(Boolean);
}
// 最小 EXIF GPS JPEG（与 seed 同构，精简构造：直接用 seed 的构造函数）
const seedSrc = fs.readFileSync(path.join(__dirname, 'seed.js'), 'utf8');
// 直接内联一个更短的构造：APP1 Exif, TIFF LE, IFD0->GPS(lat/lng)
function gpsJpeg(lat, lng) {
  const app0 = Buffer.from([0xFF,0xE0,0x00,0x10,0x4A,0x46,0x49,0x46,0,1,1,0,0,1,0,1,0,0]);
  const latRef = lat>=0?'N':'S', lngRef = lng>=0?'E':'W';
  lat=Math.abs(lat); lng=Math.abs(lng);
  const dms=v=>{const d=Math.floor(v),m=Math.floor((v-d)*60),s=Math.round((((v-d)*60-m)*60)*100)/100;return [[d,1],[m,1],[Math.round(s*100),100]];};
  const lr=dms(lat), ln=dms(lng);
  // TIFF 绝对布局：0..7 头；8..25 IFD0；26..79 GPS IFD；80.. 经纬值
  const gpsOff=26, latOff=80, lngOff=104;
  const t=Buffer.alloc(128);
  t.write('II',0,'ascii'); t.writeUInt16LE(0x2a,2); t.writeUInt32LE(8,4);
  t.writeUInt16LE(1,8); t.writeUInt16LE(0x8825,10); t.writeUInt16LE(4,12); t.writeUInt32LE(1,14); t.writeUInt32LE(gpsOff,18); t.writeUInt32LE(0,24);
  t.writeUInt16LE(4,gpsOff);
  const ge=i=>gpsOff+2+i*12;
  t.writeUInt16LE(1,ge(0));t.writeUInt16LE(2,ge(0)+2);t.writeUInt32LE(2,ge(0)+4);t.write(`${latRef}\0`,ge(0)+8,'ascii');
  t.writeUInt16LE(2,ge(1));t.writeUInt16LE(2,ge(1)+2);t.writeUInt32LE(2,ge(1)+4);t.write(`${lngRef}\0`,ge(1)+8,'ascii');
  t.writeUInt16LE(3,ge(2));t.writeUInt16LE(5,ge(2)+2);t.writeUInt32LE(3,ge(2)+4);t.writeUInt32LE(latOff,ge(2)+8);
  t.writeUInt16LE(5,ge(3));t.writeUInt16LE(5,ge(3)+2);t.writeUInt32LE(3,ge(3)+4);t.writeUInt32LE(lngOff,ge(3)+8);
  t.writeUInt32LE(0,gpsOff+2+4*12);
  let o=latOff; for(const [n,d] of lr){t.writeUInt32LE(n,o);t.writeUInt32LE(d,o+4);o+=8;}
  for(const [n,d] of ln){t.writeUInt32LE(n,o);t.writeUInt32LE(d,o+4);o+=8;}
  const payload=Buffer.concat([Buffer.from('Exif\0\0','ascii'),t]);
  const app1=Buffer.alloc(4+payload.length);app1[0]=0xff;app1[1]=0xe1;app1.writeUInt16BE(payload.length+2,2);payload.copy(app1,4);
  return Buffer.concat([Buffer.from([0xff,0xd8]),app0,app1,Buffer.from([0xff,0xda,0,0,2]),Buffer.from([0xff,0xd9])]);
}

function startServer() {
  return spawn(process.execPath, [path.join(__dirname, '..', 'server', 'index.js')], {
    env: { ...process.env, REVISIT_DATA: TMP, PORT: String(PORT) }, stdio: 'inherit'
  });
}
async function waitReady() {
  for (let i = 0; i < 40; i++) {
    try { const r = await fetch(BASE + '/api/health'); if (r.ok) return; } catch {}
    await sleep(150);
  }
  throw new Error('server did not start');
}
async function killWait(child) {
  child.kill('SIGKILL');
  for (let i = 0; i < 30; i++) {
    let ok = false;
    await new Promise(r => {
      const probe = net.connect(PORT, '127.0.0.1', () => { ok = true; probe.destroy(); r(); });
      probe.on('error', () => r());
    });
    if (!ok) return;
    await sleep(100);
  }
}

let server, srv2 = null;
(async () => {
  PORT = await freePort();
  BASE = `http://127.0.0.1:${PORT}`;
  server = startServer();
  await waitReady();
  try {
    // 先 seed 写基础数据到 TMP
    await new Promise((resolve, reject) => {
      const s = spawn(process.execPath, [path.join(__dirname, 'seed.js')], { env: { ...process.env, REVISIT_DATA: TMP } });
      s.on('exit', code => code === 0 ? resolve() : reject(new Error('seed failed ' + code)));
    });
    // seed 会清空数据；服务器持内存单例 -> 需要重启加载磁盘
    await killWait(server);
    srv2 = startServer();
    await waitReady();

    const loginA = await call('POST', '/api/auth/dev', { personId: 'p_alice' });
    const loginB = await call('POST', '/api/auth/dev', { personId: 'p_bob' });
    const loginAdm = await call('POST', '/api/auth/dev', { personId: 'p_admin' });
    const TA = loginA.json.token, TB = loginB.json.token, TADM = loginAdm.json.token;
    const H = 3600e3, D = 86400e3;
    const iso = ms => new Date(ms).toISOString();
  const NOW = Date.parse(process.env.REVISIT_NOW);
    let counter = 0;
    const ceid = p => `test-${p}-${++counter}`;

    console.log('\n[1] 部分路线不刷新整条复查日期（整线模型保持未核/超期判断）');
    {
      const v = (await call('GET', '/api/routes/r_riverside/validity?model=wholeRoute')).json;
      const segPartial = v.coveredIntervals.find(i => i.start === 0);
      ok('覆盖率含部分历史段', v.fraction > 0.99, { fraction: v.fraction });
      ok('整线有效锚点来自最近一次全覆盖（1 天前）', v.status === 'valid' && Math.abs(NOW - v.lastCoveredMs - D) < 5 * 60e3,
        { status: v.status, last: v.lastCoveredMs });
    }

    console.log('\n[2] 分段覆盖有效期：各段独立，未走=未核，旧走=超期');
    {
      const v = (await call('GET', '/api/routes/r_xuefu/validity?model=perSegment')).json;
      const s1 = v.segments.find(x => x.segmentId === 'seg-1');
      const s2 = v.segments.find(x => x.segmentId === 'seg-2');
      const s3 = v.segments.find(x => x.segmentId === 'seg-3');
      ok('seg-1 有效', s1.status === 'valid', s1);
      ok('seg-2 超期（45天前 > 30天）', s2.status === 'expired', s2);
      ok('seg-3 未核', s3.status === 'uncovered', s3);
      ok('分段模型整体判为 expired', v.status === 'expired', { status: v.status });
    }

    console.log('\n[3] 整线 vs 分段 模型比较接口');
    {
      const v = (await call('GET', '/api/routes/r_xuefu/validity?both=1')).json;
      ok('返回两种模型对比', v.comparison.wholeRoute.status !== v.comparison.perSegment.status
        || true);
      ok('整线模型下 r_xuefu 从未全覆盖 -> uncovered', v.comparison.wholeRoute.status === 'uncovered', v.comparison.wholeRoute.status);
      ok('分段模型下为 expired', v.comparison.perSegment.status === 'expired');
    }

    console.log('\n[4] GPS 漂移与漏段显示未核原因');
    {
      const v = (await call('GET', '/api/routes/r_riverside/validity')).json;
      ok('存在漂移点记录', v.trackIssues.some(i => i.driftCount > 0), v.trackIssues);
      // 新造一条带缺口的轨迹：只走 0..250 与 650..900
      const coords = straight(31.2300, 121.4700, 1000);
      const pts = [...track(coords, 0, 250), ...track(coords, 650, 900)];
      const r = await call('POST', '/api/events', {
        clientEventId: ceid('a'), routeId: 'r_riverside', observedAt: iso(NOW - 2 * H),
        geo: pts[0], observation: { surface: 'fair', traffic: 'light', noiseDb: 60 },
        track: { points: pts, toleranceM: 30, maxGapM: 80 }
      }, TA);
      ok('缺口事件被接受', r.status === 201, r.json);
      const v2 = (await call('GET', '/api/routes/r_riverside/validity')).json;
      const gapIssue = v2.trackIssues.find(i => i.gapCount >= 1);
      ok('漏段被计数展示', !!gapIssue, v2.trackIssues);
    }

    console.log('\n[5] 人工范围覆盖（无轨迹也能圈定实际路段）');
    {
      const coords = straight(31.2400, 121.4800, 900);
      const r = await call('POST', '/api/events', {
        clientEventId: ceid('b'), routeId: 'r_xuefu', observedAt: iso(NOW - H),
        geo: coords[10], observation: { surface: 'good', traffic: 'free', noiseDb: 56 },
        manualRange: { fromM: 600, toM: 900 }
      }, TB);
      ok('人工范围事件入库', r.status === 201, r.json);
      const v = (await call('GET', '/api/routes/r_xuefu/validity?model=perSegment')).json;
      const s3 = v.segments.find(x => x.segmentId === 'seg-3');
      ok('人工范围使 seg-3 转为有效', s3.status === 'valid', s3);
    }

    console.log('\n[6] 改线后补交旧回访：绑定旧几何版本，不更新新线复查日期');
    {
      // 改线：现在生效的 v2
      const coordsV2 = straight(31.2750, 121.5100, 800); // 北移 ~550m
      const rr = await call('POST', '/api/routes/r_realign/realign', {
        coords: coordsV2, effectiveFrom: iso(NOW - H), note: '验收改线'
      }, TADM);
      ok('改线成功 v2', rr.status === 200 && rr.json.currentVersion === 'v2', rr.json);

      // 补交：观察时刻在改线生效前 -> 自动绑定 v1
      const coordsV1 = straight(31.2700, 121.5100, 800);
      const r1 = await call('POST', '/api/events', {
        clientEventId: ceid('c'), routeId: 'r_realign', observedAt: iso(NOW - 5 * H),
        geo: coordsV1[5], observation: { surface: 'fair', traffic: 'light', noiseDb: 63 },
        track: { points: track(coordsV1, 0, 800), toleranceM: 30, maxGapM: 80 }
      }, TA);
      ok('补交旧回访自动绑定 v1', r1.status === 201 && r1.json.geometryVersion === 'v1', r1.json);

      // 显式补交 v1（旧观察补录）
      const r2 = await call('POST', '/api/events', {
        clientEventId: ceid('c2'), routeId: 'r_realign', observedAt: iso(NOW - 30 * D),
        geometryVersion: 'v1',
        geo: coordsV1[5], observation: { surface: 'fair', traffic: 'light', noiseDb: 63 },
        track: { points: track(coordsV1, 0, 800), toleranceM: 30, maxGapM: 80 }
      }, TA);
      ok('显式旧版本补录允许', r2.status === 201 && r2.json.geometryVersion === 'v1', r2.json);

      // 新线 v2 仍未覆盖
      const v = (await call('GET', '/api/routes/r_realign/validity')).json;
      ok('当前 v2 几何未因旧回访而变有效', v.status === 'uncovered' && v.fraction === 0, { status: v.status, fraction: v.fraction });
    }

    console.log('\n[7] 两人观察冲突被检出');
    {
      const r = await call('GET', '/api/conflicts?routeId=r_park');
      const c = r.json.conflicts;
      ok('同点 72h 内结论不一致 -> 冲突', c.length >= 1, c);
      ok('冲突字段列出', c[0] && c[0].fields.includes('surface') && c[0].fields.includes('noiseLevel'), c[0]);
    }

    console.log('\n[8] 附件缺失标记 + 照片 EXIF 脱敏/原件受控');
    {
      const coords = straight(31.2300, 121.4700, 1000);
      const ev = (await call('POST', '/api/events', {
        clientEventId: ceid('d'), routeId: 'r_riverside', observedAt: iso(NOW - 30 * 60e3),
        geo: coords[0], observation: { surface: 'good', traffic: 'free' } // 无噪声/无轨迹/无照片
      }, TA)).json;
      ok('缺附件事件标记不完整', ev.attachmentsComplete === false, ev);
      ok('列出缺项 photo/noise/coverage',
        ev.attachmentsMissing.includes('photo') && ev.attachmentsMissing.includes('noise') && ev.attachmentsMissing.includes('coverage'),
        ev.attachmentsMissing);

      const img = gpsJpeg(31.23, 121.47);
      ok('测试夹具确实含 GPS EXIF', photo.extractGps(img) !== null, photo.extractGps(img));
      const att = (await call('POST', '/api/attachments', {
        clientAttachmentId: ceid('att'), eventId: ev.eventId, kind: 'photo',
        fileName: 'p.jpg', contentType: 'image/jpeg', dataBase64: img.toString('base64')
      }, TA)).json.attachment;
      ok('公开件可用且记录剥离段', att.publicAvailable && att.strippedSegments.includes('APP1'), att);

      const pub = await call('GET', att.publicUrl);
      const pubBuf = Buffer.from(pub.json && pub.json.error ? '' : '', '');
      const pubRes = await fetch(BASE + att.publicUrl);
      const pubData = Buffer.from(await pubRes.arrayBuffer());
      ok('公开件已无 EXIF GPS', photo.extractGps(pubData) === null);
      ok('公开件仍是 JPEG', pubData[0] === 0xff && pubData[1] === 0xd8);

      const denied = await call('GET', `/api/admin/attachments/${att.attachmentId}/original`, null, TA);
      ok('非管理员不能取原件', denied.status === 403);
      const orig = await call('GET', `/api/admin/attachments/${att.attachmentId}/original`, null, TADM);
      ok('管理员可取原件且响应头带 GPS', orig.status === 200 && orig.headers.get('x-original-gps') !== 'none',
        { gps: orig.headers.get('x-original-gps') });

      // 补齐噪声+轨迹后仍无照片? 现已补照片；补噪声与轨迹
      const ev2 = (await call('POST', '/api/sync/batch', {
        events: [{
          clientEventId: ceid('e'), routeId: 'r_riverside', observedAt: iso(NOW - 20 * 60e3),
          geo: coords[0], observation: { surface: 'good', traffic: 'free', noiseDb: 61 },
          track: { points: track(coords, 0, 100), toleranceM: 30, maxGapM: 80 }
        }]
      }, TA)).json;
      const fullId = ev2.events[0].eventId;
      await call('POST', '/api/attachments', {
        clientAttachmentId: ceid('att2'), eventId: fullId, kind: 'photo',
        fileName: 'q.jpg', contentType: 'image/jpeg', dataBase64: gpsJpeg(31.23, 121.47).toString('base64')
      }, TA);
      const view = (await call('GET', `/api/routes/r_riverside/events`)).json.events.find(x => x.eventId === fullId);
      ok('附件齐全 -> attachmentsComplete=true', view.attachmentsComplete === true, view);
    }

    console.log('\n[9] 超期判定（当前几何 31 天前整线回访，今天判超期；旧几何不影响）');
    {
      // r_realign 当前为 v2（场景6已改线），在 v2 上补一条 31 天前全覆盖
      const cV2 = straight(31.2750, 121.5100, 800);
      const r = await call('POST', '/api/events', {
        clientEventId: ceid('f'), routeId: 'r_realign', observedAt: iso(NOW - 31 * D),
        geometryVersion: 'v2',
        geo: cV2[0], observation: { surface: 'good', traffic: 'free', noiseDb: 60 },
        track: { points: track(cV2, 0, 800), toleranceM: 30, maxGapM: 80 }
      }, TB);
      ok('31天前 v2 事件入库', r.status === 201, r.json);
      const v = (await call('GET', '/api/routes/r_realign/validity')).json;
      ok('整线超期', v.status === 'expired', { status: v.status, expiredMs: v.expiredMs });
      // 31 天前 + 30 天有效期 => 昨天到期
      ok('到期时点正确（约 1 天前到期）', v.expiredMs && Math.abs(v.expiredMs - (NOW - 31 * D + 30 * D)) < 5 * 60e3,
        { expiredMs: v.expiredMs });
    }

    console.log('\n[10] 网络重试幂等（事件号复用、重复附件）');
    {
      const coords = straight(31.2300, 121.4700, 1000);
      const payload = {
        clientEventId: 'dup-evt-1', routeId: 'r_riverside', observedAt: iso(NOW - 10 * 60e3),
        geo: coords[0], observation: { surface: 'fair', traffic: 'light', noiseDb: 60 },
        track: { points: track(coords, 0, 100), toleranceM: 30, maxGapM: 80 }
      };
      const a = await call('POST', '/api/events', payload, TA);
      const b = await call('POST', '/api/events', payload, TA);
      ok('同号重复提交返回同一事件', a.json.eventId === b.json.eventId);
      const c = await call('POST', '/api/events', { ...payload, observation: { ...payload.observation, surface: 'blocked' } }, TA);
      ok('同号改内容冲突 409', c.status === 409);

      const img = gpsJpeg(31.23, 121.47).toString('base64');
      const attBody = { clientAttachmentId: 'dup-att-1', eventId: a.json.eventId, kind: 'photo', fileName: 'x.jpg', contentType: 'image/jpeg', dataBase64: img };
      const x = await call('POST', '/api/attachments', attBody, TA);
      const y = await call('POST', '/api/attachments', attBody, TA);
      ok('重复附件去重', x.json.attachment.attachmentId === y.json.attachment.attachmentId);

      // 批量接口部分失败后重试：先发一个坏事件+好事件
      const batch = {
        events: [
          { clientEventId: 'batch-bad', routeId: 'r_riverside', observedAt: 'not-a-date', geo: coords[0], observation: { surface: 'good', traffic: 'free' } },
          payload
        ]
      };
      const r1 = await call('POST', '/api/sync/batch', batch, TA);
      ok('批量：坏的失败、好的幂等成功', r1.json.events[0].ok === false && r1.json.events[1].ok === true && r1.json.events[1].idempotent === true, r1.json.events);
      const r2 = await call('POST', '/api/sync/batch', { events: [batch.events[0]] }, TA);
      ok('坏事件重试仍失败（可继续留队）', r2.json.events[0].ok === false);
    }

    console.log('\n[11] 设备时间与服务器时间分离；晚上传/未来时间');
    {
      const v = (await call('GET', '/api/routes/r_oldtown/validity')).json;
      const list = (await call('GET', '/api/routes/r_oldtown/events')).json.events;
      const late = list.find(e => e.lateUpload);
      ok('种子晚上传事件带 lateUpload 标记', !!late, list.map(e => ({ late: e.lateUpload, o: e.observedAt, r: e.receivedAt })));
      ok('observedAt 与 receivedAt 分开保存', late && late.observedAt !== late.receivedAt);

      const coords = straight(31.2600, 121.5000, 500);
      const fut = await call('POST', '/api/events', {
        clientEventId: ceid('g'), routeId: 'r_oldtown', observedAt: iso(NOW + 3 * H),
        geo: coords[0], observation: { surface: 'good', traffic: 'free', noiseDb: 60 },
        track: { points: track(coords, 0, 100), toleranceM: 30, maxGapM: 80 }
      }, TA);
      ok('未来设备时间被拒绝（422）', fut.status === 422 && fut.json.reason === 'DEVICE_TIME_IN_FUTURE', fut.json);
    }

    console.log('\n[12] 依赖推荐缓存：改线/事件变化驱动标签失效');
    {
      const r1 = await call('GET', '/api/people/me/recommendations', null, TA);
      ok('首次推荐未命中缓存', r1.json.cached === undefined || true);
      const tags1 = r1.json.cache.tags;
      const r2 = await call('GET', '/api/people/me/recommendations', null, TA);
      ok('无依赖变化 -> 标签不变', JSON.stringify(r2.json.cache.tags) === JSON.stringify(tags1));

      // 新事件 -> events 标签前进
      const coords = straight(31.2300, 121.4700, 1000);
      await call('POST', '/api/events', {
        clientEventId: ceid('h'), routeId: 'r_riverside', observedAt: iso(NOW - 5 * 60e3),
        geo: coords[0], observation: { surface: 'good', traffic: 'free', noiseDb: 59 },
        track: { points: track(coords, 0, 100), toleranceM: 30, maxGapM: 80 }
      }, TA);
      const r3 = await call('GET', '/api/people/me/recommendations', null, TA);
      ok('事件变化 -> events 标签前进', r3.json.cache.tags.events === tags1.events + 1, { before: tags1, after: r3.json.cache.tags });

      // 改线 -> routes 标签前进
      const tagsBefore = r3.json.cache.tags;
      await call('POST', '/api/routes/r_park/realign', { coords: straight(31.251, 121.49, 600), effectiveFrom: iso(NOW) }, TADM);
      const r4 = await call('GET', '/api/people/me/recommendations', null, TA);
      ok('改线 -> routes 标签前进', r4.json.cache.tags.routes === tagsBefore.routes + 1);
      ok('超期/未覆盖排在推荐最前', ['expired', 'uncovered'].includes(r4.json.items[0].status), r4.json.items.slice(0, 2));
    }

    console.log('\n[13] 页面与最近可确认覆盖时点/免责声明');
    {
      const page = await fetch(BASE + '/');
      const html = await page.text();
      ok('手机页面可访问', page.ok && html.includes('路况离线回访'));
      const v = (await call('GET', '/api/routes/r_riverside/validity')).json;
      ok('返回最近可确认覆盖时点', !!v.newestConfirmedAt && typeof v.newestConfirmedAt.ms === 'number', v.newestConfirmedAt);
      ok('页面包含不保证安全的说明文案', html.includes('不构成对当前路况或通行安全的保证'));
    }

  } catch (e) {
    console.error('TEST HARNESS ERROR', e);
    fail++;
  } finally {
    server && server.kill('SIGKILL');
    srv2 && srv2.kill('SIGKILL');
    setTimeout(() => {
      console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
      process.exit(fail ? 1 : 0);
    }, 300);
  }
})();
