/** 页面、云端生成与分享长图共用的 S 赛晨报事实模型。 */
const worlds = require('./worlds')
const bracket = require('./bracket')
const view = require('./view')
const PUBLISH_HOUR = 9
const REFRESH_HOUR = 14
function editionHour(date, now) {
  if (now < Date.parse(date + 'T09:00:00+08:00')) return null
  return now < Date.parse(date + 'T14:00:00+08:00') ? PUBLISH_HOUR : REFRESH_HOUR
}
const name = team => team && (team.zhName || team.zh || team.name || team.abbr || team.id) || '待定'
function lplTeamIds(list) {
  const ids = new Set()
  ;(list || []).filter(m => m.comp === 'lpl').forEach(m => [m.home, m.away].forEach(t => {
    if (t && t.id && t.id !== 'TBD') ids.add(String(t.id))
  }))
  return Array.from(ids)
}
function validDate(date) {
  const t = Date.parse(date + 'T00:00:00+08:00')
  return /^2026-\d{2}-\d{2}$/.test(date || '') && Number.isFinite(t) && worlds.beijingDay(t) === date
}
function build(list, date, now, opt) {
  const at = now == null ? Date.now() : Number(now)
  const day = validDate(date) ? date : worlds.beijingDay(at)
  const midnight = Date.parse(day + 'T00:00:00+08:00')
  const end = midnight + 12 * 3600000
  const ids = opt && opt.lplIds || lplTeamIds(list)
  const isLpl = m => [m.home, m.away].some(t => worlds.isLplTeam(t, ids))
  const all = worlds.eventMatches(list)
  const overnight = all.filter(m => Date.parse(m.start) >= midnight - 6 * 3600000 && Date.parse(m.start) < end)
  const row = m => {
    const scored = m.home && m.away && Number.isFinite(m.home.score) && Number.isFinite(m.away.score)
    return {
      id: m.id, home: name(m.home), away: name(m.away),
      score: scored ? `${m.home.score} : ${m.away.score}` : 'VS',
      homeScore: scored ? m.home.score : null, awayScore: scored ? m.away.score : null,
      bestOf: Number(m.bo) || 0,
      homeWin: m.status === 'finished' && scored && m.home.score > m.away.score,
      awayWin: m.status === 'finished' && scored && m.away.score > m.home.score,
      status: m.status, statusText: m.status === 'finished' ? '已结束' : m.status === 'live' ? (m.statusText || '进行中') : '等待开赛',
      stage: view.roundLabel(m.stage, '全球总决赛'),
      time: worlds.timeLabel(m, at), isLpl: isLpl(m),
    }
  }
  const finished = overnight.filter(m => m.status === 'finished').map(row)
  const lplResults = finished.filter(m => m.isLpl)
  const otherFinished = finished.filter(m => !m.isLpl)
  const live = overnight.filter(m => m.status === 'live').map(row)
  const waiting = overnight.filter(m => m.status === 'upcoming' && Date.parse(m.start) <= at).map(row)
  const focus = lplResults[lplResults.length - 1] || finished[finished.length - 1]
  const upcoming = all.filter(m => m.status === 'upcoming' && Date.parse(m.start) > at)
  const nextDay = upcoming.length ? upcoming[0].date : ''
  const next = upcoming.filter(m => m.date === nextDay).map(row)
  const groups = bracket.swissGroups(all.filter(m => Date.parse(m.start) <= Math.min(at, end)), '全球总决赛')
  const qualification = groups.map(g => ({
    record: g.key, text: worlds.qualification(g.wins, g.losses),
    teams: g.teams.map(t => t.name).join(' / '),
  }))
  const headline = match => {
    if (!match || !Number.isFinite(match.homeScore) || !Number.isFinite(match.awayScore) || match.homeScore === match.awayScore) return ''
    const homeWon = match.homeScore > match.awayScore
    const winner = homeWon ? match.home : match.away
    const loser = homeWon ? match.away : match.home
    const winnerScore = homeWon ? match.homeScore : match.awayScore
    const loserScore = homeWon ? match.awayScore : match.homeScore
    const games = match.homeScore + match.awayScore
    if (match.bestOf === 5 && games === 5) return `${winner}苦战5局力克${loser}`
    if (match.bestOf === 3 && games === 3) return `${winner}鏖战3局力克${loser}`
    if (match.bestOf === 3 && loserScore === 0) return `${winner}直落两局击败${loser}`
    if (match.bestOf === 5 && loserScore === 0) return `${winner}零封${loser}`
    return `${winner}以${winnerScore}:${loserScore}击败${loser}`
  }
  let title = '赛场即将点亮'
  let lead = next.length ? `下一比赛日有 ${next.length} 场已公布对阵。` : '等待官方公布下一比赛日对阵。'
  if (focus) {
    title = headline(focus) || `${focus.home}战胜${focus.away}`
    lead = `昨夜至今晨已有 ${finished.length} 场系列赛结束${live.length ? `，${live.length} 场仍在进行` : ''}。${focus.stage || '全球总决赛'}战况如下。`
  } else if (live.length) {
    title = '战况正在展开'
    lead = `有 ${live.length} 场系列赛正在进行，最终赛果尚未产生。晨报会在后续同步时更新。`
  } else if (waiting.length) {
    title = '等待官方更新战况'
    lead = '计划开赛时间已到，当前尚未确认开赛或结束状态。请以官方发布为准。'
  }
  return {
    version: 1, id: `worlds-morning-${day}`, date: day,
    pubAt: new Date(midnight + PUBLISH_HOUR * 3600000).toISOString(),
    updatedAt: new Date(at).toISOString(),
    editionHour: editionHour(day, at),
    editionLabel: editionHour(day, at) === REFRESH_HOUR ? '14:00 更新版' : '09:00 首版',
    title, lead, finished, live, waiting, next, nextDay,
    lpl: lplResults, otherFinished, qualification,
    finishedCount: finished.length, liveCount: live.length,
    phase: (focus || live[0] || next[0] || {}).stage || '2026 全球总决赛',
    isDraft: at < midnight + PUBLISH_HOUR * 3600000,
    note: '北京时间 09:00 首发，14:00 更新；已结束显示赛果，进行中显示最新可用局分。',
  }
}
module.exports = { build, lplTeamIds, validDate, PUBLISH_HOUR, REFRESH_HOUR, editionHour }
