# 长期项目笔记 — 闪现赛程助手

## KPL（王者荣耀）官方接口

- 赛程：`POST https://kplshop-op.timi-esports.qq.com/kplow/getScheduleList`，body `{"seasonid":""}`（空串=当前赛季），无需 key。
- `schedule_status` 取值（2026-10-02 从官网前端 Schedule chunk 取证，权威）：
  `1=未开始 / 2=已取消 / 3=进行中 / 4=已结束`。注意 **2 是已取消，不是进行中**。
- 源站会在比赛正式开播前就把 status 切成 3，属于正常现象，照它显示即可。
- 除 getScheduleList 外还有 `getScheduleDetail` / `getScheduleProgress` / `getBattleDetail` 等（见 `ci.getScheduleList` 附近的常量列表）。
  `getScheduleDetail` 传当前赛季 scheduleid 会返回 `schedule not found`，别指望它补状态。

## 查三方接口状态码语义的通用套路

先去该产品官网抓前端 JS，搜状态码字段附近的中文映射常量；SPA 的懒加载 chunk 列表写在主包 `__vite__mapDeps` 里。
比限时实拉数据猜可靠也更快。

## 验收流水线

改数据/映射后：`node tools/sync.js 14 45 <comp>` → `node tools/smoke.js`（全绿）→ `node tools/cloud-sync.js` → `node tools/check-cloud.js`。
smoke 基线会随套件扩充变化（2026-10-02 为 235 项）。数据层改动走云端，无需重新发版。
