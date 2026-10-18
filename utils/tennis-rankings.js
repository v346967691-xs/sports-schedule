const { displayName } = require('./tennis-names')
function board(weekly, tour, chinaOnly, now = Date.now()) {
  const data = weekly && weekly[tour]
  if (!data || !Array.isArray(data.rows)) return null
  const rows = data.rows.filter(r => chinaOnly ? r.country === 'CHN' : r.rank <= 100)
    .map(r => ({ id: r.id, name: displayName(r.name), en: r.name, country: r.country,
      pos: r.rank, value: r.points, movement: Number.isInteger(r.previousRank) && r.previousRank > 0 ? r.previousRank - r.rank : null })).sort((a, b) => a.pos - b.pos)
  return { rows, rankingDate: data.rankingDate, fetchedAt: data.fetchedAt, source: data.source,
    stale: !Number.isFinite(Date.parse(data.rankingDate)) || now - Date.parse(data.rankingDate) > 21 * 86400000 }
}
function merge(current = {}, incoming = {}) {
  const result = Object.assign({}, current)
  ;['atp', 'wta'].forEach(tour => {
    const next = incoming[tour]
    if (next && Array.isArray(next.rows) && next.rows.filter(r => r.rank >= 1 && r.rank <= 100).length === 100
      && Number.isFinite(Date.parse(next.rankingDate))
      && (!current[tour] || next.rankingDate >= current[tour].rankingDate)) {
      result[tour] = Object.assign({}, next, {
        tournaments: require('./tennis-levels').mergeCalendar(current[tour] && current[tour].tournaments,next.tournaments),
      })
    }
  })
  return result
}

function eventLevel(tournaments, tour, name, date) {
  const normalizeName = value => {
    let text = String(value || '').toLowerCase()
    if (typeof text.normalize === 'function') text = text.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    else text = text.replace(/[àáâãäå]/g, 'a').replace(/[èéêë]/g, 'e').replace(/[ìíîï]/g, 'i')
      .replace(/[òóôõö]/g, 'o').replace(/[ùúûü]/g, 'u').replace(/ç/g, 'c').replace(/ñ/g, 'n')
    return text.replace(/\b20\d{2}\b/g, '').replace(/[^a-z0-9]+/g, ' ').trim()
  }
  const candidate = normalizeName(name)
  const fallback=()=>require('./tennis-levels').level(tour,name,date)
  if (!candidate || !Array.isArray(tournaments)) return fallback()
  const day = String(date || '').slice(0, 10)
  const events = tournaments.filter(event => {
    if (!event || (event.tour && event.tour !== tour)) return false
    const names = [event.name, event.city].map(normalizeName).filter(value => value.length >= 4)
    const matched = names.some(value => candidate === value || candidate.includes(value) || value.includes(candidate))
    if (!matched) return false
    return !day || !event.start || !event.end || (day >= event.start && day <= event.end)
  })
  const levels=[...new Set(events.map(e=>e.level).filter(Boolean))]
  return events.length ? (levels.length===1?levels[0]:'') : fallback()
}
module.exports = { board, merge, eventLevel }
