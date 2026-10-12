const ROLES = { top: '上路', jungle: '打野', mid: '中路', bottom: '下路', support: '辅助' }
const ORDER = ['top', 'jungle', 'mid', 'bottom', 'support']
const value = n => n == null ? '—' : String(n)
const championIcon = id => typeof id === 'string' && /^[A-Za-z0-9]+$/.test(id)
  ? `https://game.gtimg.cn/images/lol/act/img/champion/${id}.png` : ''
function buildLol(detail, homeLabel, awayLabel) {
  if (!detail || !detail.lol || !Array.isArray(detail.lol.rounds) || !detail.lol.rounds.length) return null
  const side = (t, label) => ({
    label, side: t ? (t.side === 'blue' ? '蓝方' : '红方') : '',
    kills: value(t && t.kills), gold: value(t && t.gold), towers: value(t && t.towers),
    dragons: value(t && t.dragons), barons: value(t && t.barons),
    players: t ? (t.players || []).slice().sort((a, b) => ORDER.indexOf(a.role) - ORDER.indexOf(b.role)).map(p => ({
      id: p.id, name: p.name || '—', champion: p.champion || '—', role: ROLES[p.role] || p.role || '—',
      icon: championIcon(p.champion),
      kda: `${value(p.k)} / ${value(p.d)} / ${value(p.a)}`, cs: value(p.cs), gold: value(p.gold),
    })) : [],
  })
  const rounds = detail.lol.rounds.map(r => ({
    n: r.n, id: r.id, complete: !!r.complete,
    note: r.complete ? '终局数据' : r.state === 'paused' ? '数据停留在暂停时刻，尚未补齐' : '单局数据尚未补齐',
    teams: [side(r.h, homeLabel), side(r.a, awayLabel)],
  }))
  return { rounds, active: 0, complete: !!detail.lol.complete }
}
module.exports = { buildLol }
