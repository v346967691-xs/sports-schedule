/** 公共网球巡回赛选手缓存：实时积分、年度积分、官方名单与球员资料。
 * 复用 team_roster 的巡回赛名单行，不写用户数据，不增加代码包数据文件。
 */
const { nameKey } = require('../utils/tennis-names')
const { decodeSnapshot } = require('../utils/snapshot')
const archive = require('../utils/tennis-event')
const {encode,decode} = require('../utils/tennis-insights')
const DAY = 86400000
const IDS = ['atp:tennis-live', 'wta:tennis-live']
const WTA_EVENTS = { ningbo: [2092, 'ningbo'], guangzhou: [1023, 'guangzhou'], osaka: [405, 'osaka'],
  tokyo: [1056, 'tokyo'], 'hong kong': [1074, 'hong-kong'], wuhan: [1075, 'wuhan'], beijing: [1020, 'beijing'] }
const finalUrls = { atp: 'https://www.nittoatpfinals.com/en/players/singles', wta: 'https://www.wtatennis.com/rankings/race-singles' }
const lastAttempt = {}
async function readUrl(url, json = true) {
  const res = await fetch(url, { signal: AbortSignal.timeout(12000), headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return json ? res.json() : res.text()
}
const validRow = row => row && typeof row.n === 'string' && row.n.trim() && Number.isInteger(row.r) && row.r > 0
  && typeof row.p === 'number' && Number.isFinite(row.p) && row.p >= 0
const changes = value => (Array.isArray(value) ? value : []).filter(row => Array.isArray(row) && typeof row[0] === 'string' && Number.isFinite(row[2]))
  .map(row => ({ event: row[0], round: row[1] || '', points: row[2], date: row[3] || '' }))
function normalize(raw, tour, known = new Map(), now = Date.now()) {
  const asOf = raw && (raw.asof_calc || raw.asof), at = Date.parse(asOf)
  if (!Number.isFinite(at) || at > now + 300000 || now - at > 2 * DAY) throw new Error('实时积分时间无效或过旧')
  const all = (raw.s || []).filter(validRow)
  const top = all.filter(row => row.r <= 100)
  if (top.length !== 100 || new Set(top.map(row => row.r)).size !== 100) throw new Error('实时前百不完整')
  const china = new Set(all.filter(row => row.c === 'CHN').sort((a,b) => a.r-b.r).slice(0,10).map(row => nameKey(row.n)))
  const players = all.filter(row => row.r <= 100 || china.has(nameKey(row.n)) || known.has(nameKey(row.n)))
    .map(row => ({ key: nameKey(row.n), name: row.n, country: row.c || '', rank: row.r, points: row.p,
      officialRank: Number.isInteger(row.or) && row.or > 0 ? row.or : null,
      officialPoints: typeof row.op === 'number' && Number.isFinite(row.op) ? row.op : null,
      birthYear: row.by || null, photo: row.ph ? new URL(row.ph, 'https://www.rank.tennis').href : '',
      gains: changes(row.got), drops: changes(row.gone), currentEvent: row.alive || '', currentRound: row.ar || '',
      eventPoints: Number.isFinite(row.ap) ? row.ap : null, nextPoints: Number.isFinite(row.np) ? row.np : null,
      espnId: known.get(nameKey(row.n)) || '' }))
  const raceRows = (raw.r || []).filter(validRow)
  if (raceRows.filter(row => row.r <= 7).length !== 7 || new Set(raceRows.filter(row=>row.r<=7).map(row=>row.r)).size !== 7) throw new Error('年度积分资格区不完整')
  const raceChina = new Set(raceRows.filter(row => row.c === 'CHN').sort((a,b) => a.r-b.r).slice(0,10).map(row => nameKey(row.n)))
  const race = raceRows.filter(row => row.r <= 100 || raceChina.has(nameKey(row.n)))
    .map(row => ({ key: nameKey(row.n), name: row.n, rank: row.r, points: row.p, country: row.c || '' }))
  const calendar = (raw.week || []).filter(row => row.tour === tour && /(?:ATP|WTA)\s*(?:250|500|1000)|Grand Slam|Finals/i.test(row.lvl || row.name || ''))
    .map(row => ({ name: row.name, city: row.city || '', level: row.lvl || '', start: row.d0, end: row.d1 }))
  return { v: 1, tour, asOf, checkedAt: new Date(now).toISOString(), rankingDate: raw.snap_by && raw.snap_by[tour] || raw.snap || '',
    raceDate: raw.race_snap && raw.race_snap[`${tour}_race`] || '', source: 'rank.tennis 实时估算', players, race, calendar }
}
function parseWtaEntries(html) {
  const entries = []
  for (const role of ['Singles', 'Qualifying']) {
    const at = html.indexOf(`data-ui-tab="${role}"`)
    if (at < 0) continue
    const end = html.indexOf('data-ui-tab=', at + 15)
    const section = html.slice(at, end < 0 ? undefined : end)
    for (const match of section.matchAll(/<article\b([^>]*tournament-player-card[^>]*)>/g)) {
      const name = (match[1].match(/data-player-name="([^"]+)"/) || [])[1]
      const filter = (match[1].match(/data-filter="([^"]+)"/) || [])[1]
      if (name && filter) entries.push({ key: nameKey(name), role: role === 'Singles' ? 'main' : 'qualifying', status: filter })
    }
  }
  return [...new Map(entries.map(row => [`${row.key}|${row.role}`, row])).values()]
}
function parseFinalists(html, tour, year) {
  if (tour === 'wta') {
    const date = (html.match(/data-rankings?-date="([^"]+)"/) || [])[1]
    if (!date || !date.startsWith(String(year))) throw new Error('WTA 官方年度榜届次未确认')
    const names = []
    for (const row of html.matchAll(/<tr\b([^>]*data-player-name="([^"]+)"[^>]*)>([\s\S]*?)<\/tr>/g)) {
      if (/qualified-label--large[^>]*>\s*Qualified\s*</.test(row[3])) names.push(nameKey(row[2]))
    }
    return { names, kind: 'official-qualified', date }
  }
  if (!new RegExp(`Inalpi Arena[^<]{0,120}${year}`).test(html)) throw new Error('ATP 总决赛参赛页届次未确认')
  const names = [...html.matchAll(/class="first-name">([^<]+)<\/div>\s*<div class="last-name">([^<]+)<\/div>/g)]
    .map(row => nameKey(`${row[1]} ${row[2]}`))
  return { names, kind: 'official-list', date: '' }
}
function profileOf(raw, name, now) {
  const athlete = raw && raw.athlete
  if (!athlete || nameKey(athlete.displayName || athlete.fullName) !== nameKey(name)) return null
  return { name, birthDate: athlete.dateOfBirth || athlete.displayDOB || '', age: athlete.age || null,
    height: athlete.displayHeight || '', weight: athlete.displayWeight || '', hand: athlete.hand && athlete.hand.type || '',
    proYear: athlete.debutYear || null, photo: athlete.headshot && athlete.headshot.href || '', fetchedAt: new Date(now).toISOString() }
}
async function enrich(payload, previous, now) {
  payload.profiles = { ...(previous.profiles || {}) }
  payload.entryLists = previous.entryLists || []
  payload.finals = previous.finals || null
  if (!payload.finals || now - Date.parse(payload.finals.checkedAt) > 6 * 3600000) {
    try {
      payload.finals = { ...parseFinalists(await readUrl(finalUrls[payload.tour], false), payload.tour, new Date(now).getUTCFullYear()),
        source: finalUrls[payload.tour], checkedAt: new Date(now).toISOString() }
    } catch (err) { console.warn('[tennis-insights] 官方总决赛名单暂不可用', payload.tour, err.message) }
  }
  const todo = payload.players.filter(row => row.espnId && (!payload.profiles[row.key]
    || now - Date.parse(payload.profiles[row.key].fetchedAt) > 7 * DAY))
  let cursor = 0
  await Promise.all(Array.from({ length: Math.min(6, todo.length) }, async () => {
    while (cursor < todo.length) {
      const row = todo[cursor++]
      try {
        const raw = await readUrl(`https://site.web.api.espn.com/apis/common/v3/sports/tennis/${payload.tour}/athletes/${encodeURIComponent(row.espnId)}`)
        const profile = profileOf(raw, row.name, now)
        if (profile) payload.profiles[row.key] = profile
      } catch (err) { /* 资料失败不清掉旧档案，也不阻断积分更新 */ }
    }
  }))
}
function knownPlayers(tour) {
  let matches = decodeSnapshot(require('../data/matches'))
  try { matches = matches.concat(archive.archiveRows(require('../data/tennis-events'))) } catch (err) { /* 首次生成 */ }
  const known = new Map()
  matches.filter(match => match.comp === tour).forEach(match => [match.home,match.away].forEach(player => {
    if (player && /^\d+$/.test(String(player.id)) && player.name) known.set(nameKey(player.name), String(player.id))
  }))
  return known
}
function signature(payload) {
  const stable=value=>Array.isArray(value)?value.map(stable):value&&typeof value==='object'
    ?Object.fromEntries(Object.keys(value).filter(key=>value[key]!==undefined).sort().map(key=>[key,stable(value[key])])):value
  return JSON.stringify(stable({ ...payload, asOf: undefined, checkedAt: undefined, entryCheckedAt:undefined,withdrawalArticles:undefined,
    entryLists:payload.entryLists&&payload.entryLists.map(row=>({...row,checkedAt:undefined})),
    withdrawals:payload.withdrawals&&payload.withdrawals.map(row=>({...row,checkedAt:undefined})) }))
}
async function main(cloud, options = {}) {
  const now = options.now == null ? Date.now() : options.now
  if (!cloud) {
    const config = require('../utils/cloud-config')
    cloud = require('@tencent-ai/workbuddy-cloud-sdk').createWorkBuddyCloud(config)
  }
  const results = await Promise.all(['atp','wta'].map(async (tour,index) => {
    if (!options.force && now - (lastAttempt[tour] || 0) < 5 * 60000) return { tour, skipped: 'local-throttle' }
    lastAttempt[tour] = now
    const old = await cloud.database.from('team_roster').select('payload,generated_at').eq('id', IDS[index]).maybeSingle()
    if (old.error) throw new Error(`巡回赛缓存读取失败：${old.error.message}`)
    const previous = decode(old.data && old.data.payload) || {}
    const enrichmentDue=options.enrich!==false&&(!previous.enrichedAt||now-Date.parse(previous.enrichedAt)>6*3600000)
    const entryDue=tour==='wta'&&options.enrich!==false&&(options.force||!previous.entryCheckedAt||now-Date.parse(previous.entryCheckedAt)>=15*60000)
    if (!options.force && !enrichmentDue && !entryDue && now - Date.parse(previous.checkedAt || '') < 5 * 60000) return { tour, skipped: 'fresh' }
    try {
      const payload = normalize(await readUrl(`https://www.rank.tennis/data/${tour}.json`), tour, knownPlayers(tour), now)
      if (previous.asOf && payload.asOf < previous.asOf) throw new Error('拒绝较旧实时积分')
      payload.profiles = previous.profiles || {}; payload.entryLists = previous.entryLists || []; payload.finals = previous.finals || null
      if(previous.enrichedAt)payload.enrichedAt=previous.enrichedAt
      for(const field of ['entryCheckedAt','withdrawals','withdrawalArticles'])if(previous[field])payload[field]=previous[field]
      if (enrichmentDue) { await enrich(payload, previous, now);payload.enrichedAt=new Date(now).toISOString() }
      if (entryDue) await require('./tennis-participation').refresh(payload,previous,now,{readUrl,parseEntries:parseWtaEntries,eventIds:WTA_EVENTS})
      if (signature(previous) === signature(payload) && now - Date.parse(old.data.generated_at) < 60 * 60000) return { tour, skipped: 'unchanged' }
      const row = { id: IDS[index], comp: tour, team_id: 'tennis-live', payload:encode(payload),
        generated_at: new Date(now).toISOString(), updated_at: new Date(now).toISOString() }
      const pushed = await cloud.database.from('team_roster').upsert(row, { onConflict: 'id' })
      if (pushed.error) throw new Error(pushed.error.message || '巡回赛缓存写入失败')
      return { tour, players: payload.players.length, bytes:Buffer.byteLength(JSON.stringify(row.payload)), profiles: Object.keys(payload.profiles).length,
        entries: payload.entryLists.length, finalists: payload.finals && payload.finals.names.length, asOf: payload.asOf }
    } catch (error) { return { tour, error: error.message } }
  }))
  return results
}
if (require.main === module) main(null, { force: process.argv.includes('--force') }).then(result => {
  console.log(JSON.stringify(result)); if (result.some(row => row.error)) process.exitCode = 2
}).catch(err => { console.error(err.message); process.exitCode = 1 })
module.exports = { normalize, parseWtaEntries, parseFinalists, profileOf, signature, main }
