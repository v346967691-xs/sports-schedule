/** 分站与轮次是两个维度：同一轮次不能跨分站混合。未知站名保留上游原文。 */
const STATIONS = {
  'Rolex Shanghai Masters': '上海大师赛',
  'Rolex Paris Masters': '巴黎大师赛',
  'China Open': '中国网球公开赛',
  'Dongfeng Voyah Wuhan Open': '武汉网球公开赛',
  'Ningbo Open': '宁波公开赛',
  'BNB Ningbo Open': '宁波公开赛',
  'Guangzhou Open': '广州公开赛',
  'Prudential Hong Kong Tennis Open': '香港网球公开赛',
  'Kinoshita Group Japan Open Tennis Championships': '日本网球公开赛',
  'Kinoshita Group Japan Open': '日本网球公开赛',
  'Toray Pan Pacific Open Tennis': '泛太平洋公开赛',
  'BNP Paribas Fortis European Open': '欧洲公开赛',
  'Almaty Open': '阿拉木图公开赛',
  'Erste Bank Open': '维也纳公开赛',
  'Swiss Indoors Basel': '巴塞尔室内赛',
  'Chennai Open': '金奈公开赛',
  'Bybit Stockholm Open': '斯德哥尔摩公开赛',
}

function isTennis(match) { return !!match && (match.comp === 'atp' || match.comp === 'wta') }

function tournamentOf(match) {
  const raw = String(match && match.stage || '').split('·')[0].trim() || '分站待公布'
  return { key: `${match.comp}|${raw}`, raw, name: STATIONS[raw] || raw, comp: match.comp }
}

function tournamentLabel(match, getLevel) {
  const station = tournamentOf(match)
  const level = typeof getLevel === 'function' ? getLevel(station.comp, station.raw, match && match.date) : ''
  return [station.name, level].filter(Boolean).join(' · ')
}

function roundOf(match) {
  const parts = String(match && match.stage || '').split('·').map(s => s.trim())
  const raw = parts.slice(1).join(' · ')
  const rounds = { 'Final': '决赛', 'Semifinals': '半决赛', 'Quarterfinals': '四分之一决赛' }
  const size = raw.match(/^Round of (\d+)$/i)
  return size ? `${size[1]}强赛` : rounds[raw] || raw
}

function tournamentChipsOf(list, getLevel) {
  const stations = new Map()
  list.filter(isTennis).forEach(match => {
    const station = tournamentOf(match)
    const level = typeof getLevel === 'function' ? getLevel(station.comp, station.raw, match.date) : ''
    const existing = stations.get(station.key)
    if (existing) existing.count += 1
    else stations.set(station.key, { ...station, level, label: [station.name, level].filter(Boolean).join(' · '), count: 1 })
  })
  return [...stations.values()]
}

module.exports = { isTennis, tournamentOf, tournamentLabel, roundOf, tournamentChipsOf }
