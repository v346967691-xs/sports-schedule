/** 各赛事仅使用云端详情中已核实的出场候选人，不从赛季榜或替补席补名单。 */
const { nameOf } = require('./view')
const ROLE_ORDER = ['G', 'D', 'M', 'F', 'BG', 'BF', 'BC', '1', '4', '2', '3', '5', 'X']
function matchups(candidates) {
  const groups = new Map()
  candidates.forEach(candidate => {
    const key = candidate.roleKey || 'X'
    if (!groups.has(key)) groups.set(key, { roleKey: key, label: candidate.role || '选手', home: [], away: [] })
    groups.get(key)[candidate.side].push(candidate)
  })
  return Array.from(groups.values()).sort((a, b) => {
    const rank = key => ROLE_ORDER.includes(key) ? ROLE_ORDER.indexOf(key) : ROLE_ORDER.length
    return rank(a.roleKey) - rank(b.roleKey)
  })
}

function build(raw, match, sharedKey) {
  const source = raw && raw.mvp
  if (!source || source.v !== 1 || raw.fin !== true || source.complete !== true || match.status !== 'finished'
    || !['basketball', 'football', 'kpl'].includes(source.kind) || !Array.isArray(source.candidates)) return null
  const used = new Set()
  const prefix = source.kind === 'kpl' ? /^kpl:[A-Za-z0-9_-]+$/ : /^espn:[0-9]+$/
  const candidates = source.candidates.filter(p => p && prefix.test(p.id) && p.name
    && ['home', 'away'].includes(p.side) && !used.has(p.id) && used.add(p.id)).map(p => ({
    ...p, key: p.id, team: nameOf(match[p.side]), votes: 0, isMine: false, isShared: p.id === sharedKey,
    stats: (Array.isArray(p.stats) ? p.stats : []).filter(s => s && s.label && s.value != null)
      .map(s => ({ label: String(s.label), value: String(s.value) })),
    championText: (p.champions || []).map(c => c.name).filter(Boolean).join(' / '),
  }))
  if (!candidates.some(p => p.side === 'home') || !candidates.some(p => p.side === 'away')) return null
  return {
    available: true, enabled: false, kind: source.kind, title: source.kind === 'kpl' ? '系列赛 MVP 投票' : '本场 MVP 投票',
    note: source.note || '', candidates, positions: matchups(candidates),
    homeLabel: nameOf(match.home), awayLabel: nameOf(match.away),
    myVote: '', totalVotes: 0, leaderSummary: '票数加载中',
  }
}

function withSummary(mvp, rows, sharedKey) {
  const mine = rows.find(row => row.is_mine)
  const counts = Object.fromEntries(rows.map(row => [row.player_id, Number(row.vote_count) || 0]))
  const candidates = mvp.candidates.map(p => ({ ...p, votes: counts[p.key] || 0,
    isMine: !!mine && mine.player_id === p.key, isShared: p.key === sharedKey }))
  const max = candidates.reduce((n, p) => Math.max(n, p.votes), 0)
  const leaders = candidates.filter(p => max && p.votes === max)
  return { ...mvp, enabled: true, candidates, positions: matchups(candidates),
    myVote: mine ? mine.player_id : '', totalVotes: rows.length ? Number(rows[0].total_votes) || 0 : 0,
    leaderSummary: max ? `${leaders.slice(0, 2).map(p => p.name).join(' / ')}${leaders.length > 2 ? ' 等' : ''} · ${max} 票${leaders.length > 1 ? '（并列）' : ''}` : '暂无选手得票',
  }
}
module.exports = { build, matchups, withSummary }
