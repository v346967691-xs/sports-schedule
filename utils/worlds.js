/** Worlds 2026 视图：赛事范围、北京时间与官方战绩，不从比分累加排名。 */
const bracket = require('./bracket')
const view = require('./view')
const archive = require('./worlds-archive')
const FROM = '2026-10-15'
const TO = '2026-11-15'
const OFFSET = 8 * 60 * 60 * 1000
// 2026 Primer 官方参赛名单；赛程快照滚动裁剪后仍能识别本届四支 LPL 队。
// https://lolesports.com/en-GB/news/worlds-2026-primer
const LPL_CODES = ['AL', 'BLG', 'TES', 'IG']

function isLplTeam(team, lplIds) {
  if (!team) return false
  if ((lplIds || []).indexOf(String(team.id)) >= 0) return true
  return [team.id, team.abbr, team.name].some((value) => LPL_CODES.indexOf(String(value || '').trim().toUpperCase()) >= 0)
}

function beijingDay(now) {
  return new Date(Number(now) + OFFSET).toISOString().slice(0, 10)
}
function eventMatches(list) {
  return (list || []).filter(archive.isWorlds2026)
    .slice().sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
}
function timeLabel(m, now) {
  const today = beijingDay(now == null ? Date.now() : now)
  const tomorrow = beijingDay((now == null ? Date.now() : Number(now)) + 86400000)
  const hour = m.time ? Number(String(m.time).split(':')[0]) : NaN
  let relative = ''
  if (m.date === today) relative = hour < 6 ? '今天凌晨' : hour < 7 ? '今天清晨' : hour >= 18 ? '今晚' : '今天'
  if (m.date === tomorrow) relative = hour < 6 ? '明天凌晨' : hour < 7 ? '明天清晨' : hour >= 18 ? '明晚' : '明天'
  return `${relative ? relative + ' · ' : ''}${m.date} ${m.time || '时间待定'} 北京时间`
}
function filterMatches(list, filter, opt) {
  const o = opt || {}
  if (filter === 'lpl') {
    const ids = o.lplIds || []
    return list.filter((m) => [m.home, m.away].some((t) => isLplTeam(t, ids)))
  }
  if (filter === 'followed') return list.filter((m) => (o.teams || []).some((t) => o.matchHasTeam(m, t)))
  return list.slice()
}
function qualification(wins, losses) {
  if (!Number.isInteger(wins) || !Number.isInteger(losses) || wins < 0 || losses < 0 || wins > 3 || losses > 3 || (wins === 3 && losses === 3)) return ''
  if (wins === 3) return '已晋级'
  if (losses === 3) return '已淘汰'
  if (wins === 2 && losses === 2) return '晋级 / 淘汰关键战'
  if (wins === 2) return '再胜1场晋级'
  if (losses === 2) return '再负1场淘汰'
  return `还需${3 - wins}胜晋级`
}
function build(list, opt) {
  const o = opt || {}
  const all = eventMatches(list)
  const visible = filterMatches(all, o.filter, o)
  const decorate = (m) => Object.assign({}, view.decorate.call({ compOf: o.compOf }, m), { _worldsTime: timeLabel(m, o.now) })
  const live = visible.filter((m) => m.status === 'live').map(decorate)
  const upcoming = visible.filter((m) => m.status === 'upcoming').map(decorate)
  const finished = visible.filter((m) => m.status === 'finished').reverse().map(decorate)
  return {
    live, upcoming, finished,
    next: live[0] || upcoming[0] || null,
    total: visible.length,
    swiss: bracket.swissGroups(all, '全球总决赛').map((g) => Object.assign({}, g, { qualification: qualification(g.wins, g.losses) })),
    bracket: bracket.buildBracket(all, '全球总决赛'),
  }
}
module.exports = { FROM, TO, beijingDay, eventMatches, timeLabel, isLplTeam, filterMatches, qualification, build }
