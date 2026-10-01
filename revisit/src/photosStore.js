import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { sanitizePhoto } from './photo.js';

const ext = (mime) => (mime === 'image/png' ? 'png' : 'jpg');

// 原件受限保留：存在 originals/（不通过静态目录暴露）；公开副本在 public/（已去 EXIF）
export function savePhoto(dataDir, buf, declaredMime) {
  const { mime, publicBuf, removed, publicSha256 } = sanitizePhoto(buf);
  const id = randomUUID();
  const dirs = {
    originals: join(dataDir, 'photostore', 'originals'),
    public: join(dataDir, 'photostore', 'public'),
  };
  mkdirSync(dirs.originals, { recursive: true });
  mkdirSync(dirs.public, { recursive: true });
  const originalPath = join(dirs.originals, `${id}.${ext(mime)}`);
  const publicPath = join(dirs.public, `${id}.${ext(mime)}`);
  writeFileSync(originalPath, buf);            // 原件受限保留（含 EXIF）
  writeFileSync(publicPath, publicBuf);        // 公开副本（地理元数据已脱敏）
  return {
    id, mime, originalPath, publicPath, publicSha256,
    strippedMetadata: removed,
    originalRetained: true,
    accessLevel: 'restricted',
  };
}
