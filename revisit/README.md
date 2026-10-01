# 道路离线回访系统（offline road revisit）

手机网页记录**路况、噪声、照片**，离线可采集、联网幂等补传；后台接收事件与附件，
数据库把**观察绑定到人员、几何版本和实际覆盖路段**；覆盖以**带误差的轨迹或人工范围**计算，
提供**整路线有效期**与**分段覆盖有效期**两种口径对比。零第三方依赖，仅使用 Node.js ≥20 内置模块。

## 运行

```bash
npm run seed          # 初始化演示数据（两人 / 一条三段路线 / 标识物 / 45天前整线旧回访）
npm start             # http://localhost:3000 手机浏览器打开（建议 Add to Home Screen）
npm test              # 11 项验收测试
```

关键环境变量：`PORT`、`REVISIT_DATA_DIR`（默认 `./data`）、
`REVISIT_ADMIN_TOKEN`（原件访问令牌，默认 `restricted-demo-token`）、
`REVISIT_ALLOW_TIME_TRAVEL=1`（仅测试用，允许 `x-simulated-time` 模拟服务器时间）。

## 需求 → 实现对照

| 需求 | 实现 |
| --- | --- |
| 离线回访，手机网页记录路况/噪声/照片 | `public/`：PWA + Service Worker 外壳缓存 + IndexedDB 离线队列；路况枚举、噪声 dB(A)、拍照 |
| 后台接收事件及附件 | `POST /api/events`（JSON+base64），事件先落库，附件落盘并登记 `photoFiles` |
| 观察绑定人员、几何版本、实际覆盖路段 | `observations` 含 `personId / versionId`；覆盖段由 `src/coverage.js` 从轨迹/人工范围计算后写进覆盖结果 |
| 走完部分路线不刷新整条复查日期 | 覆盖按段独立；整路线要求全部段覆盖，且最近可确认时点取**最旧的一段**（短板），见测试 1 |
| 带误差轨迹 / 人工范围计算覆盖 | 点→折线垂足投影，走廊 25m、覆盖半径 15m（`FOOTPRINT_M`）、段覆盖阈值 0.8；`manualRanges` 人工声明并打 `manual-range` 标记 |
| GPS 漂移、低精度点、漏段显示未核 | 偏离走廊或 `accuracy>35m` 不计入覆盖，仅统计漂移点；段状态 `unverified-drift / unverified-missing`，见测试 2 |
| 设备时间与服务器收到时间分开 | 观察同时保存 `deviceTime`、`receivedAt`、`deviceTimeInfo{trusted,skewMs}`、`confirmedAt`（`src/time.js`） |
| 晚上传不能冒充今天刚走 | 偏差 > 5 分钟即 `trusted=false`：几何覆盖仍成立，但时间段状态为 `time-unverifiable`，不宣称新鲜，见测试 3 |
| 整路线有效期 vs 分段覆盖有效期 | 覆盖结果同时返回 `wholeRoute`（短板口径）与 `perSegment`（各段独立计数） |
| 标识更新与依赖推荐缓存失效 | `src/cache.js` 依赖键版本号；更新标识物 / 发布几何版本 / 新观察 → bump 依赖 → 推荐缓存 MISS，见测试 10 |
| 照片地理元数据按公开用途脱敏 | JPEG 剥离 APP1(EXIF/XMP)/APP13/COM，PNG 剥离 eXIf（`src/photo.js`），公开副本经 `/api/photos/:id` |
| 原件受限保留 | 原件存 `data/photostore/originals`（不暴露静态目录），`/api/admin/photos/:id/original` 需令牌并写 `attachmentAccess` 审计，见测试 9 |
| 改线后补交旧回访 | 可显式 `versionId` 提交到旧版；观察打 `submittedAgainstVersion` 标记；不污染新版覆盖，旧版可单独查询并提示有新版，见测试 4 |
| 两人观察冲突 | 同段两条不同人员的覆盖观察若路况结论不同，均保留并打冲突，进入最高优先级推荐，见测试 5 |
| 附件缺失 | 事件仍入库，观察 `status=incomplete / attachmentsMissing`；以同 `clientEventId` 重试可补传并转 complete，见测试 6 |
| 超期 | 超过 `intervalDays`（默认 30 天）→ 整线 `expired`、分段计数独立，见测试 7 |
| 网络重试 | `clientEventId` 幂等：不产生重复事件/观察/附件，见测试 8 |
| 页面解释最近可确认覆盖时点 | `/coverage` 返回 `explanation` 文案数组，手机端「覆盖与有效期」页直接渲染 |
| 信息新近不被宣传为安全保证 | 解释与页面页脚固定声明「不构成对当前路况或通行安全的保证」 |

## 两种有效期口径

- **整路线（whole-route）**：所有分段均被可信时间的观察覆盖才算覆盖；`latestConfirmedAt`
  取最旧分段（短板），`dueAt = latestConfirmedAt + intervalDays`。只走部分路线时状态为
  `partial`，整条复查日期不刷新。
- **分段（per-segment）**：每段独立 fresh/expired/time-unverifiable；今天只走第 1 段，
  只刷新第 1 段，其余段按各自最近确认时点到期。

## 时间语义（防“晚上传冒充今天”）

- 设备时间与服务器时间偏差 ≤ 5 分钟：`confirmedAt = 设备时间`，可主张新鲜性。
- 偏差 > 5 分钟：`confirmedAt` 仅以**服务器收到时间**为保守下界，时间段状态为
  `time-unverifiable`，页面明确提示「不能计为今天刚走」。
- 测试用固定时间线（2026-08 观察、2026-10-01 评估）验证，见 `test/acceptance.test.js`。

## 目录

```
src/   config store geo time photo coverage cache recommend app server seed
public index.html app.js sw.js styles.css manifest.webmanifest   # 手机端 PWA
test/  acceptance.test.js helpers.js                             # 11 项验收
```
