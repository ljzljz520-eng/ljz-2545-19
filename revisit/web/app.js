'use strict';
/* 路况离线回访移动端：离线队列 + 轨迹/噪声/照片采集 + 覆盖状态展示（两模型对比） */
const $ = s => document.querySelector(s);
const api = async (path, opts = {}) => {
  const res = await fetch(path, {
    headers: opts.body ? { 'content-type': 'application/json', ...(opts.headers || {}) } : (opts.headers || {}),
    ...opts,
    body: opts.body ? JSON.stringify(opts.body) : undefined
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw Object.assign(new Error(data.error || res.statusText), { data });
  return data;
};
const toast = msg => { const t = $('#toast'); t.textContent = msg; t.classList.add('show'); clearTimeout(t._h); t._h = setTimeout(() => t.classList.remove('show'), 2600); };
const fmt = iso => iso ? new Date(iso).toLocaleString('zh-CN', { hour12: false }) : '—';
const fmtMs = ms => ms == null ? '—' : new Date(ms).toLocaleString('zh-CN', { hour12: false });

let token = localStorage.getItem('rv_token') || '';
let person = JSON.parse(localStorage.getItem('rv_person') || 'null');
let routes = [];
let track = null, watchId = null, pendingPhoto = null, serverTimeOffset = 0;

// ---------- 时钟 ----------
async function syncServerClock() {
  const t0 = Date.now();
  const h = await api('/api/health');
  serverTimeOffset = Date.parse(h.now) - (Date.now() + (Date.now() - t0) / 2);
  $('#srvClock').textContent = fmt(new Date(Date.now() + serverTimeOffset).toISOString());
}
setInterval(() => {
  $('#devClock').textContent = new Date().toLocaleString('zh-CN', { hour12: false });
  $('#srvClock').textContent = new Date(Date.now() + serverTimeOffset).toLocaleString('zh-CN', { hour12: false });
}, 1000);
window.addEventListener('online', () => $('#onlineState').textContent = '在线：可同步');
window.addEventListener('offline', () => $('#onlineState').textContent = '离线：数据已存入本机队列，联网后可重试');
$('#onlineState') && ($('#onlineState').textContent = navigator.onLine ? '在线：可同步' : '离线：本地排队中');

// ---------- 标签页 ----------
$('#tabs').addEventListener('click', e => {
  const tab = e.target.dataset.tab;
  if (!tab) return;
  document.querySelectorAll('nav.tabs button').forEach(b => b.classList.toggle('active', b.dataset.tab === tab));
  ['capture', 'status', 'accept'].forEach(t => $('#tab-' + t).classList.toggle('hidden', t !== tab));
  if (tab === 'status') loadStatus();
});

// ---------- 登录 ----------
$('#loginBtn').onclick = async () => {
  try {
    const r = await api('/api/auth/dev', { method: 'POST', body: { personId: $('#loginId').value.trim() } });
    token = r.token; person = r.person;
    localStorage.setItem('rv_token', token);
    localStorage.setItem('rv_person', JSON.stringify(person));
    afterLogin();
  } catch (e) { toast('登录失败：' + e.message); }
};
function afterLogin() {
  $('#login').classList.add('hidden');
  $('#tab-capture').classList.remove('hidden');
  $('#who').textContent = person.name + (person.role === 'admin' ? '（管理员）' : '');
  syncServerClock();
  loadRoutes();
  renderQueue();
}
if (token && person) afterLogin();

// ---------- 路线 ----------
async function loadRoutes() {
  const r = await api('/api/routes');
  routes = r.routes;
  $('#routeSel').innerHTML = routes.map(x => `<option value="${x.routeId}">${x.name}（${x.validityModel === 'perSegment' ? '分段' : '整线'}有效期 ${x.validityDays}天，当前${x.currentVersion}）</option>`).join('');
  updateRouteMeta();
}
$('#routeSel') && ($('#routeSel').onchange = updateRouteMeta);
function currentRoute() { return routes.find(x => x.routeId === $('#routeSel').value); }
function updateRouteMeta() {
  const r = currentRoute();
  if (!r) return;
  $('#routeMeta').textContent = `几何版本：${r.versions.map(v => `${v.versionId}@${fmt(v.effectiveFrom)}`).join('，')}`;
}
$('#coverMode').onchange = () => $('#manualBox').classList.toggle('hidden', $('#coverMode').value !== 'manual');

// ---------- 轨迹 ----------
$('#recBtn').onclick = () => {
  if (watchId == null) {
    if (!navigator.geolocation) return toast('设备不支持定位');
    track = { points: [], toleranceM: 30, maxGapM: 80 };
    watchId = navigator.geolocation.watchPosition(
      p => {
        track.points.push({ lat: +p.coords.latitude.toFixed(7), lng: +p.coords.longitude.toFixed(7), acc: Math.round(p.coords.accuracy), t: new Date().toISOString() });
        $('#trackInfo').textContent = `记录中：${track.points.length} 点，最新精度 ±${p.coords.accuracy | 0}m`;
      },
      err => toast('定位失败：' + err.message),
      { enableHighAccuracy: true, maximumAge: 0, timeout: 15000 });
    $('#recBtn').textContent = '■ 停止记录';
  } else {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    $('#recBtn').textContent = '● 开始记录轨迹';
    $('#trackInfo').textContent = track && track.points.length ? `已记录 ${track.points.length} 点（误差>30m 将计漂移，缺口>80m 计漏段）` : '未获取到点';
  }
};
$('#useLocBtn').onclick = () => {
  navigator.geolocation.getCurrentPosition(p => {
    track = { points: [{ lat: p.coords.latitude, lng: p.coords.longitude, acc: Math.round(p.coords.accuracy), t: new Date().toISOString() }], pointOnly: true, toleranceM: 30, maxGapM: 80 };
    $('#trackInfo').textContent = '仅观察点：' + track.points[0].lat.toFixed(5) + ',' + track.points[0].lng.toFixed(5);
  }, err => toast('定位失败：' + err.message), { enableHighAccuracy: true });
};

// ---------- 噪声 ----------
$('#noiseBtn').onclick = async () => {
  try {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const ac = new AudioContext();
    const src = ac.createMediaStreamSource(stream);
    const an = ac.createAnalyser();
    const buf = new Float32Array(an.fftSize);
    src.connect(an);
    const samples = [];
    await new Promise(res => {
      const t0 = Date.now();
      const loop = () => {
        an.getFloatTimeDomainData(buf);
        const rms = Math.sqrt(buf.reduce((n, v) => n + v * v, 0) / buf.length);
        if (rms > 0) samples.push(20 * Math.log10(rms) + 94); // 粗略声压级估计
        if (Date.now() - t0 < 3000) requestAnimationFrame(loop); else res();
      };
      loop();
    });
    stream.getTracks().forEach(t => t.stop()); ac.close();
    const db = Math.round(samples.sort((a, b) => a - b)[Math.floor(samples.length / 2)]);
    $('#noise').value = db;
    toast('噪声中位数约 ' + db + ' dB(A)（消费级麦克风，仅供参考）');
  } catch (e) { toast('麦克风不可用，请手填读数：' + e.message); }
};

// ---------- 照片 ----------
$('#photoInput').onchange = () => {
  const f = $('#photoInput').files[0];
  if (!f) return;
  if (f.size > 8 * 1024 * 1024) return toast('演示限制 8MB 以内照片');
  const reader = new FileReader();
  reader.onload = () => {
    pendingPhoto = {
      clientAttachmentId: 'att-' + crypto.randomUUID(),
      kind: 'photo', fileName: f.name || 'photo.jpg',
      contentType: f.type || 'image/jpeg', dataBase64: reader.result.split(',')[1]
    };
    $('#photoList').innerHTML = `<img class="photo-thumb" src="${reader.result}" alt="待传照片"><span class="muted">已选取 ${(f.size / 1024).toFixed(0)}KB，随同步上传；服务端将剥离 EXIF 后公开</span>`;
  };
  reader.readAsDataURL(f);
};

// ---------- 离线队列 ----------
function getQueue() { try { return JSON.parse(localStorage.getItem('rv_queue') || '{"events":[],"attachments":[]}'); } catch { return { events: [], attachments: [] }; } }
function setQueue(q) { localStorage.setItem('rv_queue', JSON.stringify(q)); renderQueue(); }
function renderQueue() {
  const q = getQueue();
  $('#queueList').innerHTML = [...q.events.map(e => `<div class="queue-item"><span>事件 ${e.clientEventId.slice(0, 16)} · ${e.routeId} · ${fmt(e.observedAt)}</span><span>待传</span></div>`),
  ...q.attachments.map(a => `<div class="queue-item"><span>附件 ${a.clientAttachmentId.slice(0, 16)}</span><span>待传</span></div>`)].join('');
}
$('#queueBtn').onclick = () => {
  const r = currentRoute();
  if (!r) return toast('请先选择路线');
  let payload;
  if ($('#coverMode').value === 'track') {
    if (!track || !track.points.length) return toast('请先记录轨迹或选择人工范围');
    payload = { track: track.points.length >= 2 ? track : null, geo: track.points[0] };
  } else {
    if (!track || !track.points.length) return toast('人工范围也需要一个观察点位置，请先点“仅记录观察点”');
    payload = { manualRange: { fromM: +$('#mFrom').value, toM: +$('#mTo').value }, geo: track.points[0], track: null };
    if (payload.manualRange.toM <= payload.manualRange.fromM) return toast('人工范围止值需大于起值');
  }
  const ev = {
    clientEventId: 'evt-' + crypto.randomUUID(),
    routeId: r.routeId,
    observedAt: new Date().toISOString(), // 设备时间
    geo: payload.geo || { lat: r.versions.length ? 0 : 0, lng: 0 },
    observation: {
      surface: $('#surface').value, traffic: $('#traffic').value,
      noiseDb: $('#noise').value === '' ? null : +$('#noise').value,
      hazards: $('#hazards').value.split(',').map(s => s.trim()).filter(Boolean),
      note: $('#note').value
    },
    track: payload.track || undefined,
    manualRange: payload.manualRange || undefined
  };
  const q = getQueue();
  q.events.push(ev);
  if (pendingPhoto) { pendingPhoto.clientEventId = ev.clientEventId; q.attachments.push(pendingPhoto); pendingPhoto = null; }
  setQueue(q);
  $('#photoList').innerHTML = ''; $('#photoInput').value = '';
  toast('已存入离线队列（观察时刻已按设备时间固定，联网后可重试上传）');
};
$('#syncBtn').onclick = async () => {
  const q = getQueue();
  if (!q.events.length && !q.attachments.length) return toast('队列为空');
  try {
    const r = await api('/api/sync/batch', { method: 'POST', headers: { authorization: 'Bearer ' + token }, body: q });
    const okE = r.events.filter(x => x.ok);
    const okA = r.attachments.filter(x => x.ok);
    // 成功（含幂等重复）的项移除；失败的保留以便重试
    const okEventIds = new Set(okE.map(x => x.clientEventId));
    const okAttIds = new Set(okA.map(x => x.clientAttachmentId));
    const left = { events: q.events.filter(e => !okEventIds.has(e.clientEventId)), attachments: q.attachments.filter(a => !okAttIds.has(a.clientAttachmentId)) };
    setQueue(left);
    const fail = [...r.events.filter(x => !x.ok), ...r.attachments.filter(x => !x.ok)];
    toast(fail.length ? `部分成功：事件${okE.length} 附件${okA.length}，失败${fail.length} 项保留待重试`
                      : `同步完成：事件${okE.length} 附件${okA.length}（重复提交已幂等去重）`);
  } catch (e) {
    toast(e.message === 'Failed to fetch' ? '网络不可用，数据保留在队列中，稍后重试' : '同步失败：' + e.message);
  }
};

// ---------- 覆盖状态 ----------
async function loadStatus() {
  if (!routes.length) await loadRoutes();
  $('#routeList').innerHTML = routes.map(r =>
    `<div class="route-item" data-id="${r.routeId}"><b>${r.name}</b>
      <div class="muted">${r.validityModel === 'perSegment' ? '分段覆盖有效期' : '整路线有效期'} · ${r.validityDays} 天 · 当前几何 ${r.currentVersion}</div>
    </div>`).join('');
  document.querySelectorAll('.route-item').forEach(el => el.onclick = () => showDetail(el.dataset.id));
}
async function showDetail(routeId) {
  const v = await api(`/api/routes/${routeId}/validity?both=1`);
  $('#detailCard').classList.remove('hidden');
  $('#detailName').textContent = routes.find(r => r.routeId === routeId).name;
  const tag = s => s === 'valid' ? '<span class="tag valid">有效</span>'
    : s === 'expired' ? '<span class="tag expired">超期</span>' : '<span class="tag uncovered">未核</span>';
  const pct = x => (x * 100).toFixed(0) + '%';
  const evListHtml = (() => {
    // 通过对比对象里的信息展示冲突/晚上传
    const conf = v.conflicts || [];
    return conf.length ? `<div style="margin-top:8px">${conf.map(c =>
      `<span class="tag conflict">两人观察冲突</span><span class="muted"> ${c.people.join(' / ')} · ${c.fields.join('、')} · ${fmtMs(c.atMs)}</span>`).join('<br>')}</div>` : '';
  })();
  const issues = (v.trackIssues || []).map(i =>
    `<div class="muted">⚠ 事件 ${i.eventId.slice(-6)}：漂移点 ${i.driftCount} 个、漏段 ${i.gapCount} 处（约 ${i.gapLength}m 未核）</div>`).join('');
  const c = v.comparison;
  // 时间线：每段按观察时刻新旧着色（旧=橙、新=绿、未核=灰），直观看出“部分路线只更新对应路段”
  const T = (v.validityDays || 30) * 86400e3;
  const cells = (v.timeline || []).map(cell => {
    const age = v.refMs - cell.observedAt;
    const color = age < T / 3 ? '#1e7d3f' : age < T ? '#0b6e6e' : '#b25f00';
    return `<span title="最近核于 ${fmtMs(cell.observedAt)}" style="display:inline-block;height:14px;width:${((cell.end - cell.start) / v.length * 100).toFixed(2)}%;background:${color}"></span>`;
  }).join('');
  $('#detailBody').innerHTML = `
    <div style="display:flex;width:100%;border:1px solid var(--line);border-radius:6px;overflow:hidden;background:#e7eeef">${cells}</div>
    <div class="muted" style="margin:4px 0 8px">时间线：<span style="color:#1e7d3f">■</span>新近核  <span style="color:#0b6e6e">■</span>有效期内  <span style="color:#b25f00">■</span>已超期  ｜ 空白=未核（GPS漂移/漏段）</div>
    <div class="bar"><span style="width:${pct(v.fraction)}"></span></div>
    <div class="muted">当前几何已核覆盖 ${pct(v.fraction)}（仅统计观察时刻不晚于当前时刻的有效记录）</div>
    ${issues}
    <h2 style="margin-top:12px">两种有效期模型对比</h2>
    <div class="seg"><span><b>按整路线有效期</b></span><span>${tag(c.wholeRoute.status)} 最近全覆盖 ${fmtMs(c.wholeRoute.lastCoveredMs)}，到期 ${fmtMs(c.wholeRoute.expiredMs)}</span></div>
    <div class="seg"><span><b>按分段覆盖有效期</b></span><span>${tag(c.perSegment.status)} 最短板到期 ${fmtMs(c.perSegment.expiredMs)}</span></div>
    <div style="margin-top:8px">
      ${c.perSegment.segments.map(s => `<div class="seg"><span>${s.name}</span><span>${tag(s.status)} 最近核 ${fmtMs(s.lastCoveredMs)}</span></div>`).join('')}
    </div>
    <p class="muted" style="margin-top:8px">走完部分路线只更新对应路段，不刷新整条复查日期；改线后旧回访绑定旧几何版本，另列展示。</p>
    ${evListHtml}
    <div class="disclaimer">🕓 最近可确认的覆盖时点：<b>${v.newestConfirmedAt ? fmtMs(v.newestConfirmedAt.ms) + (v.newestConfirmedAt.kind === 'whole' ? '（整线）' : '（分段）') : '尚无确认覆盖'}</b>。
    这只表示系统有据可查的最近观察时刻，<b>不代表此刻路况安全或道路畅通</b>。</div>`;
}
