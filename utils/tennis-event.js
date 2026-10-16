/** 整站赛程、球场和赛后 30 天归档；与普通赛程的时间窗口分开。 */
const tennis = require('./tennis')
const snapshot = require('./snapshot')
const DAY = 86400000
const COURTS = {
  'Capital Group Diamond': '钻石球场', Lotus: '莲花球场', 'HSBC Moon': '映月球场',
  'Brad Drewett': '布拉德·德鲁伊特球场', 'Dongfeng Voyah Center Court': '中心球场',
  'Stadium Court': '中央球场',
}

function courtOf(match) {
  const raw = String(match && match.venue || '').split(' · ').slice(1).join(' · ').trim()
  const numbered = raw.match(/^(?:Show )?Court\s+(\d+)$/i)
  return { key: raw || 'unassigned', name: COURTS[raw] || (numbered ? `${numbered[1]}号球场` : raw) || '球场待定' }
}

function compareCourts(a, b) {
  const featured = ['Capital Group Diamond', 'Stadium Court', 'Dongfeng Voyah Center Court', 'Lotus', 'HSBC Moon', 'Brad Drewett']
  const rank = court => {
    const known = featured.indexOf(court.key)
    const number = court.key.match(/^(?:Show )?Court\s+(\d+)$/i)
    return known >= 0 ? known : number ? 100 + Number(number[1]) : court.key === 'unassigned' ? 999 : 500
  }
  return rank(a) - rank(b) || a.name.localeCompare(b.name, 'zh')
}

function identity(match) {
  if (!tennis.isTennis(match)) return null
  const station = tennis.tournamentOf(match)
  const year = String(match.start || match.date || '').slice(0, 4)
  return {
    key: `${match.comp}|${match.eventId || `${station.raw}|${year}`}`,
    comp: match.comp, eventId: match.eventId || '', name: station.name, title: station.raw,
    start: match.eventStart || match.start, end: match.eventEnd || match.start,
  }
}

/** 快照中未带 eventId 的旧记录，先通过同场 ID 找到新归档中的分站身份。 */
function mergeRows(previous, incoming) {
  const byId = new Map()
  ;(previous || []).concat(incoming || []).filter(tennis.isTennis).forEach(match => {
    const old = byId.get(match.id)
    const next = Object.assign({}, old || {}, match)
    ;['eventId', 'eventStart', 'eventEnd', 'winnerId'].forEach(key => {
      if (!next[key] && old && old[key]) next[key] = old[key]
    })
    if ((!Array.isArray(next.broadcast) || !next.broadcast.length) && old && Array.isArray(old.broadcast)) next.broadcast = old.broadcast
    if (match.status !== 'finished') delete next.winnerId
    if (next.winnerId && ![next.home, next.away].some(side => side && String(side.id) === String(next.winnerId))) delete next.winnerId
    byId.set(match.id, next)
  })
  return [...byId.values()]
}

function eventsOf(rows) {
  const map = new Map()
  rows.filter(tennis.isTennis).forEach(match => {
    const event = identity(match)
    const old = map.get(event.key)
    if (!old) map.set(event.key, Object.assign({}, event, { count: 1 }))
    else {
      old.count++
      if (event.start < old.start) old.start = event.start
      if (event.end > old.end) old.end = event.end
    }
  })
  return [...map.values()].sort((a, b) => String(b.start).localeCompare(String(a.start)))
}

function archiveRows(payload) {
  let packed = payload && payload.snapshot
  if (payload && payload.version === 3) {
    const matches = {}
    Object.keys(payload.matches || {}).forEach(comp => {
      matches[comp] = payload.matches[comp].map(row => ({ e: row[0], s: row[1], t: row[2], h: row[3], a: row[4],
        g: payload.rounds[row[5]], ev: row[6], cv: row[7], q: row[8], wi: row[9], x: row[10], sd: row[11] }))
    })
    packed = { v: 2, teams: payload.teams, matches }
  }
  const rows = snapshot.decodeSnapshot(packed || [])
  if (!payload || (payload.version !== 2 && payload.version !== 3)) return rows
  const records = new Map()
  Object.keys(packed.matches || {}).forEach(comp => {
    packed.matches[comp].forEach(record => records.set(record.i || `${comp}-${record.e}`, record))
  })
  return rows.map(match => {
    const record = records.get(match.id)
    const event = record && payload.events[record.ev]
    if (!event) return match
    return Object.assign({}, match, { eventId: event.eventId, eventStart: event.start, eventEnd: event.end,
      stage: [event.title, match.stage].filter(Boolean).join(' · '), venue: payload.venues[record.cv] || '',
      statusText: match.statusText || (match.status === 'finished' ? '已结束' : ''),
      broadcast: match.broadcast.length ? match.broadcast : event.broadcast || [] })
  })
}

function buildArchive(incoming, previous, now = Date.now()) {
  const rows = mergeRows(archiveRows(previous), incoming)
  const events = eventsOf(rows).filter(event => {
    const end = Date.parse(event.end), start = Date.parse(event.start)
    return Number.isFinite(end) && end + 30 * DAY >= now && start <= now + 90 * DAY
  })
  const allowed = new Set(events.map(event => event.key))
  const kept = rows.filter(match => allowed.has(identity(match).key))
  // 场地、站名和整站日期只存一次，避免 96 签赛事把这些长字符串重复近百遍。
  const venues = [...new Set(kept.map(match => match.venue || ''))]
  const byId = new Map(kept.map(match => [match.id, match]))
  events.forEach(event => { event.broadcast = (kept.find(match => identity(match).key === event.key) || {}).broadcast || [] })
  const eventIndex = new Map(events.map((event, index) => [event.key, index]))
  const packed = snapshot.encodeSnapshot(kept.map(match => Object.assign({}, match, {
    stage: String(match.stage || '').split('·').slice(1).map(s => s.trim()).join(' · '),
    venue: '', eventId: '', eventStart: '', eventEnd: '', broadcast: [],
  })))
  Object.keys(packed.matches).forEach(comp => packed.matches[comp].forEach(record => {
    const match = byId.get(record.i || `${comp}-${record.e}`)
    record.ev = eventIndex.get(identity(match).key)
    record.cv = venues.indexOf(match.venue || '')
  }))
  const rounds = [...new Set(kept.map(match => String(match.stage || '').split('·').slice(1).map(s => s.trim()).join(' · ')))]
  const matches = {}
  Object.keys(packed.matches).forEach(comp => {
    matches[comp] = packed.matches[comp].map(record => {
      const sets = record.q && ((record.q.h || []).length || (record.q.a || []).length) ? record.q : null
      const row = [record.e, record.s, record.t, record.h, record.a, rounds.indexOf(record.g || ''), record.ev, record.cv,
        sets, record.wi || null, record.x && record.x !== '已结束' ? record.x : null, record.sd || null]
      while (row.length > 8 && row[row.length - 1] == null) row.pop()
      return row
    })
  })
  return { version: 3, generatedAt: new Date(now).toISOString(), events, venues, rounds, teams: packed.teams, matches }
}

module.exports = { courtOf, compareCourts, identity, mergeRows, eventsOf, archiveRows, buildArchive }
