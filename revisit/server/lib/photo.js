'use strict';
// 照片地理元数据：公开用途脱敏（剥离 APP1/EXIF 与 APP13/IPTC），原件受限保留
// 零依赖 JPEG 段解析；非 JPEG 不处理（原样保存，公开件标记为不可生成）

function parseSegments(buf) {
  const segs = [];
  if (buf[0] !== 0xff || buf[1] !== 0xd8) return { jpeg: false, segs };
  let offset = 2;
  while (offset + 1 < buf.length) {
    if (buf[offset] !== 0xff) { offset++; continue; }
    let marker = buf[offset + 1];
    // 填充字节
    while (marker === 0xff && offset + 2 < buf.length) { offset++; marker = buf[offset + 1]; }
    const start = offset;
    offset += 2;
    if (marker === 0xd9) { segs.push({ marker, start, end: start + 2, hasLen: false }); break; }
    if (marker === 0xda) {
      // SOS：随后是熵编码数据直到 EOI；整体保留
      const len = buf.readUInt16BE(offset);
      const sosHeaderEnd = offset + len;
      let eoi = buf.indexOf(Buffer.from([0xff, 0xd9]), sosHeaderEnd);
      if (eoi === -1) eoi = buf.length - 2;
      segs.push({ marker, start, end: eoi + 2, hasLen: false, sos: true });
      offset = eoi + 2;
      break;
    }
    if (marker >= 0xd0 && marker <= 0xd7) {
      segs.push({ marker, start, end: start + 2, hasLen: false });
      continue;
    }
    if (offset + 2 > buf.length) break;
    const len = buf.readUInt16BE(offset);
    segs.push({ marker, start, end: offset + len, hasLen: true });
    offset += len;
  }
  return { jpeg: true, segs };
}

// 剥离公开用途的元数据段
function sanitize(buf) {
  const { jpeg, segs } = parseSegments(buf);
  if (!jpeg) return { sanitized: null, stripped: [], jpeg: false };
  const dropMarkers = new Set([0xe1 /* APP1 EXIF/XMP */, 0xed /* APP13 IPTC/Photoshop */]);
  const parts = [Buffer.from([0xff, 0xd8])];
  const stripped = [];
  for (const s of segs) {
    if (dropMarkers.has(s.marker)) {
      const name = s.marker === 0xe1 ? 'APP1' : 'APP13';
      stripped.push(name);
      continue;
    }
    parts.push(buf.subarray(s.start, s.end));
  }
  return { sanitized: Buffer.concat(parts), stripped, jpeg: true };
}

// 从 EXIF(APP1/TIFF) 提取 GPS 坐标，写入审计（原件保留期内可查）
function extractGps(buf) {
  const { jpeg, segs } = parseSegments(buf);
  if (!jpeg) return null;
  const app1 = segs.find(s => s.marker === 0xe1);
  if (!app1) return null;
  const payload = buf.subarray(app1.start + 4); // 跳过 FF E1 与长度
  if (!payload.subarray(0, 4).toString('ascii').startsWith('Exif')) return null;
  const p = 6; // TIFF 在 Exif\0\0 之后；TIFF 偏移 0/1=字节序, 2/3=magic, 4..7=IFD0 指针
  const le = payload[p] === 0x49 && payload[p + 1] === 0x49;
  const be = payload[p] === 0x4d && payload[p + 1] === 0x4d;
  if (!le && !be) return null;
  const u16 = tiffOff => le ? payload.readUInt16LE(p + tiffOff) : payload.readUInt16BE(p + tiffOff);
  const u32 = tiffOff => le ? payload.readUInt32LE(p + tiffOff) : payload.readUInt32BE(p + tiffOff);
  const rawU16 = payloadOff => le ? payload.readUInt16LE(payloadOff) : payload.readUInt16BE(payloadOff);
  if (u16(2) !== 0x2a) return null;
  const ifd0 = u32(4); // TIFF 偏移

  // entry: {type,count,valueField(4字节原始区)}
  // field = 12字节条目内“值字段”的 payload 绝对下标
  function readIfd(tiffOff) {
    const entries = u16(tiffOff);
    const tags = {};
    for (let i = 0; i < entries; i++) {
      const e = tiffOff + 2 + i * 12;
      tags[u16(e)] = { type: u16(e + 2), count: u32(e + 4), field: p + e + 8 }; // 布局: tag(2) type(2) count(4) value(4)
    }
    return tags;
  }
  const fieldU32 = t => le ? payload.readUInt32LE(t.field) : payload.readUInt32BE(t.field);
  function rationalAt(tiffOff, compIdx) {
    const num = u32(tiffOff + compIdx * 8);
    const den = u32(tiffOff + compIdx * 8 + 4);
    return den === 0 ? null : num / den;
  }
  // 读第 compIdx 个分量
  function compValue(t, compIdx) {
    if (t.type === 2) { // ASCII：值字段内联
      return payload.slice(t.field, t.field + t.count).toString('ascii').replace(/\0.*$/, '');
    }
    if (t.type === 3 && t.count === 1) return rawU16(t.field); // SHORT 内联（payload 下标）
    const dataOff = fieldU32(t); // 外部数据 TIFF 偏移
    if (t.type === 5) return rationalAt(dataOff, compIdx); // RATIONAL
    if (t.type === 3) return u16(dataOff + compIdx * 2);
    return u32(dataOff + compIdx * 4);
  }
  try {
    const ifd0Tags = readIfd(ifd0);
    const gpsPtrTag = ifd0Tags[0x8825];
    if (!gpsPtrTag) return null;
    const gps = readIfd(fieldU32(gpsPtrTag));
    const latRef = gps[1] ? compValue(gps[1], 0) : 'N';
    const lonRef = gps[2] ? compValue(gps[2], 0) : 'E';
    const latT = gps[3] ? [0, 1, 2].map(i => compValue(gps[3], i)) : null;
    const lonT = gps[5] ? [0, 1, 2].map(i => compValue(gps[5], i)) : null;
    if (!latT || !lonT || latT.some(x => x == null) || lonT.some(x => x == null)) return null;
    const dms = t => t[0] + t[1] / 60 + t[2] / 3600;
    return {
      lat: (latRef === 'S' ? -1 : 1) * dms(latT),
      lng: (lonRef === 'W' ? -1 : 1) * dms(lonT)
    };
  } catch {
    return null;
  }
}

module.exports = { sanitize, extractGps, parseSegments };
