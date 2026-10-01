'use strict';
// 设备时间与服务器时间严格分离。服务器时间为唯一裁决时钟。
// 可通过 REVISIT_NOW(ISO) 固定服务器时钟（用于可重复的验收测试）。
function now() {
  const fixed = process.env.REVISIT_NOW ? Date.parse(process.env.REVISIT_NOW) : NaN;
  return Number.isNaN(fixed) ? new Date() : new Date(fixed);
}
function iso(d = now()) { return d.toISOString(); }

// 时钟校验：设备时间允许偏差，拒绝未来时间，返回可信度标记
function checkDeviceClock(deviceIso, serverNow = new Date(), opts = {}) {
  const skewMs = opts.skewMs ?? 5 * 60 * 1000; // 允许 ±5 分钟
  const t = Date.parse(deviceIso);
  if (Number.isNaN(t)) return { ok: false, reason: 'BAD_DEVICE_TIME', deviceMs: null };
  const delta = t - serverNow.getTime();
  if (delta > skewMs) return { ok: false, reason: 'DEVICE_TIME_IN_FUTURE', deviceMs: t, deltaMs: delta };
  if (delta < -24 * 3600 * 1000) {
    return { ok: true, trusted: false, late: true, deviceMs: t, deltaMs: delta };
  }
  return { ok: true, trusted: Math.abs(delta) <= skewMs, late: false, deviceMs: t, deltaMs: delta };
}

module.exports = { now, iso, checkDeviceClock };
