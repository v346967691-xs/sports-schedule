# KPL schedule_status 语义复查（自动化任务）

## 2026-10-02 首次执行

- 结果：**发现并修正了映射错误**。旧代码 `2='live'` 是猜的，官方语义 `2=已取消`、`3=进行中`。
- 取证方式：实拉 API 得分布后仍无法判定 2/3，转而在官网 kpl.qq.com 的懒加载 chunk
  `/static/Schedule-B0oR1B8y.js` 中找到 `({1:"未开始",2:"已取消",3:"进行中",4:"已结束"})` 映射。
- 改动文件：`tools/sync.js`（映射 + 注释 + 丢弃已取消）、`tools/standings.js`（排除进行中）。
- 流水线结果：smoke 235 全绿、cloud-sync 推送成功（1575 场）、check-cloud 0 分钟、已推 GitHub（21782a9）、未发版。
- 赛季首日比分：广州TTG 3:0 深圳DYG。

## 下次再跑要注意

- 语义已确定并写进代码注释，**无需再复查**，除非官网换掉前端构建。
- KPL 积分榜要赛季打满 4 场才会出现（standings.js 的 `rows.length < 4` 保护），赛季初期「失败」是正常的。
- 想核实：直接 `node tools/probe-kpl-status.js` 看实时分布。
