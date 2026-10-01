import { config } from './config.js';

// 测试支持：允许通过请求头模拟“当前时间”，生产环境不设置环境变量即关闭。
export function nowFor(reqHeaders = {}) {
  if (process.env.REVISIT_ALLOW_TIME_TRAVEL === '1') {
    const sim = reqHeaders['x-simulated-time'];
    if (sim && !Number.isNaN(Date.parse(sim))) return new Date(sim).getTime();
  }
  return Date.now();
}

// 设备时间 vs 服务器收到时间分离核验。
// 设备时钟偏差过大则设备时间不可信：晚上传不能冒充“今天刚走”。
export function verifyDeviceTime(deviceTimeIso, serverReceivedAtMs, headers = {}) {
  const devMs = Date.parse(deviceTimeIso);
  if (Number.isNaN(devMs)) {
    return { trusted: false, deviceMs: null, skewMs: null, confirmedAt: new Date(serverReceivedAtMs).toISOString() };
  }
  const skewMs = devMs - serverReceivedAtMs;
  if (Math.abs(skewMs) <= config.maxClockSkewMs) {
    return { trusted: true, deviceMs: devMs, skewMs, confirmedAt: new Date(devMs).toISOString() };
  }
  return { trusted: false, deviceMs: devMs, skewMs, confirmedAt: new Date(serverReceivedAtMs).toISOString() };
}

export function daysAfter(iso, days) {
  return new Date(Date.parse(iso) + days * 86400000).toISOString();
}
export function isBefore(isoA, isoB) { return Date.parse(isoA) < Date.parse(isoB); }
