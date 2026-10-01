import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Store } from './store.js';
import { DepCache } from './cache.js';
import { buildRecommendations } from './recommend.js';
import { buildCoverage, explainCoverage } from './coverage.js';
import { verifyDeviceTime, nowFor } from './time.js';
import { savePhoto } from './photosStore.js';
import { json, readJson, serveStatic } from './http.js';
import { config } from './config.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

export function createApp({ dataDir, publicDir = join(__dirname, '..', 'public') }) {
  const store = new Store(join(dataDir, 'db.json'));
  const cache = new DepCache(store);

  const activeVersionOf = (routeId) =>
    store.filter('versions', (v) => v.routeId === routeId).sort((a, b) => b.version - a.version).find((v) => v.active);

  function recommendationDeps() {
    const deps = {};
    for (const d of store.all('depVersions')) deps[d.key] = d.version;
    deps['__activeVersions'] = store.all('versions').filter((v) => v.active).map((v) => v.id).sort().join(',');
    return deps;
  }

  async function ingestEvent(body, headers) {
    const receivedAtMs = nowFor(headers);
    const receivedAt = new Date(receivedAtMs).toISOString();

    // 幂等：网络重试以 clientEventId 去重。
    // 首次缺附件的重试可补传缺失附件；已收附件不重复保存，不产生重复事件/观察。
    const existing = store.find('events', (e) => e.clientEventId === body.clientEventId);
    if (existing) {
      const obs = store.find('observations', (o) => o.eventId === existing.id);
      let changed = false;
      const have = new Set(obs.attachments.filter((a) => a.status === 'received').map((a) => a.clientAttachmentId));
      for (const ph of body.photos || []) {
        if (have.has(ph.clientAttachmentId)) continue; // 重发的同一附件：忽略
        const buf = Buffer.from(ph.dataBase64, 'base64');
        let saved;
        try { saved = savePhoto(dataDir, buf, ph.contentType); }
        catch (e) {
          obs.attachments.push({ clientAttachmentId: ph.clientAttachmentId, status: 'rejected', error: e.message });
          changed = true;
          continue;
        }
        const rec = store.insert('photoFiles', {
          ...saved, publicPath: undefined, originalPath: undefined,
          publicUrl: `/api/photos/${saved.id}`, filename: ph.filename || null,
        });
        obs.attachments.push({
          clientAttachmentId: ph.clientAttachmentId, photoId: rec.id, publicUrl: rec.publicUrl,
          mime: saved.mime, strippedMetadata: saved.strippedMetadata, originalRetained: true, status: 'received',
        });
        changed = true;
      }
      if (changed) {
        const receivedIds = obs.attachments.filter((a) => a.status === 'received').map((a) => a.clientAttachmentId);
        obs.attachmentsMissing = (existing.expectedAttachmentIds || []).filter((id) => !receivedIds.includes(id));
        obs.receivedCount = receivedIds.length;
        obs.status = obs.attachmentsMissing.length ? 'incomplete' : 'complete';
        store.persist();
        cache.bump(`observations:route:${existing.routeId}`);
      }
      return { duplicate: true, eventId: existing.id, observationId: obs?.id || null, receivedAt: existing.receivedAt, status: obs?.status, attachmentsMissing: obs?.attachmentsMissing || [] };
    }

    const route = store.find('routes', (r) => r.id === body.routeId);
    if (!route) throw Object.assign(new Error('route not found'), { status: 404 });
    const active = activeVersionOf(route.id);
    let version = body.versionId
      ? store.find('versions', (v) => v.id === body.versionId && v.routeId === route.id)
      : active;
    if (!version) throw Object.assign(new Error('version not found'), { status: 404 });
    const person = store.find('persons', (p) => p.id === body.personId);
    if (!person) throw Object.assign(new Error('person not found'), { status: 404 });

    // 设备时间与服务器收到时间分开核验
    const dt = verifyDeviceTime(body.deviceTime, receivedAtMs, headers);

    // 事件先行落库（即使附件缺失/稍后重试也有痕迹）
    const event = store.insert('events', {
      clientEventId: body.clientEventId,
      routeId: route.id, versionId: version.id, personId: person.id,
      type: 'road-revisit',
      deviceTime: body.deviceTime || null,
      deviceInfo: body.deviceInfo || null,
      receivedAt,
      expectedAttachmentIds: (body.expectedAttachments || []).map((a) => a.clientAttachmentId),
      payload: { roadCond: body.roadCond, noiseDb: body.noiseDb, note: body.note },
    });

    // 附件：原件受限保留 + 公开副本地理元数据脱敏
    const attachments = [];
    for (const ph of body.photos || []) {
      const buf = Buffer.from(ph.dataBase64, 'base64');
      let saved;
      try {
        saved = savePhoto(dataDir, buf, ph.contentType);
      } catch (e) {
        attachments.push({ clientAttachmentId: ph.clientAttachmentId, status: 'rejected', error: e.message });
        continue;
      }
      const rec = store.insert('photoFiles', {
        ...saved, publicPath: undefined, originalPath: undefined,
        publicUrl: `/api/photos/${saved.id}`, filename: ph.filename || null,
      });
      attachments.push({
        clientAttachmentId: ph.clientAttachmentId, photoId: rec.id,
        publicUrl: rec.publicUrl, mime: saved.mime,
        strippedMetadata: saved.strippedMetadata, originalRetained: true, status: 'received',
      });
    }

    const expectedIds = (body.expectedAttachments || []).map((a) => a.clientAttachmentId);
    const receivedIds = attachments.filter((a) => a.status === 'received').map((a) => a.clientAttachmentId);
    const attachmentsMissing = expectedIds.filter((id) => !receivedIds.includes(id));

    const obs = store.insert('observations', {
      eventId: event.id,
      clientEventId: body.clientEventId,
      routeId: route.id,
      versionId: version.id,
      personId: person.id,
      roadCond: body.roadCond || null,
      noiseDb: typeof body.noiseDb === 'number' ? body.noiseDb : null,
      note: body.note || '',
      track: body.track || [],
      manualRanges: body.manualRanges || [],
      deviceTime: body.deviceTime || null,
      deviceInfo: body.deviceInfo || null,
      deviceTimeInfo: { trusted: dt.trusted, skewMs: dt.skewMs },
      receivedAt,
      confirmedAt: dt.confirmedAt,
      attachments,
      attachmentsMissing,
      expectedCount: expectedIds.length,
      receivedCount: receivedIds.length,
      status: attachmentsMissing.length ? 'incomplete' : 'complete',
      flags: {
        submittedAgainstVersion: !version.active, // 改线后补交旧回访
        staleGeometry: !version.active,
        lateUpload: dt.trusted === false && dt.skewMs !== null && dt.skewMs < 0, // 晚上传且设备时间声称更早
      },
    });

    cache.bump(`observations:route:${route.id}`);
    return { duplicate: false, eventId: event.id, observationId: obs.id, receivedAt, deviceTimeInfo: obs.deviceTimeInfo, status: obs.status, attachments, attachmentsMissing };
  }

  async function handler(req, res) {
    const url = new URL(req.url, 'http://localhost');
    const p = url.pathname;
    try {
      // ---- 观察事件（含附件）----
      if (p === '/api/events' && req.method === 'POST') {
        const body = await readJson(req, config.bodyLimit);
        if (!body.clientEventId) return json(res, 400, { error: 'clientEventId required for idempotent retry' });
        return json(res, 200, await ingestEvent(body, req.headers));
      }

      if (p === '/api/persons' && req.method === 'GET') {
        return json(res, 200, store.all('persons'));
      }

      if (p === '/api/routes' && req.method === 'GET') {
        return json(res, 200, store.all('routes').map((r) => {
          const active = activeVersionOf(r.id);
          return { ...r, activeVersionId: active?.id || null, geometryVersion: active?.version || null, segmentCount: active ? active.polyline.length - 1 : 0 };
        }));
      }

      const routeMatch = p.match(/^\/api\/routes\/([^/]+)$/);
      if (routeMatch && req.method === 'GET') {
        const route = store.find('routes', (r) => r.id === routeMatch[1]);
        if (!route) return json(res, 404, { error: 'not found' });
        const versions = store.filter('versions', (v) => v.routeId === route.id)
          .map((v) => ({ id: v.id, version: v.version, active: v.active, reason: v.reason, createdAt: v.createdAt, segmentCount: v.polyline.length - 1 }));
        return json(res, 200, { ...route, versions });
      }

      // 覆盖：整路线有效期 vs 分段覆盖有效期
      const covMatch = p.match(/^\/api\/routes\/([^/]+)\/coverage$/);
      if (covMatch && req.method === 'GET') {
        const route = store.find('routes', (r) => r.id === covMatch[1]);
        if (!route) return json(res, 404, { error: 'not found' });
        let version;
        if (url.searchParams.get('versionId')) {
          version = store.find('versions', (v) => v.id === url.searchParams.get('versionId'));
        } else {
          version = activeVersionOf(route.id);
        }
        if (!version) return json(res, 404, { error: 'no geometry version' });
        const atMs = url.searchParams.get('at') ? Date.parse(url.searchParams.get('at')) : nowFor(req.headers);
        const obs = store.filter('observations', (o) => o.versionId === version.id);
        const cov = buildCoverage(version, obs, atMs);
        const active = activeVersionOf(route.id);
        return json(res, 200, {
          route: { id: route.id, name: route.name },
          version: { id: version.id, version: version.version, active: version.active },
          newerVersionAvailable: active && active.id !== version.id ? { id: active.id, version: active.version } : null,
          coverage: cov,
          explanation: explainCoverage(cov),
        });
      }

      // ---- 依赖推荐缓存 ----
      if (p === '/api/recommendations' && req.method === 'GET') {
        const day = new Date(nowFor(req.headers)).toISOString().slice(0, 10);
        const cacheKey = `recommendations:${day}`;
        const deps = recommendationDeps();
        const hit = cache.get(cacheKey, deps);
        if (hit.hit) return json(res, 200, { cache: 'HIT', cachedAt: hit.cachedAt, deps, items: hit.value });
        const items = buildRecommendations(store, nowFor(req.headers));
        const entry = cache.set(cacheKey, deps, items);
        return json(res, 200, { cache: 'MISS', cachedAt: entry.cachedAt, deps, items });
      }
      if (p === '/api/cache/stats' && req.method === 'GET') {
        return json(res, 200, { depVersions: store.all('depVersions'), ...cache.stats() });
      }

      // ---- 标识更新（触发推荐缓存依赖失效）----
      if (p === '/api/admin/markers' && req.method === 'POST') {
        const b = await readJson(req, 4096);
        const marker = store.insert('markers', b);
        cache.bump(`marker:route:${b.routeId}`);
        return json(res, 200, marker);
      }
      const markerPatch = p.match(/^\/api\/admin\/markers\/([^/]+)$/);
      if (markerPatch && req.method === 'PATCH') {
        const b = await readJson(req, 4096);
        const before = store.find('markers', (m) => m.id === markerPatch[1]);
        if (!before) return json(res, 404, { error: 'not found' });
        const marker = store.update('markers', before.id, b);
        cache.bump(`marker:route:${before.routeId}`);
        return json(res, 200, marker);
      }

      // ---- 路线与几何版本（发布新版同样使依赖缓存失效）----
      if (p === '/api/admin/routes' && req.method === 'POST') {
        const b = await readJson(req, config.bodyLimit);
        const route = store.insert('routes', { name: b.name, intervalDays: b.intervalDays ?? config.defaultIntervalDays });
        store.insert('versions', {
          routeId: route.id, version: 1, active: true,
          polyline: b.polyline, intervalDays: b.intervalDays ?? config.defaultIntervalDays, reason: '初版',
        });
        cache.bump(`geometry:route:${route.id}`);
        return json(res, 200, { ...route, versionId: store.filter('versions', (v) => v.routeId === route.id)[0].id });
      }
      const newVer = p.match(/^\/api\/admin\/routes\/([^/]+)\/versions$/);
      if (newVer && req.method === 'POST') {
        const route = store.find('routes', (r) => r.id === newVer[1]);
        if (!route) return json(res, 404, { error: 'not found' });
        const b = await readJson(req, config.bodyLimit);
        for (const v of store.filter('versions', (x) => x.routeId === route.id && x.active)) {
          store.update('versions', v.id, { active: false });
        }
        const next = (store.filter('versions', (x) => x.routeId === route.id).reduce((n, x) => Math.max(n, x.version), 0)) + 1;
        const version = store.insert('versions', {
          routeId: route.id, version: next, active: true, polyline: b.polyline,
          intervalDays: b.intervalDays ?? route.intervalDays, reason: b.reason || `第${next}版改线`,
        });
        cache.bump(`geometry:route:${route.id}`);
        return json(res, 200, version);
      }

      // ---- 照片：公开副本（无 EXIF）；原件受限，需令牌并审计 ----
      const pubPhoto = p.match(/^\/api\/photos\/([^/]+)$/);
      if (pubPhoto && req.method === 'GET') {
        const f = store.find('photoFiles', (x) => x.id === pubPhoto[1]);
        if (!f) return json(res, 404, { error: 'not found' });
        const { readFileSync } = await import('node:fs');
        res.writeHead(200, { 'content-type': f.mime, 'cache-control': 'private, max-age=300' });
        return res.end(readFileSync(join(dataDir, 'photostore', 'public', `${f.id}.${f.mime === 'image/png' ? 'png' : 'jpg'}`)));
      }
      const origPhoto = p.match(/^\/api\/admin\/photos\/([^/]+)\/original$/);
      if (origPhoto && req.method === 'GET') {
        if (req.headers['x-admin-token'] !== config.restrictedToken) return json(res, 403, { error: 'restricted: admin token required' });
        const f = store.find('photoFiles', (x) => x.id === origPhoto[1]);
        if (!f) return json(res, 404, { error: 'not found' });
        store.insert('attachmentAccess', { photoId: f.id, granted: true, at: new Date().toISOString() });
        const { readFileSync } = await import('node:fs');
        res.writeHead(200, { 'content-type': f.mime });
        return res.end(readFileSync(join(dataDir, 'photostore', 'originals', `${f.id}.${f.mime === 'image/png' ? 'png' : 'jpg'}`)));
      }

      if (p.startsWith('/api/')) return json(res, 404, { error: 'unknown api route' });
      return serveStatic(req, res, publicDir);
    } catch (err) {
      return json(res, err.status || 500, { error: err.message });
    }
  }
  return { handler, store, cache };
}
