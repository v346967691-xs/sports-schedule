const ROLES = { top: '上路', jungle: '打野', mid: '中路', bottom: '下路', support: '辅助' }
const MVP_ROLES = { top: '上单', jungle: '打野', mid: '中单', bottom: '下路', support: '辅助' }
const ORDER = ['top', 'jungle', 'mid', 'bottom', 'support']
const normalizeRole = role => {
  const key = String(role || '').trim().toLowerCase()
  if (key === 'bot' || key === 'adc') return 'bottom'
  return ROLES[key] ? key : ''
}
const value = n => n == null ? '—' : String(n)
const championIcon = id => typeof id === 'string' && /^[A-Za-z0-9]+$/.test(id)
  ? `https://game.gtimg.cn/images/lol/act/img/champion/${id}.png` : ''
function buildLol(detail, homeLabel, awayLabel) {
  if (!detail || !detail.lol || !Array.isArray(detail.lol.rounds) || !detail.lol.rounds.length) return null
  const side = (t, label) => ({
    label, side: t ? (t.side === 'blue' ? '蓝方' : '红方') : '',
    kills: value(t && t.kills), gold: value(t && t.gold), towers: value(t && t.towers),
    dragons: value(t && t.dragons), barons: value(t && t.barons),
    players: t ? (t.players || []).map(p => ({
      id: p.id, playerId: p.playerId || '', teamId: t && t.id || '',
      name: p.name || '—', champion: p.champion || '—', roleKey: normalizeRole(p.role), role: ROLES[normalizeRole(p.role)] || p.role || '—',
      icon: championIcon(p.champion),
      k: p.k, d: p.d, a: p.a, csTotal: p.cs, goldTotal: p.gold,
      kda: `${value(p.k)} / ${value(p.d)} / ${value(p.a)}`, cs: value(p.cs), gold: value(p.gold),
    })) : [],
  })
  const rounds = detail.lol.rounds.map(r => {
    const teams = [side(r.h, homeLabel), side(r.a, awayLabel)]
    const paired = new Set()
    const rows = ORDER.map(roleKey => ({
      key: roleKey, label: MVP_ROLES[roleKey],
      players: teams.map(team => {
        const player = team.players.find(p => p.roleKey === roleKey)
        if (player) paired.add(player)
        return player || null
      }),
    }))
    // 缺位置或同位置多名选手时保留额外记录，不凭名单顺序猜对位。
    teams.forEach((team, teamIndex) => team.players.forEach((player, playerIndex) => {
      if (paired.has(player)) return
      const players = [null, null]
      players[teamIndex] = player
      rows.push({ key: `extra:${teamIndex}:${playerIndex}`, label: MVP_ROLES[player.roleKey] || '未标注', players })
    }))
    return {
      n: r.n, id: r.id, complete: !!r.complete,
      note: r.complete ? '终局数据' : r.state === 'paused' ? '数据停留在暂停时刻，尚未补齐' : '单局数据尚未补齐',
      teams, rows,
    }
  })
  return { rounds, active: 0, complete: !!detail.lol.complete }
}

function buildMvpCandidates(detail, homeLabel, awayLabel) {
  const rounds = detail && detail.lol && detail.lol.rounds
  if (!Array.isArray(rounds) || !rounds.length || !detail.lol.complete) return []
  const candidates = new Map()
  rounds.filter(r => r.complete).forEach((round) => {
      ;[round.h, round.a].forEach((team, teamIndex) => {
      if (!team) return
      ;(team.players || []).forEach((player) => {
        if (!player.complete || player.k == null || player.d == null || player.a == null
          || player.cs == null || player.gold == null) return
        const name = String(player.name || '').trim()
        const roleKey = normalizeRole(player.role)
        const key = player.playerId ? `riot:${player.playerId}`
          : `fallback:${team.id}:${name.toLowerCase()}`
        if (!name || !roleKey || key.endsWith(':')) return
        let candidate = candidates.get(key)
        if (!candidate) {
          candidate = {
            key, playerId: player.playerId || '', name, teamId: team.id,
            side: teamIndex === 0 ? 'home' : 'away',
            team: teamIndex === 0 ? homeLabel : awayLabel,
            roleKey, role: MVP_ROLES[roleKey],
            games: 0, k: 0, d: 0, a: 0, cs: 0, gold: 0, champions: [],
          }
          candidates.set(key, candidate)
        }
        candidate.games += 1
        candidate.k += player.k
        candidate.d += player.d
        candidate.a += player.a
        candidate.cs += player.cs
        candidate.gold += player.gold
        if (player.champion && !candidate.champions.some(c => c.id === player.champion)) {
          candidate.champions.push({ id: player.champion, name: player.champion, icon: championIcon(player.champion) })
        }
      })
    })
  })
  return Array.from(candidates.values()).map(candidate => Object.assign(candidate, {
    championText: `英雄：${candidate.champions.map(c => c.name).join(' / ')}`,
  })).sort((a, b) => b.k - a.k || b.a - a.a || a.d - b.d || a.name.localeCompare(b.name))
}

function buildMvpMatchups(candidates) {
  const rows = ORDER.map(roleKey => ({
    roleKey, label: MVP_ROLES[roleKey], home: [], away: [],
  }))
  const byRole = Object.fromEntries(rows.map(row => [row.roleKey, row]))
  ;(candidates || []).forEach(candidate => {
    const row = byRole[candidate.roleKey]
    if (row && row[candidate.side]) row[candidate.side].push(candidate)
  })
  rows.forEach(row => {
    ;['home', 'away'].forEach(side => row[side].sort((a, b) =>
      b.games - a.games || b.k - a.k || a.d - b.d || a.name.localeCompare(b.name)))
  })
  return rows.filter(row => row.home.length || row.away.length)
}

module.exports = { buildLol, buildMvpCandidates, buildMvpMatchups }
