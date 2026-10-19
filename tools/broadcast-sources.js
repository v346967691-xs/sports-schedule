/**
 * 从国内平台官方赛程取逐场直播信息。
 * 对阵节目按双方与时间匹配；网球整日球场直播按分站、日期和球场匹配。
 */

const IQIYI_CHANNELS = 'https://sports.iqiyi.com/resource/json/matchList/pcChannelListNew.json'
const IQIYI_OTHER = 'https://sports.iqiyi.com/resource/json/matchList/pcMatchList_other.json'
const TENCENT_HOME = 'https://sports.qq.com/'
const MIGU_SCHEDULE = 'https://vms-sc.miguvideo.com/vms-match/v6/staticcache/basic/match-list/normal-match-list/0/all/default/1/miguvideo'

const IQIYI = '爱奇艺'
const TENCENT = '腾讯'
const MIGU = '咪咕'
const TENNIS_RIGHTS_SEASON = 2026

// 网球版权通常按整站赛事签约，不提供逐场节目单。以下范围依据巡回赛/平台公开版权公告：
// WTA 2026 中国大陆以外赛事：咪咕、腾讯；优酷协议延续至 2026。
// ATP 2024-2026 中国区协议覆盖巡回赛国际赛事；中国境内赛事按赛事公告单独标注。
// https://www.wtatennis.com/news/4432513/wta-renews-china-rights-deals-for-2026-as-fan-engagement-soars
// https://www.wtatennis.com/news/3925895/wta-and-atp-tours-make-their-debut-on-youku-platform-in-china
function tennisBroadcast(match) {
  if (!match || !['atp', 'wta'].includes(match.comp)) return []
  const year = new Date(match.start).getUTCFullYear()
  if (year !== TENNIS_RIGHTS_SEASON) return []

  const title = String(match.stage || '').split(' · ')[0].normalize('NFKC').toLowerCase()
  const venue = String(match.venue || '').normalize('NFKC').toLowerCase()
  const inGreaterChina = /\bchina\b|中国|hong\s*kong|香港|macau|澳门|taiwan|taipei|台湾|台北/.test(venue)

  // 中国境内有单独的赛事级版权安排，优先于巡回赛的海外常规协议。
  if (/china open|中国网球公开赛/.test(title) && inGreaterChina) return [MIGU]
  if (match.comp === 'wta' && /wuhan open|武汉网球公开赛/.test(title) && inGreaterChina) return [IQIYI]
  if (match.comp === 'atp' && /shanghai masters|上海劳力士大师赛/.test(title)) return ['优酷']

  // 中国境内其余赛事不按海外巡回赛协议推断平台。
  if (inGreaterChina) return []
  if (match.comp === 'wta') return [MIGU, TENCENT, '优酷']
  return ['优酷']
}

async function getText(url, timeoutMs = 12000) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; SportsSchedule/1.0)' },
      signal: controller.signal,
    })
    if (!res.ok) throw new Error(`HTTP ${res.status}`)
    return await res.text()
  } finally {
    clearTimeout(timer)
  }
}

async function getJSON(url) {
  return JSON.parse(await getText(url))
}

function dateToIso(value) {
  const raw = String(value || '').trim()
  if (!raw) return ''
  // 两个平台的赛程给北京时间墙钟字符串，不带时区。
  const local = raw.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2}))?$/)
  if (local) return `${local[1]}-${String(local[2]).padStart(2, '0')}-${String(local[3]).padStart(2, '0')}T${String(local[4]).padStart(2, '0')}:${local[5]}:${local[6] || '00'}+08:00`
  const parsed = new Date(raw)
  return Number.isNaN(parsed.getTime()) ? '' : parsed.toISOString()
}

function normalizeIQiyiMatch(item) {
  if (!item || !(item.guid3 || item.guid2 || item.isCanLive === '1' || item.isCanLive === 1)) return null
  const start = dateToIso(item.matchStartTimeV2 || item.playTime || item.matchStartTime)
  if (!start || !item.homeTeamName || !item.guestTeamName) return null
  return { source: IQIYI, start, home: item.homeTeamName, away: item.guestTeamName }
}

function readIQiyiList(payload) {
  const days = payload && payload.retData && payload.retData.list
  if (!Array.isArray(days)) return []
  const result = []
  for (const day of days) {
    for (const match of (day && day.match_list) || []) {
      const normalized = normalizeIQiyiMatch(match)
      if (normalized) result.push(normalized)
    }
  }
  return result
}

async function fetchIQiyi() {
  const channels = await getJSON(IQIYI_CHANNELS)
  const list = channels && channels.retData && channels.retData.list
  if (!Array.isArray(list)) throw new Error('爱奇艺频道列表格式异常')
  const urls = new Set([IQIYI_OTHER])
  list.forEach((channel) => {
    if (channel && typeof channel.url === 'string' && /pcMatchList_\d+\.json$/.test(channel.url)) urls.add(channel.url)
  })
  const rows = await Promise.all([...urls].map(async (url) => {
    try { return readIQiyiList(await getJSON(url)) } catch (err) {
      console.warn(`  ! 爱奇艺赛程抓取失败: ${err.message}`)
      return []
    }
  }))
  return rows.flat()
}

function extractObject(text, start) {
  const open = text.indexOf('{', start)
  if (open < 0) return null
  let depth = 0
  let quoted = false
  let escaped = false
  for (let i = open; i < text.length; i += 1) {
    const ch = text[i]
    if (quoted) {
      if (escaped) escaped = false
      else if (ch === '\\') escaped = true
      else if (ch === '"') quoted = false
      continue
    }
    if (ch === '"') quoted = true
    else if (ch === '{') depth += 1
    else if (ch === '}' && --depth === 0) {
      try { return JSON.parse(text.slice(open, i + 1)) } catch { return null }
    }
  }
  return null
}

function readTencentMatches(html) {
  const marker = '"type1500"'
  const at = html.indexOf(marker)
  if (at < 0) return []
  const block = extractObject(html, at + marker.length)
  const entries = block && Array.isArray(block.list) ? block.list : []
  return entries.map((entry) => {
    const match = entry && entry.matchInfo
    if (!match || !match.leftName) return null
    const start = dateToIso(match.startTime)
    if (start && !match.rightName) {
      const title = [match.matchDesc, match.leftName, match.title].filter(Boolean).join(' ')
      const comp = /\bwta\s*\d*/i.test(title) ? 'wta' : /\batp\s*\d*/i.test(title) ? 'atp' : ''
      const event = tennisProgrammeEvent(title)
      const court = tennisProgrammeCourt(title)
      return comp && event && court ? { source: TENCENT, start, comp, event, court } : null
    }
    if (!match.rightName) return null
    return start ? { source: TENCENT, start, home: match.leftName, away: match.rightName } : null
  }).filter(Boolean)
}

function tennisProgrammeEvent(title) {
  if (/ningbo|宁波/i.test(title)) return 'ningbo'
  if (/wuhan|武汉/i.test(title)) return 'wuhan'
  if (/china open|中国网球公开赛|中网/i.test(title)) return 'china-open'
  if (/shanghai masters|上海大师赛|上海劳力士/i.test(title)) return 'shanghai'
  return ''
}
function tennisProgrammeCourt(title) {
  if (/center court|centre court|stadium court|中心球场|中央球场/i.test(title)) return 'center'
  if (/grandstand|大看台/i.test(title)) return 'grandstand'
  // 中文节目中的 WTA500、日期不是球场编号。
  const explicit = String(title).match(/court\s*(\d+)|第?(\d+)号球场/i)
  return explicit ? `court-${explicit[1] || explicit[2]}` : ''
}
function programmeMatches(row, match) {
  if (row.comp !== match.comp || row.event !== tennisProgrammeEvent(match.stage || '')) return false
  const day = value => new Date(Date.parse(value) + 8 * 3600000).toISOString().slice(0, 10)
  if (!Number.isFinite(Date.parse(match.start)) || day(row.start) !== day(match.start)) return false
  const court = String(match.venue || '').split(' · ').slice(1).join(' · ')
  return !!court && row.court === tennisProgrammeCourt(court)
}

async function fetchTencent() {
  return readTencentMatches(await getText(TENCENT_HOME))
}

function readMiguMatches(payload) {
  const groups = payload && payload.body && payload.body.matchList
  if (!groups || typeof groups !== 'object') return []
  const result = []
  Object.values(groups).forEach((day) => {
    if (!Array.isArray(day)) return
    day.forEach((match) => {
      const teams = Array.isArray(match && match.confrontTeams) ? match.confrontTeams : []
      const home = teams.find((team) => String(team.isHome) === '1') || teams[0]
      const away = teams.find((team) => String(team.isHome) === '0') || teams[1]
      const time = Number(match && (match.matchStartTime || match.startTime))
      if (payload.code === 200 && home && away && home.name && away.name && Number.isFinite(time)) {
        result.push({ source: MIGU, start: new Date(time).toISOString(), home: home.name, away: away.name })
      }
    })
  })
  return result
}

async function fetchMigu() {
  return readMiguMatches(await getJSON(MIGU_SCHEDULE))
}

async function fetchAll() {
  const results = await Promise.all([
    fetchIQiyi().catch((err) => { console.warn(`  ! 爱奇艺官方赛程不可用: ${err.message}`); return [] }),
    fetchTencent().catch((err) => { console.warn(`  ! 腾讯体育官方赛程不可用: ${err.message}`); return [] }),
    fetchMigu().catch((err) => { console.warn(`  ! 咪咕官方赛程不可用: ${err.message}`); return [] }),
  ])
  return results.flat()
}

function normalizeTeam(value) {
  let name = String(value || '').normalize('NFKC').toLowerCase()
  name = name.replace(/\b(fc|cf|afc|sc|club|team|esports|e-sports)\b/g, '')
    .replace(/[\s\u00a0·・.\-_()（）'’]/g, '')
  const aliases = {
    皇马: '皇家马德里', 皇馬: '皇家马德里', real: '皇家马德里', realmadrid: '皇家马德里',
    巴萨: '巴塞罗那', 巴薩: '巴塞罗那', barca: '巴塞罗那', barcelona: '巴塞罗那',
    国米: '国际米兰', 國米: '国际米兰', inter: '国际米兰', intermilano: '国际米兰',
    曼联: '曼彻斯特联', 曼聯: '曼彻斯特联', manunited: '曼彻斯特联',
    曼城: '曼彻斯特城', mancity: '曼彻斯特城',
    开拓者: '波特兰开拓者', 尼克斯: '纽约尼克斯', 森林狼: '明尼苏达森林狼',
    奇才: '华盛顿奇才', 篮网: '布鲁克林篮网', 骑士: '克利夫兰骑士', 魔术: '奥兰多魔术',
    黄蜂: '夏洛特黄蜂', 雄鹿: '密尔沃基雄鹿', 掘金: '丹佛掘金', 公牛: '芝加哥公牛',
    老鹰: '亚特兰大老鹰', 雷霆: '俄克拉荷马雷霆', 爵士: '犹他爵士', 马刺: '圣安东尼奥马刺',
    国王: '萨克拉门托国王', 热火: '迈阿密热火', 太阳: '菲尼克斯太阳', 鹈鹕: '新奥尔良鹈鹕',
    凯尔特人: '波士顿凯尔特人', 快船: '洛杉矶快船', 勇士: '金州勇士', 湖人: '洛杉矶湖人',
    火箭: '休斯顿火箭', 步行者: '印第安纳步行者', 灰熊: '孟菲斯灰熊', 活塞: '底特律活塞',
    独行侠: '达拉斯独行侠', 猛龙: '多伦多猛龙', '76人': '费城76人',
  }
  return aliases[name] || name
}

function normalizeProvider(value) {
  const raw = String(value || '').trim().toLowerCase().replace(/[\s._-]/g, '')
  if (/youku|优酷/.test(raw)) return '优酷'
  if (/migu|咪咕/.test(raw)) return MIGU
  if (/iqiyi|爱奇艺/.test(raw)) return IQIYI
  if (/tencent|qq体育|腾讯/.test(raw)) return TENCENT
  if (/cctv5plus|cctv5\+|央视5\+|央视体育赛事/.test(raw)) return '央视5+'
  if (/cctv5|央视5|央视体育/.test(raw)) return '央视5'
  return ''
}

function mergeBroadcasts(matches, sourceRows, previous = []) {
  const allowed = new Set(['优酷', '咪咕', IQIYI, TENCENT, '央视5', '央视5+'])
  const feeds = new Map()
  const programmes = []
  sourceRows.forEach((row) => {
    if (!row || !allowed.has(row.source)) return
    const time = Date.parse(row.start)
    if (!Number.isFinite(time)) return
    if (row.event && row.comp && row.court) { programmes.push(row); return }
    const key = `${normalizeTeam(row.home)}|${normalizeTeam(row.away)}`
    if (!feeds.has(key)) feeds.set(key, [])
    feeds.get(key).push({ time, source: row.source })
  })
  const oldById = new Map(previous.map((match) => [match.id, match]))
  return matches.map((match) => {
    const existing = (match.broadcast || []).map(normalizeProvider).filter((value) => allowed.has(value))
    const old = oldById.get(match.id)
    const retained = old && Array.isArray(old.broadcast) ? old.broadcast.map(normalizeProvider).filter((value) => allowed.has(value)) : []
    const home = normalizeTeam(match.home && (match.home.zh || match.home.name))
    const away = normalizeTeam(match.away && (match.away.zh || match.away.name))
    const start = Date.parse(match.start)
    const found = [...(feeds.get(`${home}|${away}`) || []), ...(feeds.get(`${away}|${home}`) || [])]
      .filter((row) => Math.abs(row.time - start) <= 15 * 60 * 1000)
      .map((row) => row.source)
    const eventRights = tennisBroadcast(match)
    const courtStreams = programmes.filter(row => programmeMatches(row, match)).map(row => row.source)
    const previousLabels = ['atp', 'wta'].includes(match.comp) ? [] : [...retained, ...existing]
    match.broadcast = [...new Set([...previousLabels, ...found, ...courtStreams, ...eventRights])]
    return match
  })
}

module.exports = { fetchAll, readIQiyiList, readTencentMatches, readMiguMatches, dateToIso, tennisBroadcast, mergeBroadcasts }
