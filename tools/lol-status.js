/**
 * LoL Esports API 的比赛状态判定。
 *
 * ⚠️ 上游 `state` 字段会滞后（2026-09-30 亚运会实测）：
 * 比赛已经打完、`match.teams[].result.outcome` 都已经给出胜负，
 * `state` 却仍停留在 `unstarted`。只信 state 会把「已结束」误判成「未开赛」，
 * 赛果就永远拉不下来。所以这里以「有没有 outcome」为准，state 只作为辅助。
 *
 * 抽成独立模块的原因：tools/sync.js 末尾会无条件执行 main()，不能被 require，
 * 冒烟测试没法直接单测它。
 */

/** 取某一方的胜场数；没打完或上游没回填时为 null。 */
function gameWins(team, finished) {
  if (!finished || !team || !team.result) return null
  const w = team.result.gameWins
  return typeof w === 'number' ? w : null
}

/**
 * @param {object} ev getSchedule 里的一个 event
 * @returns {{status:string, statusText:string, homeScore:number|null, awayScore:number|null}}
 */
function lolStatus(ev) {
  const evObj = ev || {}
  const teams = (evObj.match && evObj.match.teams) || []
  const rh = teams[0] || null
  const ra = teams[1] || null
  const hasResult = !!(rh && rh.result && rh.result.outcome) || !!(ra && ra.result && ra.result.outcome)
  let finished = evObj.state === 'completed' || hasResult

  // 🔴 「已结束但比分不可能」降级（2026-10-06 德玛西亚杯 BRO vs NAVI 实测）：
  //    BO3 打满 3 局 2:1 结束，上游却一度给出 outcome 已定、gameWins 还是 1:1 的中间态，
  //    我们照单全收就成了「已结束 1:1」—— 比赛明明分了胜负却显示平局，用户一眼看出。
  //    判据：已结束的系列赛，**必须有一方拿到 ceil(BO/2) 个胜场**（BO3 → 2，BO5 → 3）。
  //    拿不到就把**状态**降回 live（比分保留 —— 1:1 正是前两局的真实比分），
  //    等下一班同步拿到回填后的结果再翻回来（自愈）。
  //    ⚠️ 只在双方比分都是数字时才判（比分缺失时按原状态走，避免误伤）。
  const bo = (evObj.match && evObj.match.strategy && evObj.match.strategy.count) || 0
  const need = bo > 0 ? Math.ceil(bo / 2) : 0
  const hs = gameWins(rh, finished)
  const as = gameWins(ra, finished)
  let demoted = false
  if (finished && need > 0 && typeof hs === 'number' && typeof as === 'number'
    && Math.max(hs, as) < need) {
    finished = false
    demoted = true
  }

  const live = !finished && (evObj.state === 'inProgress' || demoted)
  return {
    status: finished ? 'finished' : live ? 'live' : 'upcoming',
    statusText: finished ? '已结束' : live ? '进行中' : '',
    homeScore: hs,
    awayScore: as,
  }
}

module.exports = { lolStatus, gameWins }
