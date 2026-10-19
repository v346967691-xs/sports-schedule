const worlds = require('../../utils/worlds')
// Five-round, 16-team Swiss format; these are slots, never predicted pairings.
const FORMAT = [[['0-0', 8]], [['1-0', 4], ['0-1', 4]], [['2-0', 2], ['1-1', 4], ['0-2', 2]], [['2-1', 3], ['1-2', 3]], [['2-2', 3]]]
const actual = t => t && t.id && !/^TBD|待定|待公布/i.test(String(t.id)) && !/^TBD|待定|待公布/i.test(String(t.name || ''))
const name = t => t.zhName || t.zh || t.abbr || t.name || t.id
function record(t) {
  return t && Number.isInteger(t.wins) && Number.isInteger(t.losses) && t.wins >= 0 && t.losses >= 0 && t.wins < 3 && t.losses < 3
    ? `${t.wins}-${t.losses}` : ''
}
function outcome(m) {
  if (m.status !== 'finished' || ![1, 3].includes(Number(m.bo))) return null
  const h = m.home.score, a = m.away.score, target = Math.floor(Number(m.bo) / 2) + 1
  if (!Number.isInteger(h) || !Number.isInteger(a) || h < 0 || a < 0 || h === a) return null
  return h === target && a < target ? 'home' : a === target && h < target ? 'away' : null
}
function card(m) {
  const winner = outcome(m)
  return { id: m.id, home: name(m.home), away: name(m.away), homeScore: m.home.score, awayScore: m.away.score,
    hasScore: ['live', 'finished'].includes(m.status) && Number.isFinite(m.home.score) && Number.isFinite(m.away.score),
    homeWin: winner === 'home', awayWin: winner === 'away',
    lpl: [m.home, m.away].some(t => worlds.isLplTeam(t)), status: m.status,
    statusLabel: m.status === 'finished' ? '已结束' : m.status === 'live' ? (m.statusText || '进行中') : '未开始',
    time: `${m.date || ''} ${m.time || '时间待定'}`, bo: m.bo ? `BO${m.bo}` : '' }
}
function build(list) {
  const matches = [...new Map(worlds.eventMatches(list).filter(m => /瑞士|swiss/i.test(m.stage || '') && m.status !== 'canceled').map(m => [m.id, m])).values()]
  const pairs = matches.filter(m => actual(m.home) && actual(m.away) && String(m.home.id) !== String(m.away.id))
  const first = matches.slice(0, 8)
  const seedIds = first.flatMap(m => [m.home, m.away]).filter(actual).map(t => String(t.id))
  // A complete opening day anchors the history. A rolling later-round snapshot must not masquerade as Round 1.
  const completeOpening = first.length === 8 && first.every(m => m.date === '2026-10-24') && new Set(seedIds).size === 16
  const teams = new Map(pairs.flatMap(m => [m.home, m.away]).map(t => [String(t.id), t]))
  const ledger = new Map(completeOpening ? seedIds.map(id => [id, { wins: 0, losses: 0, blocked: false }]) : [])
  const rounds = FORMAT.map((groups, i) => ({ number: i + 1, key: `swiss-round-${i + 1}`, title: `第${i + 1}轮`, count: 0,
    groups: groups.map(([key, slots]) => {
      const [w, l] = key.split('-').map(Number)
      return { key, label: `${w}胜${l}负`, slots, matches: [], missing: slots,
        tone: w === 2 && l === 2 ? 'deciding' : w === 2 ? 'advance' : l === 2 ? 'eliminate' : '',
        hint: w === 2 && l === 2 ? '胜者晋级 · 败者淘汰' : w === 2 ? '胜者晋级' : l === 2 ? '败者淘汰' : '' }
    }) }))
  const unplaced = [], roundByMatch = {}
  for (const m of pairs) {
    const h = ledger.get(String(m.home.id)), a = ledger.get(String(m.away.id))
    const historical = h && a && !h.blocked && !a.blocked && record(h) && record(h) === record(a)
    const official = m.status !== 'finished' && record(m.home) && record(m.home) === record(m.away)
    const key = historical ? record(h) : official ? record(m.home) : ''
    const n = key ? key.split('-').map(Number).reduce((sum, v) => sum + v, 1) : 0
    const round = rounds[n - 1], group = round && round.groups.find(g => g.key === key)
    if (group && group.matches.length < group.slots) {
      group.matches.push(card(m)); round.count++; roundByMatch[m.id] = n
    } else unplaced.push(card(m))
    const winner = outcome(m)
    if (historical && group && winner) {
      h[winner === 'home' ? 'wins' : 'losses']++
      a[winner === 'away' ? 'wins' : 'losses']++
    } else {
      if (h) h.blocked = true
      if (a) a.blocked = true
    }
  }
  rounds.forEach(r => r.groups.forEach(g => { g.missing = g.slots - g.matches.length }))
  const settled = [...ledger].filter(([, r]) => !r.blocked && (r.wins === 3 || r.losses === 3)).map(([id, r]) => ({ id, name: name(teams.get(id)), record: `${r.wins}–${r.losses}`, wins: r.wins }))
  const live = pairs.find(m => m.status === 'live' && roundByMatch[m.id])
  const latest = pairs.filter(m => m.status === 'finished' && roundByMatch[m.id]).pop()
  const activeRound = live ? roundByMatch[live.id] : latest ? Math.min(5, roundByMatch[latest.id] + (rounds[roundByMatch[latest.id] - 1].groups.every(g => g.matches.length === g.slots && g.matches.every(c => c.status === 'finished')) ? 1 : 0)) : 1
  return { rounds, unplaced, published: pairs.length, roundByMatch, activeRound,
    qualified: settled.filter(t => t.wins === 3), eliminated: settled.filter(t => t.wins !== 3) }
}
module.exports = { FORMAT, build }
