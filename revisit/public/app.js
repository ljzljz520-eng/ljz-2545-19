/* 道路离线回访手机端：IndexedDB 离线队列 + geolocation 轨迹 + 幂等重试 */
const $ = (s) => document.querySelector(s);
const state = { persons: [], routes: [], routeDetail: null, track: [], watchId: null, photos: [], queue: [] };

// ---------- IndexedDB 离线队列 ----------
function openDB() {
  return new Promise((res, rej) => {
    const req = indexedDB.open('revisit', 1);
    req.onupgradeneeded = () => req.result.createObjectStore('queue', { keyPath: 'clientEventId' });
    req.onsuccess = () => res(req.result);
    req.onerror = () => rej(req.error);
  });
}
async function queueGetAll() { const db = await openDB(); return new Promise((r, j) => { const q = db.transaction('queue').objectStore('queue').getAll(); q.onsuccess = () => r(q.result); q.onerror = () => j(q.error); }); }
async function queuePut(evt) { const db = await openDB(); return new Promise((r, j) => { const tx = db.transaction('queue', 'readwrite'); tx.objectStore('queue').put(evt); tx.oncomplete = r; tx.onerror = () => j(tx.error); }); }
async function queueDel(id) { const db = await openDB(); return new Promise((r, j) => { const tx = db.transaction('queue', 'readwrite'); tx.objectStore('queue').delete(id); tx.oncomplete = r; tx.onerror = () => j(tx.error); }); }

async function api(path, opts = {}) {
  const res = await fetch(path, { headers: { 'content-type': 'application/json' }, ...opts });
  if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error || res.status);
  return res.json();
}

// ---------- 基础数据 ----------
async function loadBase() {
  try {
    state.persons = await api('/api/persons');
    state.routes = await api('/api/routes');
    $('#person').innerHTML = state.persons.map((p) => `<option value="${p.id}">${p.name}（${p.employeeNo}）</option>`).join('');
    $('#route').innerHTML = state.routes.map((r) => `<option value="${r.id}">${r.name}（${r.segmentCount}段 / v${r.geometryVersion}）</option>`).join('');
    if (state.routes[0]) await loadRoute(state.routes[0].id);
  } catch (e) {
    // 离线：使用上次缓存
    const cached = JSON.parse(localStorage.getItem('revisit-base') || 'null');
    if (cached) {
      state.persons = cached.persons; state.routes = cached.routes;
      $('#person').innerHTML = state.persons.map((p) => `<option value="${p.id}">${p.name}</option>`).join('');
      $('#route').innerHTML = state.routes.map((r) => `<option value="${r.id}">${r.name}（离线缓存）</option>`).join('');
      $('#versionHint').textContent = '当前离线，使用缓存的路线几何版本；提交将进入待同步队列。';
    } else $('#versionHint').textContent = '离线且无缓存，无法选择路线。';
  }
}
async function loadRoute(routeId) {
  try {
    state.routeDetail = await api(`/api/routes/${routeId}`);
    localStorage.setItem('revisit-base', JSON.stringify({ persons: state.persons, routes: state.routes }));
    const v = state.routeDetail.versions.find((x) => x.active);
    state.activeVersion = v;
    $('#versionHint').textContent = `当前几何版本 v${v.version}（${v.segmentCount} 段）；改线后也可在提交时指定旧版本补交。`;
    $('#manualBox').innerHTML = v ? Array.from({ length: v.segmentCount }, (_, i) =>
      `<label><input type="checkbox" class="manualSeg" value="${i}"> 人工声明已覆盖第 ${i + 1} 段（标注人工范围）</label>`).join('') : '';
    renderStatus();
  } catch { /* 离线沿用缓存 */ }
}

// ---------- 轨迹 ----------
$('#recBtn').onclick = () => {
  if (!navigator.geolocation) return alert('设备不支持定位');
  state.track = [];
  state.watchId = navigator.geolocation.watchPosition(
    (pos) => {
      const pt = { lat: pos.coords.latitude, lon: pos.coords.longitude, accuracy: Math.round(pos.coords.accuracy), t: new Date(pos.timestamp).toISOString() };
      state.track.push(pt);
      const drift = pt.accuracy > 35 ? '（低精度→漂移点，不计覆盖）' : '';
      $('#trackInfo').textContent = `已记录 ${state.track.length} 点；最新精度 ±${pt.accuracy}m ${drift}`;
    },
    (err) => $('#trackInfo').textContent = '定位失败：' + err.message + '（可改用人工范围）',
    { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 }
  );
  $('#recBtn').disabled = true; $('#stopBtn').disabled = false;
};
$('#stopBtn').onclick = () => { navigator.geolocation.clearWatch(state.watchId); $('#recBtn').disabled = false; $('#stopBtn').disabled = true; };

// ---------- 照片 ----------
$('#photos').onchange = async () => {
  state.photos = []; $('#thumbs').innerHTML = '';
  for (const f of [...$('#photos').files]) {
    const buf = await f.arrayBuffer();
    const bytes = new Uint8Array(buf);
    let binary = ''; for (const b of bytes) binary += String.fromCharCode(b);
    const dataBase64 = btoa(binary);
    const clientAttachmentId = 'att-' + Math.random().toString(36).slice(2);
    state.photos.push({ clientAttachmentId, dataBase64, contentType: f.type, filename: f.name });
    $('#thumbs').innerHTML += `<img class="thumb" src="${URL.createObjectURL(f)}">`;
  }
};

// ---------- 提交 ----------
function buildEvent() {
  const routeId = $('#route').value;
  const versionId = state.activeVersion?.id || null;
  const manualRanges = [...document.querySelectorAll('.manualSeg:checked')].map((c) => ({ segmentIndex: Number(c.value) }));
  return {
    clientEventId: 'evt-' + crypto.randomUUID(),
    routeId, versionId,
    personId: $('#person').value,
    deviceTime: new Date().toISOString(), // 设备声明时间；服务器将与收到时间分开核验
    deviceInfo: { ua: navigator.userAgent, online: navigator.onLine },
    roadCond: $('#roadCond').value,
    noiseDb: Number($('#noiseDb').value) || null,
    note: $('#note').value,
    track: state.track,
    manualRanges,
    expectedAttachments: state.photos.map((p) => ({ clientAttachmentId: p.clientAttachmentId })),
    photos: state.photos,
  };
}

$('#submitBtn').onclick = async () => {
  const evt = buildEvent();
  if (!evt.track.length && !evt.manualRanges.length) {
    if (!confirm('既无轨迹也无人工覆盖范围，该观察将无法证明任何路段覆盖。仍要提交吗？')) return;
  }
  try {
    const r = await api('/api/events', { method: 'POST', body: JSON.stringify(evt) });
    alert(`已同步。状态：${r.status === 'complete' ? '附件完整' : '附件缺失 ' + (r.attachmentsMissing || []).join(',')}${r.duplicate ? '（重试幂等）' : ''}`);
    resetForm(); renderStatus();
  } catch (e) {
    // 离线/失败：入队，稍后自动/手动重试（同一 clientEventId 保证幂等）
    await queuePut(evt);
    alert('当前无法连接服务器，已存入待同步队列；恢复网络后将自动重试。');
    renderQueue();
  }
};
function resetForm() { state.track = []; state.photos = []; $('#photos').value = ''; $('#thumbs').innerHTML = ''; $('#trackInfo').textContent = '尚未开始。'; $('#note').value = ''; }

async function syncQueue() {
  const q = await queueGetAll();
  for (const evt of q) {
    try {
      await api('/api/events', { method: 'POST', body: JSON.stringify(evt) });
      await queueDel(evt.clientEventId);
    } catch (e) { /* 保留待下次 */ }
  }
  renderQueue(); renderStatus();
}
$('#syncBtn').onclick = syncQueue;

async function renderQueue() {
  state.queue = await queueGetAll();
  $('#qCount').textContent = state.queue.length ? `(${state.queue.length})` : '';
  $('#queueBox').innerHTML = state.queue.map((e) =>
    `<li>${e.roadCond ? '' : ''}<span class="badge">待发</span> 设备时间 ${new Date(e.deviceTime).toLocaleString()} · ${e.track.length} 轨迹点 · ${e.photos.length} 照片</li>`).join('')
    || '<li class="muted">队列为空</li>';
}

// ---------- 覆盖状态与解释 ----------
async function renderStatus() {
  const routeId = $('#route').value;
  if (!routeId) return;
  let data;
  try { data = await api(`/api/routes/${routeId}/coverage`); }
  catch { $('#wholeBox').innerHTML = '<p class="muted">离线：无法获取最新覆盖，以服务端解释为准。</p>'; return; }
  const w = data.coverage.wholeRoute;
  const wholeText = {
    fresh: `整路线有效（最近可确认覆盖 ${new Date(w.latestConfirmedAt).toLocaleString()}，有效期至 ${new Date(w.dueAt).toLocaleDateString()}）`,
    expired: `整路线已超期（最近可确认覆盖 ${new Date(w.latestConfirmedAt).toLocaleString()}）`,
    partial: '仅部分路线被覆盖，整条复查日期不刷新',
    'time-unverifiable': '设备时间不可信，整路线新近性无法确认',
    none: '该几何版本暂无回访',
  }[w.state];
  $('#wholeBox').innerHTML = `
    <p><span class="st ${w.state}">整路线口径：${w.state}</span></p>
    <p>${wholeText}</p>
    <p class="muted">${w.note || ''}</p>
    <p>分段口径：有效 ${data.coverage.perSegment.fresh} · 超期 ${data.coverage.perSegment.expired} · 时间不可信 ${data.coverage.perSegment.timeUnverifiable} · 未覆盖 ${data.coverage.perSegment.uncovered}
       ${data.newerVersionAvailable ? ` · <b>路线已改线（v${data.newerVersionAvailable.version}），当前查看的是旧几何版本</b>` : ''}</p>`;
  const segLabel = { covered: '已覆盖', 'unverified-drift': '漂移未核', 'unverified-missing': '漏段未核', none: '无观察' };
  $('#segBox').innerHTML = '<h2>分段覆盖</h2>' + data.coverage.segments.map((s) => `
    <div class="seg">
      <span class="st ${s.status}">${segLabel[s.status]}</span>
      <b>第 ${s.segmentIndex + 1} 段</b>（${s.lengthM} m）
      ${s.flagged === 'manual-range' ? '<span class="badge manual">人工范围</span>' : ''}
      ${s.conflict ? '<span class="st conflict">两人冲突</span>' : ''}
      <div class="muted">
        时间：${s.latestConfirmedAt ? new Date(s.latestConfirmedAt).toLocaleString() : '—'} ·
        有效期状态：${s.timeState}
        ${s.dueAt ? '至 ' + new Date(s.dueAt).toLocaleDateString() : ''}
      </div>
    </div>`).join('');
  $('#explainBox').innerHTML = data.explanation.map((l) => `<li>${l}</li>`).join('');
}

// ---------- Tab/网络 ----------
document.querySelectorAll('nav.tabs button').forEach((b) => b.onclick = () => {
  document.querySelectorAll('nav.tabs button').forEach((x) => x.classList.remove('active'));
  b.classList.add('active');
  ['visit', 'status', 'queue'].forEach((t) => $('#tab-' + t).hidden = t !== b.dataset.tab);
  if (b.dataset.tab === 'status') renderStatus();
  if (b.dataset.tab === 'queue') renderQueue();
});
$('#route').onchange = (e) => loadRoute(e.target.value);
function netUI() {
  $('#netState').textContent = navigator.onLine ? '在线：提交即时同步' : '离线：记录保存在本机，恢复网络后重试';
  if (navigator.onLine) syncQueue();
}
window.addEventListener('online', netUI); window.addEventListener('offline', netUI);

if ('serviceWorker' in navigator) navigator.serviceWorker.register('sw.js');
loadBase().then(renderQueue);
netUI();
setInterval(() => navigator.onLine && syncQueue(), 30000);
