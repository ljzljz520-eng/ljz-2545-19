'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const store = require('./lib/store');
const clock = require('./lib/clock');
const { computeValidity, geometryAt, attachmentCompleteness } = require('./lib/coverage');
const photo = require('./lib/photo');
const { cache, recommendFor } = require('./lib/recommend');

const PORT = process.env.PORT || 8080;
const SECRET = process.env.REVISIT_SECRET || 'dev-secret-change-me';
const WEB_DIR = path.join(__dirname, '..', 'web');
const ORIG_RETENTION_MS = 90 * 86400 * 1000;

// ---------- 工具 ----------
function send(res, code, obj, headers = {}) {
  const body = typeof obj === 'string' || Buffer.isBuffer(obj) ? obj : JSON.stringify(obj);
  res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(body);
}
function readBody(req, limit = 25 * 1024 * 1024) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', c => {
      size += c.length;
      if (size > limit) { reject(Object.assign(new Error('payload too large'), { httpCode: 413 })); req.destroy(); }
      else chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
async function readJson(req) {
  const buf = await readBody(req);
  try { return JSON.parse(buf.toString('utf8') || '{}'); }
  catch { throw Object.assign(new Error('invalid JSON'), { httpCode: 400 }); }
}
function tokenFor(personId) {
  const payload = `${personId}.${Date.now()}`;
  const sig = crypto.createHmac('sha256', SECRET).update(payload).digest('hex').slice(0, 16);
  return Buffer.from(`${payload}.${sig}`).toString('base64url');
}
function auth(req) {
  const h = req.headers['authorization'] || '';
  if (!h.startsWith('Bearer ')) return null;
  try {
    const raw = Buffer.from(h.slice(7), 'base64url').toString('utf8');
    const [personId, ts, sig] = raw.split('.');
    const expect = crypto.createHmac('sha256', SECRET).update(`${personId}.${ts}`).digest('hex').slice(0, 16);
    if (sig !== expect) return null;
    const person = store.find('people', p => p.personId === personId);
    return person || null;
  } catch { return null;
  }
}
function requireAuth(req) {
  const p = auth(req);
  if (!p) throw Object.assign(new Error('unauthorized'), { httpCode: 401 });
  return p;
}
function audit(action, detail) {
  store.insert('audit', { id: store.id('aud'), at: clock.iso(), atMs: Date.now(), action, detail });
}

// ---------- 事件入库 ----------
const SURFACES = ['good', 'fair', 'poor', 'blocked'];
const TRAFFIC = ['free', 'light', 'heavy', 'jam'];

function createEvent(input, person, serverNow) {
  // 幂等：同一设备事件号只接受一次
  if (!input.clientEventId) throw httpErr(400, 'clientEventId required');
  const dup = store.find('events', e => e.clientEventId === input.clientEventId && e.personId === person.personId);
  if (dup) {
    const hash = crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex');
    if (hash !== dup.clientPayloadHash) throw httpErr(409, 'clientEventId reused with different payload');
    return { event: dup, idempotent: true };
  }

  const route = store.find('routes', r => r.routeId === input.routeId);
  if (!route) throw httpErr(404, 'route not found');

  // 设备时间校验（与服务器时间分开；未来时间拒绝）
  const chk = clock.checkDeviceClock(input.observedAt, serverNow);
  if (!chk.ok) throw httpErr(422, `device clock rejected: ${chk.reason}`, { reason: chk.reason });

  if (!input.geo || typeof input.geo.lat !== 'number' || typeof input.geo.lng !== 'number') {
    throw httpErr(400, 'geo required {lat,lng}');
  }
  const obs = input.observation || {};
  if (!SURFACES.includes(obs.surface)) throw httpErr(400, `observation.surface must be one of ${SURFACES.join('/')}`);
  if (!TRAFFIC.includes(obs.traffic)) throw httpErr(400, `observation.traffic must be one of ${TRAFFIC.join('/')}`);
  if (obs.noiseDb != null && (typeof obs.noiseDb !== 'number' || obs.noiseDb < 20 || obs.noiseDb > 130)) {
    throw httpErr(400, 'observation.noiseDb must be 20..130 dB(A) or null');
  }
  if (input.track) validateTrack(input.track);
  if (input.manualRange) validateRange(input.manualRange);

  // 几何版本：以“观察时刻”生效的版本绑定（晚上传不能改挂到今天的新线位）
  const geom = input.geometryVersion
    ? route.versions.find(v => v.versionId === input.geometryVersion)
    : geometryAt(route, chk.deviceMs);
  if (!geom) throw httpErr(400, 'geometryVersion not found for this route');

  const event = {
    eventId: store.id('evt'),
    clientEventId: input.clientEventId,
    routeId: route.routeId,
    personId: person.personId,
    observerName: person.name,
    geometryVersion: geom.versionId,
    observedAt: new Date(chk.deviceMs).toISOString(), // 设备声称的观察时间
    observedAtMs: chk.deviceMs,
    receivedAt: serverNow.toISOString(),             // 服务器收到时间
    receivedAtMs: serverNow.getTime(),
    clockTrusted: chk.trusted,
    lateUpload: chk.late,
    clockDeltaMs: chk.deltaMs,
    geo: input.geo,
    observation: {
      surface: obs.surface,
      traffic: obs.traffic,
      noiseDb: obs.noiseDb ?? null,
      hazards: Array.isArray(obs.hazards) ? obs.hazards : [],
      note: obs.note ? String(obs.note).slice(0, 500) : ''
    },
    track: input.track || null,
    manualRange: input.manualRange || null,
    status: 'active',
    clientPayloadHash: crypto.createHash('sha256').update(JSON.stringify(input)).digest('hex'),
    attachmentsComplete: false
  };
  store.insert('events', event);
  // 入库即评估附件完整性（缺照片/噪声/覆盖依据会直接列出，不默认为齐全）
  const completeness = attachmentCompleteness(store, event);
  event.attachmentsComplete = completeness.complete;
  event.attachmentsMissing = completeness.missing;
  cache.bump('events');
  return { event, idempotent: false };
}
function httpErr(code, msg, extra = {}) { return Object.assign(new Error(msg), { httpCode: code, extra }); }
function validateTrack(t) {
  if (!Array.isArray(t.points) || t.points.length < 2) throw httpErr(400, 'track.points need >=2 points');
  for (const p of t.points) {
    if (typeof p.lat !== 'number' || typeof p.lng !== 'number') throw httpErr(400, 'track point needs lat,lng');
  }
}
function validateRange(r) {
  const okCoord = r.fromCoord && r.toCoord && typeof r.fromCoord.lat === 'number';
  const okM = typeof r.fromM === 'number' && typeof r.toM === 'number';
  if (!okCoord && !okM) throw httpErr(400, 'manualRange needs fromCoord/toCoord or fromM/toM');
}

// ---------- 附件入库 ----------
function saveAttachment(body, person, serverNow) {
  const dupKey = body.clientAttachmentId;
  if (dupKey) {
    const dup = store.find('attachments', a => a.clientAttachmentId === dupKey && a.personId === person.personId);
    if (dup) return { attachment: publicView(dup), idempotent: true };
  }
  const ev = resolveEvent(body, person);
  const buf = Buffer.from(body.dataBase64 || '', 'base64');
  if (!buf.length) throw httpErr(400, 'empty attachment');
  const kind = body.kind === 'audio' ? 'audio' : 'photo';
  const att = {
    attachmentId: store.id('att'),
    clientAttachmentId: dupKey || null,
    eventId: ev.eventId,
    routeId: ev.routeId,
    personId: person.personId,
    kind,
    fileName: String(body.fileName || 'file'),
    contentType: String(body.contentType || (kind === 'photo' ? 'image/jpeg' : 'audio/webm')),
    size: buf.length,
    sha256: crypto.createHash('sha256').update(buf).digest('hex'),
    status: 'stored',
    uploadedAt: serverNow.toISOString(),
    uploadedAtMs: serverNow.getTime(),
    observedAtMs: ev.observedAtMs,
    publicAvailable: false,
    exifGps: null,
    originalRetentionUntilMs: serverNow.getTime() + ORIG_RETENTION_MS
  };
  fs.writeFileSync(path.join(store.dir, 'originals', `${att.attachmentId}.bin`), buf, { mode: 0o600 });
  try { fs.chmodSync(path.join(store.dir, 'originals', `${att.attachmentId}.bin`), 0o600); } catch {}

  if (kind === 'photo') {
    const gps = photo.extractGps(buf);
    if (gps) att.exifGps = gps; // 审计留存，不随公开件分发
    const san = photo.sanitize(buf);
    if (san.jpeg && san.sanitized) {
      fs.writeFileSync(path.join(store.dir, 'public', `${att.attachmentId}.jpg`), san.sanitized);
      att.publicAvailable = true;
      att.strippedSegments = san.stripped;
    }
  } else {
    fs.copyFileSync(path.join(store.dir, 'originals', `${att.attachmentId}.bin`),
      path.join(store.dir, 'public', `${att.attachmentId}.bin`));
    att.publicAvailable = true;
  }
  store.insert('attachments', att);

  // 刷新事件附件完整性
  const c = attachmentCompleteness(store, ev);
  ev.attachmentsComplete = c.complete;
  ev.attachmentsMissing = c.missing;
  cache.bump('attachments');
  return { attachment: publicView(att), idempotent: false };
}
function resolveEvent(body, person) {
  if (body.eventId) {
    const ev = store.find('events', e => e.eventId === body.eventId && e.personId === person.personId);
    if (ev) return ev;
  }
  if (body.clientEventId) {
    const ev = store.find('events', e => e.clientEventId === body.clientEventId && e.personId === person.personId);
    if (ev) return ev;
  }
  throw httpErr(404, 'event not found for attachment');
}
function publicView(att) {
  return {
    attachmentId: att.attachmentId, eventId: att.eventId, kind: att.kind,
    fileName: att.fileName, size: att.size, status: att.status,
    publicAvailable: !!att.publicAvailable,
    publicUrl: att.publicAvailable ? `/api/attachments/${att.attachmentId}/public` : null,
    exifGpsPresent: !!att.exifGps,
    strippedSegments: att.strippedSegments || []
  };
}

// ---------- 同步批处理（网络断开->重试，整体幂等） ----------
function syncBatch(body, person, serverNow) {
  const out = { events: [], attachments: [] };
  for (const evBody of body.events || []) {
    try {
      const { event, idempotent } = createEvent(evBody, person, serverNow);
      out.events.push({ clientEventId: evBody.clientEventId, eventId: event.eventId, idempotent, ok: true });
    } catch (e) {
      out.events.push({ clientEventId: evBody.clientEventId, ok: false, error: e.message, httpCode: e.httpCode || 400 });
    }
  }
  store.save();
  for (const aBody of body.attachments || []) {
    try {
      const { attachment, idempotent } = saveAttachment(aBody, person, serverNow);
      out.attachments.push({ clientAttachmentId: aBody.clientAttachmentId, attachmentId: attachment.attachmentId, idempotent, ok: true });
    } catch (e) {
      out.attachments.push({ clientAttachmentId: aBody.clientAttachmentId, ok: false, error: e.message, httpCode: e.httpCode || 400 });
    }
  }
  store.save();
  return out;
}

// ---------- 路由 ----------
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css', '.json': 'application/json', '.png': 'image/png', '.svg': 'image/svg+xml' };
function serveStatic(req, res, urlPath) {
  let rel = urlPath === '/' ? '/index.html' : urlPath;
  rel = rel.replace(/\.\./g, '');
  const fp = path.join(WEB_DIR, rel);
  if (!fp.startsWith(WEB_DIR)) return send(res, 403, { error: 'forbidden' });
  fs.readFile(fp, (err, data) => {
    if (err) return send(res, 404, { error: 'not found' });
    res.writeHead(200, { 'content-type': MIME[path.extname(fp)] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || 'local'}`);
  const p = url.pathname;
  const serverNow = clock.now();
  try {
    // 静态
    if (req.method === 'GET' && !p.startsWith('/api/')) return serveStatic(req, res, p);

    // 演示登录
    if (req.method === 'POST' && p === '/api/auth/dev') {
      const body = await readJson(req);
      const person = store.find('people', x => x.personId === body.personId) ||
                     store.find('people', x => x.name === body.name);
      if (!person) throw httpErr(404, 'person not found; run npm run seed');
      return send(res, 200, { token: tokenFor(person.personId), person });
    }

    if (p === '/api/sync/batch' && req.method === 'POST') {
      const person = requireAuth(req);
      const body = await readJson(req);
      return send(res, 200, syncBatch(body, person, serverNow));
    }

    if (p === '/api/events' && req.method === 'POST') {
      const person = requireAuth(req);
      const body = await readJson(req);
      const { event } = createEvent(body, person, serverNow);
      store.save();
      return send(res, 201, eventView(event));
    }

    if (p === '/api/attachments' && req.method === 'POST') {
      const person = requireAuth(req);
      const body = await readJson(req);
      const r = saveAttachment(body, person, serverNow);
      store.save();
      return send(res, 201, r);
    }

    if (p === '/api/routes' && req.method === 'GET') {
      return send(res, 200, {
        routes: store.db.routes.map(r => ({
          routeId: r.routeId, name: r.name, currentVersion: r.currentVersion,
          validityDays: r.validityDays, validityModel: r.validityModel,
          versions: r.versions.map(v => ({ versionId: v.versionId, effectiveFrom: new Date(v.effectiveFromMs).toISOString(), pointCount: v.coords.length })),
          segments: r.segments
        }))
      });
    }

    let m;
    if ((m = p.match(/^\/api\/routes\/([\w-]+)\/validity$/)) && req.method === 'GET') {
      const route = store.find('routes', r => r.routeId === m[1]);
      if (!route) throw httpErr(404, 'route not found');
      const model = url.searchParams.get('model');
      const refMs = url.searchParams.get('at') ? Date.parse(url.searchParams.get('at')) : clock.now().getTime();
      const both = url.searchParams.get('both') === '1';
      const make = mv => computeValidity(store, route, { refMs, model: mv });
      const result = make(model || route.validityModel || 'wholeRoute');
      if (both) result.comparison = { wholeRoute: make('wholeRoute'), perSegment: make('perSegment') };
      return send(res, 200, result);
    }

    if ((m = p.match(/^\/api\/routes\/([\w-]+)\/events$/)) && req.method === 'GET') {
      return send(res, 200, { events: store.filter('events', e => e.routeId === m[1]).map(eventView) });
    }

    if ((m = p.match(/^\/api\/routes\/([\w-]+)\/realign$/)) && req.method === 'POST') {
      const person = requireAuth(req);
      if (person.role !== 'admin') throw httpErr(403, 'admin only');
      const route = store.find('routes', r => r.routeId === m[1]);
      if (!route) throw httpErr(404, 'route not found');
      const body = await readJson(req);
      if (!Array.isArray(body.coords) || body.coords.length < 2) throw httpErr(400, 'coords required');
      const effectiveFromMs = body.effectiveFrom ? Date.parse(body.effectiveFrom) : serverNow.getTime();
      const newVersionId = `v${route.versions.length + 1}`;
      const geo = require('./lib/geo');
      const version = { versionId: newVersionId, effectiveFromMs, coords: body.coords, length: geo.polylineLength(body.coords) };
      route.versions.push(version);
      route.currentVersion = newVersionId;
      if (Array.isArray(body.segments) && body.segments.length) {
        route.segments = body.segments.map((s, i) => ({
          segmentId: s.segmentId || `seg-${i + 1}`, name: s.name || `分段${i + 1}`, start: s.start, end: s.end
        }));
      } else {
        route.segments = [{ segmentId: 'seg-all', name: '改线后全线', start: 0, end: version.length }];
      }
      audit('route.realign', {
        routeId: route.routeId, by: person.personId, newVersionId,
        previousVersion: route.versions[route.versions.length - 2]?.versionId,
        effectiveFrom: new Date(effectiveFromMs).toISOString(), note: body.note || ''
      });
      cache.bump('routes');
      store.save();
      return send(res, 200, { routeId: route.routeId, currentVersion: newVersionId, segments: route.segments });
    }

    if ((m = p.match(/^\/api\/people\/me\/recommendations$/)) && req.method === 'GET') {
      const person = requireAuth(req);
      const r = recommendFor(store, person.personId, { model: url.searchParams.get('model') });
      return send(res, 200, { ...r.value, cached: r.cached, cache: cache.stats() });
    }

    if (p === '/api/conflicts' && req.method === 'GET') {
      const routeId = url.searchParams.get('routeId');
      const routes = routeId ? store.filter('routes', r => r.routeId === routeId) : store.db.routes;
      const { detectConflicts } = require('./lib/coverage');
      return send(res, 200, { conflicts: routes.flatMap(r => detectConflicts(store, r).map(c => ({ ...c, routeId: r.routeId }))) });
    }

    if ((m = p.match(/^\/api\/attachments\/([\w-]+)\/public$/)) && req.method === 'GET') {
      const att = store.find('attachments', a => a.attachmentId === m[1]);
      if (!att || att.status !== 'stored' || !att.publicAvailable) throw httpErr(404, 'public copy unavailable');
      const fp = path.join(store.dir, 'public', att.kind === 'photo' ? `${att.attachmentId}.jpg` : `${att.attachmentId}.bin`);
      const data = fs.readFileSync(fp);
      res.writeHead(200, { 'content-type': att.kind === 'photo' ? 'image/jpeg' : att.contentType });
      return res.end(data);
    }

    if ((m = p.match(/^\/api\/admin\/attachments\/([\w-]+)\/original$/)) && req.method === 'GET') {
      const person = requireAuth(req);
      if (person.role !== 'admin') throw httpErr(403, 'admin only: originals are restricted');
      const att = store.find('attachments', a => a.attachmentId === m[1]);
      if (!att) throw httpErr(404, 'not found');
      if (serverNow.getTime() > att.originalRetentionUntilMs) {
        audit('attachment.originalDenied', { attachmentId: att.attachmentId, by: person.personId, reason: 'retention_expired' });
        throw httpErr(410, 'original retention expired');
      }
      audit('attachment.originalAccess', { attachmentId: att.attachmentId, by: person.personId, sha256: att.sha256 });
      store.save();
      const data = fs.readFileSync(path.join(store.dir, 'originals', `${att.attachmentId}.bin`));
      res.writeHead(200, {
        'content-type': att.contentType,
        'x-original-gps': att.exifGps ? JSON.stringify(att.exifGps) : 'none',
        'x-retention-until': new Date(att.originalRetentionUntilMs).toISOString()
      });
      return res.end(data);
    }

    if (p === '/api/cache/debug' && req.method === 'GET') return send(res, 200, cache.stats());
    if (p === '/api/health' && req.method === 'GET') return send(res, 200, { ok: true, now: clock.iso() });

    throw httpErr(404, 'no such endpoint');
  } catch (e) {
    const code = e.httpCode || 500;
    send(res, code, { error: e.message || String(e), ...(e.extra || {}) });
  }
});

function eventView(ev) {
  return {
    eventId: ev.eventId, clientEventId: ev.clientEventId, routeId: ev.routeId,
    personId: ev.personId, observerName: ev.observerName, geometryVersion: ev.geometryVersion,
    observedAt: ev.observedAt, receivedAt: ev.receivedAt,
    clockTrusted: ev.clockTrusted, lateUpload: ev.lateUpload, clockDeltaMs: ev.clockDeltaMs,
    geo: ev.geo, observation: ev.observation,
    hasTrack: !!ev.track, hasManualRange: !!ev.manualRange,
    attachmentsComplete: ev.attachmentsComplete, attachmentsMissing: ev.attachmentsMissing || [],
    status: ev.status
  };
}

if (require.main === module) {
  server.listen(PORT, () => console.log(`road-revisit server on http://localhost:${PORT}`));
}
module.exports = server;
