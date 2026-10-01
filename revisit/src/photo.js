// 照片地理元数据脱敏（公开用途）：JPEG 去除 APP1(EXIF/XMP)、COM；PNG 去除 eXIf 块。
// 原件受限保留在 data/photostore/originals，不经过静态目录对外暴露。
import { createHash } from 'node:crypto';

const JPEG_SOI = 0xFFD8;
const APP_MARKERS = new Set([0xFFE1, 0xFFED, 0xFFEE]); // EXIF/XMP(APP1)、Photoshop(APP13)、Comment 以外扩展

export function detectMime(buf) {
  if (buf.length > 2 && buf[0] === 0xFF && buf[1] === 0xD8) return 'image/jpeg';
  if (buf.length > 8 && buf[1] === 0x50 && buf[2] === 0x4E && buf[3] === 0x47) return 'image/png';
  return null;
}

// 解析 JPEG 段并输出去掉地理/EXIF 元数据的公开副本
export function stripJpeg(buf) {
  if (buf.readUInt16BE(0) !== JPEG_SOI) throw new Error('not a jpeg');
  const kept = [Buffer.from([0xFF, 0xD8])];
  let off = 2;
  let removed = [];
  while (off < buf.length) {
    if (buf[off] !== 0xFF) throw new Error('invalid jpeg marker');
    // 填充字节
    while (off < buf.length && buf[off] === 0xFF) off++;
    const marker = 0xFF00 | buf[off];
    off += 1;
    if (marker === 0xFFD9) { kept.push(Buffer.from([0xFF, 0xD9])); break; } // EOI
    if (marker >= 0xFFD0 && marker <= 0xFFD7) { kept.push(Buffer.from([0xFF, marker & 0xFF])); continue; } // RST
    if (marker === 0xFFDA) { // SOS：剩余全部为扫描数据，原样保留
      kept.push(buf.subarray(off - 2));
      break;
    }
    if (off + 2 > buf.length) throw new Error('truncated jpeg segment');
    const len = buf.readUInt16BE(off);
    const seg = buf.subarray(off - 2, off + len); // 含 marker 与长度
    const isExif = marker === 0xFFE1 && (
      seg.subarray(4, 9).toString('latin1') === 'Exif\0' ||
      seg.subarray(4, 7).toString('latin1') === 'http'
    );
    const isComment = marker === 0xFFFE;
    const isPhotoshop = marker === 0xFFED;
    if (isExif || isComment || isPhotoshop) {
      removed.push(isExif ? 'EXIF/XMP' : isComment ? 'COM' : 'APP13');
    } else {
      kept.push(Buffer.from(seg));
    }
    off += len;
  }
  return { publicBuf: Buffer.concat(kept), removed };
}

// PNG CRC32
const crcTable = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();
function crc32(buf) {
  let c = 0xFFFFFFFF;
  for (const b of buf) c = crcTable[(c ^ b) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

export function stripPng(buf) {
  const signature = buf.subarray(0, 8);
  if (signature.toString('hex') !== '89504e470d0a1a0a') throw new Error('not a png');
  const chunks = [signature];
  let off = 8, removed = [];
  while (off < buf.length) {
    const len = buf.readUInt32BE(off);
    const type = buf.subarray(off + 4, off + 8).toString('latin1');
    const data = buf.subarray(off + 8, off + 8 + len);
    if (type === 'eXIf') { removed.push('eXIf'); off += 12 + len; continue; }
    // 重算 CRC（原样保留其余块）
    const body = Buffer.concat([Buffer.from(type, 'latin1'), data]);
    const out = Buffer.alloc(12 + len);
    out.writeUInt32BE(len, 0);
    out.write(type, 4, 'latin1');
    data.copy(out, 8);
    out.writeUInt32BE(crc32(body), 8 + len);
    chunks.push(out);
    off += 12 + len;
  }
  return { publicBuf: Buffer.concat(chunks), removed };
}

export function sanitizePhoto(buf) {
  const mime = detectMime(buf);
  if (!mime) throw new Error('unsupported image type; only jpeg/png accepted');
  const res = mime === 'image/jpeg' ? stripJpeg(buf) : stripPng(buf);
  const sha = createHash('sha256');
  sha.update(res.publicBuf);
  return { mime, ...res, publicSha256: sha.digest('hex') };
}

// 原始文件是否疑似携带 EXIF（用于验收断言）
export function hasExif(buf) {
  if (detectMime(buf) === 'image/jpeg') {
    for (let off = 2; off + 4 < buf.length; ) {
      if (buf[off] !== 0xFF) break;
      const m = buf[off + 1];
      if (m === 0xDA || m === 0xD9) break;
      const len = buf.readUInt16BE(off + 2);
      if (m === 0xE1 && buf.subarray(off + 4, off + 9).toString('latin1') === 'Exif\0') return true;
      off += 2 + len;
    }
    return false;
  }
  return buf.subarray(12, 16).toString('latin1') === 'eXIf';
}
