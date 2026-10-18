/** 展示实时估算、正式周榜及参赛依据；资格结论必须有名单或对阵证据。 */
const { nameKey, nameZh, displayName } = require('./tennis-names')
const tennis = require('./tennis')
const roundLabels = { W: '冠军', F: '亚军', SF: '半决赛', QF: '八强', R16: '16强', R32: '32强', R64: '64强', R128: '128强' }
const playerFields = ['key','name','country','rank','points','officialRank','officialPoints','birthYear','photo','gains','drops','currentEvent','currentRound','eventPoints','nextPoints','espnId']
const profileFields = ['name','birthDate','age','height','weight','hand','proYear','photo','fetchedAt']
const changeFields = ['event','round','points','date']
// 积分源使用城市短名，ESPN 使用带冠名的赛事名；只映射已核验的单打分站。
const calendarAliases={wta:{Wuhan:'Dongfeng Voyah Wuhan Open',Ningbo:'Ningbo Open',Osaka:'Kinoshita Group Japan Open',
  Guangzhou:'Guangzhou Open',Tokyo:'Toray Pan Pacific Open Tennis','Hong Kong':'Prudential Hong Kong Tennis Open',Beijing:'China Open'}}
const objectOf = (fields,row) => Object.fromEntries(fields.map((field,index)=>[field,row[index]]))
function decode(payload) {
  if (!payload || payload.v !== 2) return payload
  return {...payload, v:1, players:payload.players.map(row=>{
    const player=objectOf(playerFields,row)
    for(const field of ['gains','drops'])player[field]=(player[field]||[]).map(change=>objectOf(changeFields,change))
    return player
  }), profiles:Object.fromEntries(Object.entries(payload.profiles||{}).map(([key,row])=>[key,objectOf(profileFields,row)])),
  race:(payload.race||[]).map(row=>objectOf(['key','name','rank','points','country'],row))}
}
function encode(payload) {
  return {...payload,v:2,players:payload.players.map(player=>playerFields.map(field=>
    field==='gains'||field==='drops'?(player[field]||[]).map(row=>changeFields.map(key=>row[key])):player[field]??null)),
  profiles:Object.fromEntries(Object.entries(payload.profiles||{}).map(([key,row])=>[key,profileFields.map(field=>row[field]??null)])),
  race:(payload.race||[]).map(row=>[row.key,row.name,row.rank,row.points,row.country])}
}
function findPlayer(payload, value) {
  if (!payload) return null
  const key = nameKey(value)
  const player = (payload.players || []).find(row => row.key === key || row.espnId === value)
  if (player) return player
  const row = (payload.pool || []).find(row => nameKey(row[0]) === key)
  return row ? { key, name: row[0], country: row[1], rank: row[2], points: row[3], officialRank: row[4], officialPoints: row[5], birthYear: row[6] } : null
}
function board(payload, chinaOnly, now = Date.now()) {
  if (!payload || !Array.isArray(payload.players)) return null
  const all = payload.players.concat((payload.pool || []).map(row => ({ name: row[0], country: row[1], rank: row[2], points: row[3], officialRank: row[4], officialPoints: row[5] })))
  const rows = all.filter(row => chinaOnly ? row.country === 'CHN' : row.rank <= 100).sort((a,b) => a.rank-b.rank)
    .slice(0, chinaOnly ? 10 : 100).map(row => ({ id: row.key || nameKey(row.name), name: displayName(row.name),
      en: row.name, country: row.country, pos: row.rank, value: row.points,
      delta: Number.isFinite(row.officialPoints) ? row.points - row.officialPoints : null,
      movement: Number.isFinite(row.officialRank) ? row.officialRank - row.rank : null }))
  return { rows, mode: 'live', label: '实时估算', rankingDate: payload.rankingDate, fetchedAt: payload.checkedAt,
    asOf: payload.asOf, source: payload.source, stale: !Date.parse(payload.asOf) || now - Date.parse(payload.asOf) > 2 * 3600000 }
}
function finalsStatus(payload, player, now = Date.now()) {
  const race = (payload && payload.race || []).slice().sort((a,b) => a.rank-b.rank)
  const current = race.find(row => row.key === nameKey(player.name)), line = race.find(row => row.rank === 7)
  const official = payload && payload.finals
  const named = official && now - Date.parse(official.checkedAt) <= 2 * 86400000 && official.names.includes(nameKey(player.name))
  let title = '暂无年度积分数据', tone = 'pending'
  if (named) { title = official.kind === 'official-qualified' ? '官方已确认入围' : '官方总决赛参赛页已列名'; tone = 'confirmed' }
  else if (current && current.rank <= 7) { title = '暂居直接资格区'; tone = 'contending' }
  else if (current && current.rank <= 20) title = '资格争夺中 · 第8席需核对冠军优先规则'
  else if (current) title = '暂在资格区外'
  return { title, tone, rank: current && current.rank, points: current && current.points,
    gap: current && line && current.rank > 7 ? Math.max(0, line.points - current.points) : null,
    linePoints: line && line.points, date: payload && payload.raceDate,
    source: named ? official.source : '',
    note: '年度冠军积分前7为直接资格区；第8席涉及当年大满贯冠军（第8–20位）的优先规则。实时位置不等于锁定资格。' }
}
function participation(payload, player, matches, now = Date.now()) {
  const today = new Date(now + 8 * 3600000).toISOString().slice(0,10)
  const pool = new Map()
  ;(payload && payload.calendar || []).filter(event => event.end >= today && Date.parse(event.start) < now + 45 * 86400000)
    .forEach(event => {
      const key=calendarAliases[payload.tour]&&calendarAliases[payload.tour][event.name]||event.name
      pool.set(key, { ...event, station: tennis.tournamentOf({ comp: payload.tour, stage: key }).name })
    })
  ;(matches || []).forEach(match => {
    const station = tennis.tournamentOf(match)
    const old = pool.get(station.raw)
    if (!old && !['upcoming','live'].includes(match.status)) return
    const priority={live:3,upcoming:2,finished:1}
    if (old && old.matchId && priority[old.status] > priority[match.status]) return
    pool.set(station.raw, { ...(old || {}), name: old && old.name || station.raw, station: station.name,
      start: old && old.start || match.date, end: old && old.end || match.date, matchId: match.id, status: match.status })
  })
  return [...pool.values()].sort((a,b) => a.start.localeCompare(b.start)).map(event => {
    const list = (payload && payload.entryLists || []).find(item => item.name === event.name && item.start === event.start
      && now - Date.parse(item.checkedAt) <= 2 * 86400000)
    const entry = list && list.entries.find(entry => entry.key === nameKey(player.name))
    const phase=event.start>today?'upcoming':event.end>=today?'live':'finished'
    const phaseLabel=phase==='upcoming'?'赛事未开始':phase==='live'?'赛事进行中':'赛事已结束'
    let title = phase==='upcoming'?'待报名名单确认':'本站参赛状态待核实', tone = 'pending', reason = phase==='upcoming'
      ?'仅凭当前实时积分，不能确认已截止报名的参赛资格。':'赛事已开赛，尚未取得该选手的有效参赛记录；不代表比赛尚未开始。'
    if (entry && /withdraw/i.test(entry.status)) { title = entry.source?'官方已确认退赛':'官方名单标注退赛'; reason = entry.reason||'以赛事最新名单为准。'; tone = 'withdrawn' }
    else if (event.matchId) {
      title = event.status === 'live' ? '本站正在参赛' : event.status === 'finished' ? '已参加本站比赛' : '已公布本站正赛对阵'
      reason = '已有本站单打对阵或赛果记录；后续轮次以晋级与抽签结果为准。'; tone = 'confirmed'
    }
    else if (entry && /playing|eliminated/.test(entry.status)) {
      title = entry.role === 'qualifying' ? '官方资格赛名单列名' : '官方正赛参赛名单列名'
      reason = '报名名单可能随退赛、替补和抽签调整。'; tone = 'confirmed'
    } else if (list && list.complete!==false) { title = '未见于当前公布名单'; reason = phase==='upcoming'?'尚不能据此排除资格赛、外卡或候补机会。':'赛事已开赛，当前名单未见该选手；尚未取得明确的退赛或参赛记录。' }
    return { ...event, phase,phaseLabel,title, tone, reason, source: entry && entry.source || list && list.source || '', checkedAt: list && list.checkedAt || '' }
  })
}
function pointsDetails(player) {
  return { gains: (player.gains || []).filter(row=>row.points>0).map(row => ({ ...row, roundLabel: roundLabels[row.round] || row.round })),
    drops: (player.drops || []).filter(row=>row.points>0).map(row => ({ ...row, roundLabel: roundLabels[row.round] || row.round })),
    delta: Number.isFinite(player.points) && Number.isFinite(player.officialPoints) ? player.points - player.officialPoints : null }
}
function profileUrl(tour, player) {
  return `/pages/tennis-player/tennis-player?comp=${encodeURIComponent(tour)}&name=${encodeURIComponent(player.name || player.en || '')}&id=${encodeURIComponent(player.espnId || player.id || player.key || '')}`
}
module.exports = { encode, decode, findPlayer, board, finalsStatus, participation, pointsDetails, profileUrl }
