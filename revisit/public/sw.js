// 离线壳：预缓存应用外壳；路线数据由应用层存入 localStorage（离线可查看/提交入队）
const CACHE = 'revisit-shell-v1';
const SHELL = ['./', './index.html', './app.js', './styles.css', './manifest.webmanifest'];
self.addEventListener('install', (e) => {
  e.waitUntil(caches.open(CACHE).then((c) => c.addAll(SHELL)).then(() => self.skipWaiting()));
});
self.addEventListener('activate', (e) => {
  e.waitUntil(caches.keys().then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)))).then(() => self.clients.claim()));
});
self.addEventListener('fetch', (e) => {
  const url = new URL(e.request.url);
  // API 请求不缓存（离线时由应用层进入 IndexedDB 队列）
  if (url.pathname.startsWith('/api/')) return;
  e.respondWith(caches.match(e.request).then((hit) => hit || fetch(e.request).catch(() => caches.match('./index.html'))));
});
