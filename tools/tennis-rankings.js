/** Read only the published weekly rank/points from the public rank.tennis mirror.
 * The feed also contains live estimates (r/p); those fields must never enter this board.
 */
function normalize(raw, tour, now = Date.now()) {
  const rankingDate = raw && (raw.snap_by && raw.snap_by[tour] || raw.snap)
  const date = Date.parse(rankingDate)
  if (!/^\d{4}-\d{2}-\d{2}$/.test(rankingDate || '') || !Number.isFinite(date) || date > now + 86400000) throw new Error('周排名日期无效')
  if (!Array.isArray(raw.s)) throw new Error('周排名数据缺失')
  const rows = raw.s.filter(r => typeof r.n === 'string' && r.n.trim()
    && Number.isInteger(r.or) && r.or > 0 && typeof r.op === 'number' && Number.isFinite(r.op) && r.op >= 0)
    .map(r => ({ id: 'rank-' + tour + '-' + r.n.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
      name: r.n, country: r.c || '', rank: r.or, points: r.op, previousRank: Number.isInteger(r.pr) && r.pr > 0 ? r.pr : null })).sort((a, b) => a.rank - b.rank)
  const top = rows.filter(r => r.rank <= 100)
  if (top.length !== 100 || new Set(top.map(r => r.rank)).size !== 100) throw new Error('正式周排名前百不完整')
  const china = rows.filter(r => r.country === 'CHN').slice(0, 10)
  const selected = new Map([...top, ...china].map(r => [r.id, r]))
  // The same feed publishes the tour calendar and each event's official level.
  // Keep only the compact fields needed to label tennis tournament filters/cards.
  const tournaments = Array.isArray(raw.week) ? raw.week
    .filter(event => event && event.tour === tour && typeof event.name === 'string'
      && typeof event.lvl === 'string' && event.lvl.trim())
    .map(event => ({ tour, name: event.name, city: event.city || '', level: event.lvl,
      start: event.d0 || '', end: event.d1 || '' })) : []
  return { rankingDate, fetchedAt: new Date(now).toISOString(), source: 'rank.tennis 周榜镜像',
    rows: [...selected.values()].sort((a, b) => a.rank - b.rank), tournaments }
}

async function refresh(previous = {}, options = {}) {
  const request = options.fetch || fetch
  const now = options.now == null ? Date.now() : options.now
  const result = Object.assign({}, previous)
  await Promise.all(['atp', 'wta'].map(async tour => {
    try {
      const response = await request('https://www.rank.tennis/data/' + tour + '.json', { signal: AbortSignal.timeout(12000) })
      if (!response.ok) throw new Error('HTTP ' + response.status)
      const next = normalize(await response.json(), tour, now)
      if (previous[tour] && next.rankingDate < previous[tour].rankingDate) throw new Error('来源返回较旧周榜')
      next.tournaments=require('../utils/tennis-levels').mergeCalendar(previous[tour] && previous[tour].tournaments,next.tournaments)
      result[tour] = next
    } catch (error) {
      // Never advance the date or sync time of the retained successful board.
      if (options.onError) options.onError(tour, error)
      else console.warn('[tennis-weekly-rankings]', tour, error.message)
    }
  }))
  return result
}
module.exports = { normalize, refresh }
