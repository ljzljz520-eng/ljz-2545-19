// 全局策略参数（集中管理，便于验收核对）
export const config = {
  corridorM: 25,          // 轨迹点命中路段的走廊半宽（米），超过即判定为漂移
  driftRatio: 1,          // 命中点占比阈值（当前仅统计命中点，漂移点不参与覆盖）
  coverRatio: 0.8,        // 单段需覆盖的累计投影长度比例
  maxAccuracyM: 35,       // accuracy 超过该值的点视为漂移点，不参与覆盖
  maxClockSkewMs: 5 * 60 * 1000, // 设备时钟与服务器时钟允许偏差（5 分钟）
  defaultIntervalDays: 30,       // 回访有效期（天）
  bodyLimit: 30 * 1024 * 1024,   // 事件 JSON（含 base64 附件）体积上限
  restrictedToken: process.env.REVISIT_ADMIN_TOKEN || 'restricted-demo-token',
};
