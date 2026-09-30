/**
 * 赛事补录表（ESPN 覆盖不到的比赛）
 * ============================================================
 * 为什么需要它：
 *   ESPN 的 218 个足球联赛里**没有亚运会**（只有 fifa.olympics / afc.asian.cup /
 *   fifa.world.u17 / u20 这些），所以中国 U23 亚运队的比赛抓不到 ——
 *   2026 名古屋亚运会（9/19–10/4）期间尤其明显。
 *   这类短期的、ESPN 未收录的赛事，就用这张表人工补录，sync 会并进 data/matches.js。
 *
 * 用法：
 *   1) 往下面的数组里加一场，字段照抄现有条目（字段含义见 sync.js 的 normalize 部分）；
 *   2) node tools/sync.js（或只刷 chn：node tools/sync.js 14 45 chn）；
 *   3) 提交推送，下一班 GitHub Actions 会把新数据带上，小程序不用重新发版。
 *
 * ⚠️ 两个约定：
 *   - id 用 `man-` 开头，避免和 ESPN 的 id 撞车；
 *   - 比分**不会自动更新**（没有可用的公开源）。比赛结束后要么手动把
 *     status/statusText/score 补上，要么就让它过期自动下架：
 *     开赛超过 48 小时仍是 upcoming 的补录比赛，sync 会自动丢弃，
 *     免得列表里长期挂着一场「未开始」的过期比赛。
 */

module.exports = [
  {
    // 2026 名古屋亚运会男足半决赛：中国 U23 亚运队 vs 韩国 U23
    // 北京时间 9/30 14:00，大阪市长居陆上竞技场（中立场）
    id: 'man-chn-u23-ag-2026-sf',
    comp: 'chn',
    start: '2026-09-30T06:00Z',
    date: '2026-09-30',
    time: '14:00',
    status: 'finished',
    statusText: '已结束',
    stage: '亚运会男足 · 半决赛',
    venue: '大阪市长居陆上竞技场',
    broadcast: [],
    bo: null,
    home: { id: 'chn-u23', name: 'China U23', zh: '中国U23亚运队', abbr: 'CHN', color: '#C8102E', score: 1 },
    away: { id: 'kor-u23', name: 'Korea U23', zh: '韩国U23', abbr: 'KOR', color: '#CD2E3A', score: 2 },
  },
]
