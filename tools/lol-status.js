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
  const finished = evObj.state === 'completed' || hasResult
  const live = !finished && evObj.state === 'inProgress'
  return {
    status: finished ? 'finished' : live ? 'live' : 'upcoming',
    statusText: finished ? '已结束' : live ? '进行中' : '',
    homeScore: gameWins(rh, finished),
    awayScore: gameWins(ra, finished),
  }
}

module.exports = { lolStatus, gameWins }
