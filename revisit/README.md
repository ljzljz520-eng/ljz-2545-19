# 路况离线回访系统（road-revisit）

移动巡查人员在**离线**状态下用手机网页记录路况、噪声与照片，联网后回传；后台接收事件与附件，
把每条观察绑定到 **人员 + 几何版本 + 实际覆盖路段**，并分别按**整路线有效期**与**分段覆盖有效期**
两种模型计算复查状态。

零外部依赖（仅 Node.js ≥ 18 内置模块），可直接运行与验收。

## 运行

```bash
cd revisit
npm run seed     # 写入演示数据（5 条路线、冲突/晚上传/改线等场景、带 GPS EXIF 照片）
npm start        # http://localhost:8080 ，手机浏览器打开
npm test         # 48 项零依赖自动验收（动态端口、固定验收时钟、临时数据目录）
```

演示账号：`p_alice` / `p_bob`（巡查员）、`p_admin`（管理员，可取照片原件）。

## 领域模型与关键规则

- **观察三元绑定**：每个事件保存 `personId`、`geometryVersion`、沿线覆盖区间（轨迹或人工范围）。
- **带误差轨迹匹配**：轨迹点投影到路线折线，落在 `toleranceM`（默认 30m）缓冲带内才算覆盖；
  相邻匹配点间距超过 `maxGapM`（默认 80m）断开，中间为**漏段**；带外点记为 **GPS 漂移**。
  漂移与漏段在覆盖页显示“未核”原因，不会当作已核。
- **人工范围**：无轨迹时可按桩号 `fromM/toM` 或起止坐标圈定实际覆盖路段，同样存证入库。
- **部分路线不刷新整条日期**：覆盖状态用“时间线”表示——沿线切分成最小单元，每个单元保留
  自己的观察时刻；任何范围的“最近全覆盖时刻”取连续填满该范围的各单元观察时刻的**最小值（短板）**。
  走完前 1/3 只更新前 1/3，绝不会把整条路线的复查日期刷新成今天。
- **两种有效期模型**（`validityDays`，默认 30 天）：
  - `wholeRoute`：必须有一次连续全覆盖，锚点是“完成全覆盖所需的最旧观察时刻”；
  - `perSegment`：每个分段独立判定（有效 / 超期 / 未核），路线整体取最短板。
  - 页面与 `GET /api/routes/:id/validity?both=1` 同时给出两种结果以便比较。
- **设备时间 ≠ 服务器时间**：事件分开保存 `observedAt`（设备声称，含 ±5 分钟偏差校验）与
  `receivedAt`（服务器裁决时钟）。晚上传标 `lateUpload` 且**不冒充今天**；设备时间超前服务器
  超过 5 分钟直接拒绝（`422 DEVICE_TIME_IN_FUTURE`）。
- **改线**：`POST /api/routes/:id/realign` 生成新几何版本；旧观察按观察时刻所生效的版本绑定
  （可显式指定 `geometryVersion` 补交），**旧回访不会更新新线位的复查日期**，改线动作写审计日志。
- **两人观察冲突**：同一几何版本、同一 30m 内、72h 窗口内两人对路面/交通/噪声档/隐患结论不一致，
  自动列入冲突清单待人工裁决。
- **附件完整性**：事件需至少 1 张照片 + 噪声读数 + 覆盖依据（轨迹或人工范围），否则
  `attachmentsComplete=false` 并在 `attachmentsMissing` 列出缺项；补传附件后自动重算。
- **照片地理元数据**：上传即解析 JPEG 的 APP1/EXIF GPS（写入受控记录），**公开件剥离 APP1(EXIF)
  与 APP13(IPTC)**；原件以 `0600` 存于 `data/originals/`，仅管理员可取（带审计），保留 90 天后拒绝。
- **离线与重试**：手机端用 `localStorage` 维护离线队列，`/api/sync/batch` 批量同步；以
  `clientEventId` / `clientAttachmentId` 幂等，同号改内容冲突返回 409；失败项保留在队列可无限重试。
- **推荐缓存失效**：推荐结果带标签化缓存（routes / events / attachments 三个标签），改线、新事件、
  新附件分别令对应标签前进，旧缓存立即失效，无需 TTL 猜测。
- **信息时效与安全声明**：页面展示“最近可确认的覆盖时点”，并明确它只表示**信息新近度**，
  **不构成对当前路况或通行安全的保证**。

## 主要 API

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/auth/dev` | 演示登录换取 HMAC 令牌 |
| POST | `/api/sync/batch` | 离线批量同步（事件+附件，逐项成败、整体幂等） |
| POST | `/api/events` | 提交单条观察 |
| POST | `/api/attachments` | 上传照片/音频（base64），返回公开件 URL |
| GET | `/api/routes` / `/api/routes/:id/validity?both=1` | 路线清单 / 覆盖与两种有效期 |
| POST | `/api/routes/:id/realign` | 改线（管理员） |
| GET | `/api/conflicts?routeId=` | 两人观察冲突 |
| GET | `/api/people/me/recommendations` | 依赖推荐（含缓存标签快照） |
| GET | `/api/attachments/:id/public` | 脱敏公开件 |
| GET | `/api/admin/attachments/:id/original` | 原件（管理员，审计，90 天） |

## 目录

```
revisit/
├─ server/
│  ├─ index.js          HTTP API + 同步/幂等/改线/鉴权
│  └─ lib/
│     ├─ geo.js         投影、折线、带误差轨迹匹配
│     ├─ coverage.js    观察绑定、时间线覆盖、两种有效期、冲突、附件完整性
│     ├─ clock.js       设备/服务器双时钟（支持 REVISIT_NOW 固定验收时钟）
│     ├─ photo.js       JPEG EXIF 解析/GPS 提取/公开件脱敏
│     ├─ recommend.js   依赖推荐 + 标签化缓存失效
│     └─ store.js       JSON 文件存储（零依赖）
├─ web/                 手机网页（离线队列、轨迹/噪声/照片、覆盖时间线、免责声明）
├─ tools/seed.js        演示数据
└─ tools/acceptance.js  48 项自动验收
```

## 验收覆盖（`npm test`）

改线后补交旧回访、两人观察冲突、附件缺失、超期（两模型）、网络重试幂等、GPS 漂移/漏段未核、
晚上传/未来设备时间、照片 EXIF 脱敏与原件受控、依赖推荐缓存失效、页面“最近可确认覆盖时点”与
不保证安全的文案。
