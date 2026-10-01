import { createServer } from 'node:http';
import { readFile } from 'node:fs/promises';
import { join, normalize, extname } from 'node:path';

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json; charset=utf-8',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.svg': 'image/svg+xml',
  '.webmanifest': 'application/manifest+json', '.ico': 'image/x-icon',
};

export function json(res, status, body, headers = {}) {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headers });
  res.end(payload);
}

export async function readJson(req, limit) {
  let total = 0;
  const chunks = [];
  for await (const c of req) {
    total += c.length;
    if (total > limit) throw Object.assign(new Error('payload too large'), { status: 413 });
    chunks.push(c);
  }
  const raw = Buffer.concat(chunks).toString('utf8');
  if (!raw) return {};
  return JSON.parse(raw);
}

export async function serveStatic(req, res, publicDir) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = normalize(join(publicDir, urlPath));
  if (!filePath.startsWith(publicDir)) return json(res, 403, { error: 'forbidden' });
  try {
    const data = await readFile(filePath);
    res.writeHead(200, { 'content-type': MIME[extname(filePath)] || 'application/octet-stream' });
    res.end(data);
  } catch {
    json(res, 404, { error: 'not found' });
  }
}

export function listen(app, port = 0) {
  return new Promise((resolve) => {
    const server = createServer(app);
    server.listen(port, () => resolve(server));
  });
}
