const { nameZh } = require('./tennis-names')
function board(weekly, tour, chinaOnly, now = Date.now()) {
  const data = weekly && weekly[tour]
  if (!data || !Array.isArray(data.rows)) return null
  const rows = data.rows.filter(r => chinaOnly ? r.country === 'CHN' : r.rank <= 100)
    .map(r => ({ id: r.id, name: nameZh(r.name) || r.name, en: r.name, country: r.country,
      pos: r.rank, value: r.points })).sort((a, b) => a.pos - b.pos)
  return { rows, rankingDate: data.rankingDate, fetchedAt: data.fetchedAt, source: data.source,
    stale: !Number.isFinite(Date.parse(data.rankingDate)) || now - Date.parse(data.rankingDate) > 21 * 86400000 }
}
function merge(current = {}, incoming = {}) {
  const result = Object.assign({}, current)
  ;['atp', 'wta'].forEach(tour => {
    const next = incoming[tour]
    if (next && Array.isArray(next.rows) && next.rows.filter(r => r.rank >= 1 && r.rank <= 100).length === 100
      && Number.isFinite(Date.parse(next.rankingDate))
      && (!current[tour] || next.rankingDate >= current[tour].rankingDate)) result[tour] = next
  })
  return result
}
module.exports = { board, merge }
