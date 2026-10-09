/**
 * 赛程数据同步脚本
 *
 * 从公开数据源抓取比赛日程，归一化后写入小程序本地数据文件 data/*.json。
 * 小程序发布后直接读取本地文件即可，不需要访问外部域名（微信 request 合法域名限制）。
 *
 * 用法： node tools/sync.js [daysBack] [daysForward]
 *   node tools/sync.js 14 45
 *
 * 数据源：
 *   足球 / NBA  -> ESPN 公开 scoreboard 接口（按月拉）
 *   英雄联盟    -> LoL Esports API：getTournamentsForLeague + getSchedule(tournamentId)
 */

const fs = require('fs')
const path = require('path')

const zhNames = require('./zh-names')
const { lolStatus } = require('./lol-status')
const { encodeSnapshot, decodeSnapshot } = require('../utils/snapshot')

const ROOT = path.join(__dirname, '..')
const OUT_DIR = path.join(ROOT, 'data')

const daysBack = Number(process.argv[2] || 14)
const daysForward = Number(process.argv[3] || 45)
/**
 * 第四个参数：只刷新指定范围，其余赛事沿用本地已有数据
 *   node tools/sync.js 14 60 worlds   只刷全球总决赛
 *   node tools/sync.js 14 60 lol      只刷全部英雄联盟赛事
 *   node tools/sync.js 14 60 espn     只刷足球 + NBA
 * 不传就是全量刷新。
 * 第五个参数：英雄联盟往回看的天数（默认 180，它的赛季数据更新很慢）。
 */
const only = (process.argv[4] || '').trim().toLowerCase()
const lolBack = Number(process.argv[5] || 180)

const ESPN = 'https://site.api.espn.com/apis/site/v2/sports'
const LOL = 'https://esports-api.lolesports.com/persisted/gw'
const LOL_KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z'
// 王者荣耀 KPL 官方（kpl.qq.com 前端包里挖出来的后端，无需 key，POST + JSON body）
const KPL = 'https://kplshop-op.timi-esports.qq.com/kplow'
// CBA 官方（cbaleague.com 前端包里的后端，无需 key，一次返回整赛季）
const CBA = 'https://portal-server.cbaleague.com'

/* ------------------------------------------------------------------ 竞赛定义 */

const COMPETITIONS = [
  // 赛事顺序即展示顺序：欧冠 → 五大联赛 → 欧国联 → 中国国字号 → 欧联 → 中超（2026-10-02 用户定）
  { key: 'ucl', source: 'espn', sport: 'soccer', cat: 'football', name: '欧冠', full: '欧洲冠军联赛', espn: 'uefa.champions', accent: '#1B2A6B' },
  { key: 'epl', source: 'espn', sport: 'soccer', cat: 'football', name: '英超', full: '英格兰超级联赛', espn: 'eng.1', accent: '#4B1F6B' },
  { key: 'liga', source: 'espn', sport: 'soccer', cat: 'football', name: '西甲', full: '西班牙甲级联赛', espn: 'esp.1', accent: '#D4700F' },
  { key: 'seriea', source: 'espn', sport: 'soccer', cat: 'football', name: '意甲', full: '意大利甲级联赛', espn: 'ita.1', accent: '#0B4A9E' },
  { key: 'bundesliga', source: 'espn', sport: 'soccer', cat: 'football', name: '德甲', full: '德国甲级联赛', espn: 'ger.1', accent: '#D0021B' },
  { key: 'ligue1', source: 'espn', sport: 'soccer', cat: 'football', name: '法甲', full: '法国甲级联赛', espn: 'fra.1', accent: '#123A78' },
  { key: 'nations', source: 'espn', sport: 'soccer', cat: 'football', name: '欧国联', full: '欧洲国家联赛', espn: 'uefa.nations', accent: '#0B4EA2' },
  {
    key: 'chn',
    source: 'espn',
    sport: 'soccer',
    cat: 'football',
    name: '中国国字号',
    full: '中国各级国家队（男足 / 女足 / 国奥 / 国青）',
    accent: '#C8102E',
    // 国字号没有单一联赛，横跨多个国际赛事；这里逐个拉取后再筛出中国队的比赛
    espns: [
      { slug: 'fifa.friendly', label: '国际友谊赛' },
      { slug: 'fifa.worldq.afc', label: '世预赛亚洲区' },
      { slug: 'afc.asian.cup', label: '亚洲杯' },
      { slug: 'fifa.olympics', label: '奥运会' },
      { slug: 'fifa.friendly_u21', label: 'U21 友谊赛' },
      { slug: 'fifa.world.u20', label: 'U20 世界杯' },
      { slug: 'fifa.world.u17', label: 'U17 世界杯' },
      { slug: 'fifa.wworld.u17', label: 'U17 女足世界杯' },
      { slug: 'fifa.friendly.w', label: '女足友谊赛' },
      { slug: 'fifa.wwc', label: '女足世界杯' },
      { slug: 'afc.w.asian.cup', label: '女足亚洲杯' },
      { slug: 'fifa.w.olympics', label: '女足奥运' },
      { slug: 'nonfifa', label: '非国际比赛日' },
    ],
    // 只保留中国队出场的比赛（男女足各年龄段的队名都以 China 开头）
    teamPick: /^china/i,
  },
  { key: 'uel', source: 'espn', sport: 'soccer', cat: 'football', name: '欧联', full: '欧足联欧洲联赛', espn: 'uefa.europa', accent: '#E2630F' },
  // 欧协联：欧战第三级别。积分榜里标了「欧协联」名额，赛事本身也得有入口才对得上
  { key: 'uecl', source: 'espn', sport: 'soccer', cat: 'football', name: '欧协联', full: '欧足联欧洲协会联赛', espn: 'uefa.europa.conf', accent: '#1E7A5A' },
  { key: 'csl', source: 'espn', sport: 'soccer', cat: 'football', name: '中超', full: '中国足球协会超级联赛', espn: 'chn.1', accent: '#A21C2E' },
  // 亚冠精英：北京国安 / 上海海港等中超球队参加的洲际俱乐部赛事（东亚区 + 西亚区）
  { key: 'acl', source: 'espn', sport: 'soccer', cat: 'football', name: '亚冠精英', full: '亚足联冠军精英联赛', espn: 'afc.champions', accent: '#0B6E4F' },
  // 亚冠二级：亚足联第二级别俱乐部赛事，ESPN 的 slug 仍叫 afc.cup（旧名亚足联杯）。
  // 有中超球队参加（2026 赛季上海申花在列）→ 关注页开放、详情也抓
  { key: 'acl2', source: 'espn', sport: 'soccer', cat: 'football', name: '亚冠二级', full: '亚足联冠军二级联赛', espn: 'afc.cup', accent: '#13755C' },
  // 女足欧冠：UEFA Women's Champions League，瑞士轮 18 队
  { key: 'wucl', source: 'espn', sport: 'soccer', cat: 'football', name: '女足欧冠', full: '欧足联女子冠军联赛', espn: 'uefa.wchampions', accent: '#6A2C91' },
  { key: 'mls', source: 'espn', sport: 'soccer', cat: 'football', name: '美职联', full: '美国职业足球大联盟', espn: 'usa.1', accent: '#0F5FA6' },
  { key: 'lib', source: 'espn', sport: 'soccer', cat: 'football', name: '解放者杯', full: '南美解放者杯', espn: 'conmebol.libertadores', accent: '#C99700' },
  { key: 'cnl', source: 'espn', sport: 'soccer', cat: 'football', name: '北美国联', full: '中北美及加勒比海国家联赛', espn: 'concacaf.nations.league', accent: '#2E86AB' },
  // 亚洲杯：2027-01-07 开赛（沙特）。ESPN 已经放了 48 场小组赛，但要等抓取窗口
  // 推到 2027-01 才会进快照（约 2026-12-17）——空赛事入口会自动隐藏，不用管
  { key: 'asiacup', source: 'espn', sport: 'soccer', cat: 'football', name: '亚洲杯', full: '亚足联亚洲杯（沙特 2027）', espn: 'afc.asian.cup', accent: '#B8860B' },
  // ⚠️ 两个 U17 世界杯都是「赛会制 + 短期窗口」：开赛前 45 天才会进入抓取窗口，
  //    平时这两项是空的（空的赛事入口会自动隐藏，不会白屏）
  { key: 'u17', source: 'espn', sport: 'soccer', cat: 'football', name: 'U17世界杯', full: '国际足联 U-17 男足世界杯（卡塔尔 2026）', espn: 'fifa.world.u17', accent: '#8B1538' },
  { key: 'u17w', source: 'espn', sport: 'soccer', cat: 'football', name: 'U17女足世界杯', full: '国际足联 U-17 女足世界杯（摩洛哥 2026）', espn: 'fifa.wworld.u17', accent: '#B0347A' },
  // 国际友谊赛：全球各国字号热身赛。中国队那部分另有一个「中国国字号」入口，
  // 这里给的是全量（看别的国家队热身用）
  { key: 'friendly', source: 'espn', sport: 'soccer', cat: 'football', name: '国际友谊赛', full: '国际足联国际友谊赛', espn: 'fifa.friendly', accent: '#4A6FA5' },
  { key: 'nba', source: 'espn', sport: 'basketball', cat: 'basketball', name: 'NBA', full: '美国职业篮球联赛', espn: 'nba', accent: '#C8102E' },
  { key: 'cba', source: 'cba', sport: 'basketball', cat: 'basketball', name: 'CBA', full: '中国男子篮球职业联赛', accent: '#1E5FA8' },
  // 电竞顺序：全球总决赛 → 德玛西亚杯 → LPL → LCK → KPL → LEC → 季中冠军赛 → 亚运会
  { key: 'worlds', source: 'lol', cat: 'esports', name: '全球总决赛', full: '英雄联盟全球总决赛', lol: '98767975604431411', lolSlug: 'worlds', accent: '#B99433' },
  {
    key: 'demacia', source: 'lol', cat: 'esports', name: '德玛西亚杯', full: '德玛西亚杯（LPL 区域杯赛）',
    // LoL Esports API 的 leagues 列表里叫 DCGI（demacia_cup）
    lol: '117126995932274206', lolSlug: 'demacia_cup', accent: '#2E7CF6',
  },
  { key: 'lpl', source: 'lol', cat: 'esports', name: 'LPL', full: '英雄联盟职业联赛 · 中国大陆赛区', lol: '98767991314006698', lolSlug: 'lpl', accent: '#D4232A' },
  { key: 'lck', source: 'lol', cat: 'esports', name: 'LCK', full: '英雄联盟冠军联赛 · 韩国赛区', lol: '98767991310872058', lolSlug: 'lck', accent: '#1155A3' },
  { key: 'kpl', source: 'kpl', cat: 'esports', name: 'KPL', full: '王者荣耀职业联赛', accent: '#D9A441' },
  { key: 'lec', source: 'lol', cat: 'esports', name: 'LEC', full: '英雄联盟锦标赛 · EMEA 赛区', lol: '98767991302996019', lolSlug: 'lec', accent: '#6B3FA0' },
  { key: 'msi', source: 'lol', cat: 'esports', name: '季中冠军赛', full: '英雄联盟季中冠军赛', lol: '98767991325878492', lolSlug: 'msi', accent: '#0E8C8C' },
  {
    key: 'agames', source: 'lol', cat: 'esports', name: '亚运会电竞', full: '亚运会 · 英雄联盟项目',
    // LoL Esports API 的 leagues 列表里叫 Asian Games（asian_games）
    lol: '117228885404001005', lolSlug: 'asian_games', accent: '#C8952A',
  },
]

/* 各大类里的展示顺序（2026-10-02 用户定，与上面 COMPETITIONS 的顺序保持一致） */
const SPORT_CATS = {
  football: {
    name: '足球',
    competitions: ['ucl', 'epl', 'liga', 'seriea', 'bundesliga', 'ligue1', 'nations', 'chn', 'uel', 'uecl', 'csl', 'acl', 'acl2', 'wucl', 'mls', 'lib', 'cnl', 'asiacup', 'u17', 'u17w', 'friendly'],
  },
  basketball: { name: '篮球', competitions: ['nba', 'cba'] },
  esports: { name: '电竞', competitions: ['worlds', 'demacia', 'lpl', 'lck', 'kpl', 'lec', 'msi', 'agames'] },
}

/** 解析命令行第四个参数，决定本次要刷哪些赛事 */
function resolveTargets() {
  if (!only) return COMPETITIONS
  if (only === 'lol' || only === 'esports') return COMPETITIONS.filter((c) => c.source === 'lol')
  if (only === 'espn' || only === 'sports') return COMPETITIONS.filter((c) => c.source !== 'lol')
  const hit = COMPETITIONS.filter((c) => c.key === only || c.name === only)
  if (hit.length) return hit
  console.warn(`⚠ 未识别的范围「${only}」，可选：${COMPETITIONS.map((c) => c.key).join('/')} / lol / espn。本次按全量处理。`)
  return COMPETITIONS
}

const targets = resolveTargets()

/** LPL / LCK 常见队伍的中文规范名（按官方缩写映射，取不到就用 API 原名） */
const TEAM_CN = {
  BLG: '哔哩哔哩', JDG: '京东电子竞技', TES: '滔搏电子竞技', WBG: '微博电子竞技',
  AL: 'Anyone\'s Legend', IG: 'Invictus Gaming', FPX: 'FunPlus Phoenix', NIP: 'Ninjas in Pyjamas',
  TT: 'ThunderTalk Gaming', LNG: 'LNG Esports', EDG: 'Edward Gaming', WE: 'Team WE',
  RNG: 'Royal Never Give Up', UP: 'Ultra Prime', OMG: 'Oh My God', RA: 'Rare Atom',
  LGD: 'LGD Gaming', FPB: 'FunPlus Blaze', T1: 'T1', GEN: 'Gen.G', HLE: 'Hanwha Life',
  DK: 'Dplus KIA', DRX: 'DRX', KT: 'KT Rolster', NS: 'Nongshim RedForce',
  BFX: 'BNK FearX', DNF: 'DN Freecs', BRO: 'OKSavingsBank Brion', NSX: 'NongshimEsports Academy',
}

/* ------------------------------------------------------------------ 工具函数 */

async function getJSON(url, headers) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      const res = await fetch(url, { headers, signal: controller.signal })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      if (attempt === 2) throw err
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)))
    }
  }
  return null
}

/** KPL / CBA 这类官方接口是 POST + JSON body，重试策略与 getJSON 一致 */
async function postJSON(url, body, headers) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), 30000)
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...(headers || {}) },
        body: JSON.stringify(body || {}),
        signal: controller.signal,
      })
      clearTimeout(timer)
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      return await res.json()
    } catch (err) {
      if (attempt === 2) throw err
      await new Promise((r) => setTimeout(r, 700 * (attempt + 1)))
    }
  }
  return null
}

const pad = (n) => String(n).padStart(2, '0')

/** window 覆盖到的 YYYYMM 月份列表 */
function months() {
  const from = new Date(Date.now() - daysBack * 86400000)
  const to = new Date(Date.now() + daysForward * 86400000)
  const list = []
  let cursor = new Date(Date.UTC(from.getUTCFullYear(), from.getUTCMonth(), 1))
  while (cursor <= to) {
    list.push(`${cursor.getUTCFullYear()}${pad(cursor.getUTCMonth() + 1)}`)
    cursor = new Date(Date.UTC(cursor.getUTCFullYear(), cursor.getUTCMonth() + 1, 1))
  }
  return list
}

/** 北京时间 YYYY-MM-DD */
function beijingDay(iso) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600000)
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`
}

/** 北京时间 HH:mm */
function beijingTime(iso) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600000)
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`
}

function normTeam(raw, fallbackName, fallbackColor) {
  const name = raw.displayName || raw.name || raw.shortDisplayName || fallbackName || '待定'
  const id = String(raw.id || name)
  return {
    id,
    name,
    // 中文名：小程序里优先展示，取不到就用英文名。
    // 四级兜底：① ESPN 队 id（俱乐部/国家队主表）② 淘汰赛占位对阵（"Group A Winner"
    // 这类没有 team id）③ 英文名（国青队 U17/U20 与亚冠外国俱乐部没有单独 id 映射）
    // ④ 留空 → 展示英文名
    zh: zhNames.espnZh(id) || zhNames.placeholderZh(name) || zhNames.nameZh(name) || '',
    abbr: (raw.abbreviation || raw.shortDisplayName || name).slice(0, 6),
    color: raw.color ? `#${String(raw.color).replace('#', '')}` : fallbackColor || '#6B7280',
  }
}

const STATE_MAP = { pre: 'upcoming', in: 'live', post: 'finished' }

/**
 * 篮球赛季类型 → 中文
 * 🔴 为什么非要这张表：NBA 的 `ev.season` 是 `{"year":2027,"type":1,"slug":"preseason"}`
 *    —— `type` 是**数字**不是对象，所以 `ev.season?.type?.name` 恒为 undefined
 *    （足球那边 `type` 才是 `{id,type,name}`，而且还有 `competition.round.displayName`）。
 *    结果就是季前赛和常规赛在界面上完全分不出来，全显示成光秃秃的「NBA」。
 * ⚠️ 只对篮球生效（下面按 `comp.sport` 收口），别顺手套到足球上。
 */
const SEASON_TYPE_ZH = {
  preseason: '季前赛',
  'regular-season': '常规赛',
  'post-season': '季后赛',
  postseason: '季后赛',
  'all-star': '全明星',
}

/** 把 ESPN 的英文状态短描述换成中文 */
function zhStatus(state, shortDetail) {
  if (state === 'in') return shortDetail || '进行中'
  if (state === 'post') {
    if (/postpon|cancel/i.test(shortDetail || '')) return '已延期'
    if (/pen/i.test(shortDetail || '')) return '点球大战'
    if (/aet|extra/i.test(shortDetail || '')) return '加时赛'
    return '已结束'
  }
  // 未开始的比赛只展示北京时间，不再出现 "10/3 - 7:00 PM EDT" 这类原文
  return ''
}

/* ------------------------------------------------------------------ ESPN */

async function fetchEspn(comp) {
  // 普通赛事只有一个联赛；中国国字号这类要横跨多个国际赛事再筛球队
  const sources = comp.espns
    ? comp.espns.map((s) => ({ id: s.slug, label: s.label }))
    : [{ id: comp.espn, label: '' }]
  const seen = new Map()

  for (const src of sources) {
    const base = `${ESPN}/${comp.sport}/${src.id}/scoreboard`

    for (const month of months()) {
      let json
      try {
        json = await getJSON(`${base}?dates=${month}`)
      } catch (err) {
        console.warn(`\n  ! ${comp.key} ${src.id} ${month} 抓取失败: ${err.message}`)
        continue
      }
      if (!json || !Array.isArray(json.events)) continue

      for (const ev of json.events) {
        const competition = (ev.competitions && ev.competitions[0]) || null
        if (!competition) continue
        const competitors = competition.competitors || []
        const homeRaw = competitors.find((c) => c.homeAway === 'home') || competitors[0]
        const awayRaw = competitors.find((c) => c.homeAway === 'away') || competitors[1]
        if (!homeRaw || !awayRaw) continue

        // 只保留指定球队出场的比赛（中国国字号用）
        const pick = comp.teamPick
        if (pick && ![homeRaw.team, awayRaw.team].some((t) => pick.test(t?.displayName || t?.name || ''))) continue

        const kickoff = competition.date || ev.date
        if (!kickoff) continue

        const num = (v) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null)
        const round = competition.round?.displayName || ev.season?.type?.name || ''
        // 🔴 篮球没有 competition.round，只能靠 season.slug 区分季前赛/常规赛/季后赛。
        //    收口到 `comp.sport === 'basketball'` —— 足球一行都不受影响。
        const seasonZh =
          comp.sport === 'basketball' ? SEASON_TYPE_ZH[ev.season && ev.season.slug] || '' : ''
        const stage = src.label
          ? round
            ? `${src.label} · ${round}`
            : src.label
          : seasonZh
            ? `${comp.name} · ${seasonZh}`
            : round || comp.name

        seen.set(`${comp.key}-${ev.id}`, {
          id: `${comp.key}-${ev.id}`,
          comp: comp.key,
          start: kickoff,
          date: beijingDay(kickoff),
          time: beijingTime(kickoff),
          status: STATE_MAP[ev.status?.type?.state] || 'upcoming',
          statusText: zhStatus(ev.status?.type?.state, ev.status?.type?.shortDetail),
          stage,
          venue: competition.venue?.fullName || '',
          broadcast: (competition.broadcasts || [])
            .map((b) => b.media?.shortName)
            .filter(Boolean)
            .filter((v, i, a) => a.indexOf(v) === i)
            .slice(0, 3),
          bo: null,
          // 多来源赛事（中国国字号）必须把来源联赛带出去 —— match-detail.js 抓
          // summary 时按 slug 定位 ESPN 端点，没有它就拿不到比赛详情
          ...(comp.espns ? { slug: src.id } : {}),
          home: { ...normTeam(homeRaw.team || {}, homeRaw.athlete?.displayName, comp.accent), score: num(homeRaw.score) },
          away: { ...normTeam(awayRaw.team || {}, awayRaw.athlete?.displayName, comp.accent), score: num(awayRaw.score) },
        })
      }
    }
  }
  return [...seen.values()]
}

/* ------------------------------------------------------------------ LoL */

/**
 * ⚠️ 英雄联盟俱乐部队（LPL/LCK/LEC/世界赛/季中赛/德杯）一律用**英文简称** BLG / T1 / G2，
 *    2026-10-02 用户明确要求 —— 电竞圈的习惯就是叫简码，写「哔哩哔哩」反而认不出来。
 *    显示口径是 `zh || name`，所以这里把 name 直接放简码、zh 留空。
 *    ⚠️ 唯一例外是**亚运会电竞**：那是国家队，code 是 IOC 三字码（CHN / TPE / HKG），
 *    必须走中文映射（且港澳台固定写「中国香港 / 中国澳门 / 中国台北」）。
 */
function lolTeam(raw, accent, compKey) {
  const code = (raw.code || raw.name || '?').slice(0, 6)
  const isNational = compKey === 'agames'
  return {
    id: code,
    name: isNational ? (raw.name || '待定') : code,
    zh: isNational ? (zhNames.lolZh(code) || TEAM_CN[code] || '') : '',
    abbr: code,
    color: accent,
  }
}

/**
 * 全局赛程流兜底。
 *
 * `getSchedule` 传 tournamentId 其实会被忽略，返回的是「近期全部赛事」的流。
 * 官方按 leagueId 的翻页跨赛季时经常断链（比如 S 赛新赛季放出来后，leagueId 的 newer 链可能仍停在去年），
 * 这里沿着这条流往前翻，把属于本赛事且在时间窗内的比赛挑出来。
 */
async function fetchLolFromFeed(comp, make, lower, upper) {
  const headers = { 'x-api-key': LOL_KEY }
  // tournamentId 只是用来触发全局流，具体值不参与过滤
  const base = `${LOL}/getSchedule?hl=zh-CN&tournamentId=98767975604431411`
  const out = []
  let token = null
  let guard = 0

  try {
    while (guard < 10) {
      guard += 1
      const url = base + (token ? `&pageToken=${encodeURIComponent(token)}` : '')
      const j = await getJSON(url, headers)
      if (!j?.data?.schedule) break
      const evs = j.data.schedule.events || []
      evs.forEach((ev) => {
        if (ev.type !== 'match' || !ev.match) return
        if (!ev.league || ev.league.slug !== comp.lolSlug) return
        const t = new Date(ev.startTime)
        if (t < lower || t > upper) return
        out.push(make(ev, false))
      })
      const next = j.data.schedule.pages?.newer
      if (!next) break
      if (evs.length && new Date(evs[evs.length - 1].startTime) > upper) break
      token = next
    }
  } catch {
    // 兜底通道失败不影响主流程
  }
  return out
}

/**
 * LoL 官方接口只按 leagueId 返回，没有 tournamentId 过滤能力，
 * 而且 split_3 之后还没放出新的未来赛程。这里统一策略：
 *   1. 取该赛事的当前页和向前翻页，落在时间窗内的比赛全部保留；
 *   2. 若窗口内一场都没有（赛季间歇期），退化为保留当前页最近 20 场历史比赛，
 *      保证每个赛事都有内容可展示，而不是空列表。
 */
async function fetchLol(comp) {
  const headers = { 'x-api-key': LOL_KEY }
  const lower = new Date(Date.now() - lolBack * 86400000)
  const upper = new Date(Date.now() + daysForward * 86400000)
  const base = `${LOL}/getSchedule?hl=zh-CN&leagueId=${comp.lol}`

  const make = (ev, forced) => {
    const teams = ev.match.teams || []
    const tbd = { id: 'TBD', name: '待定', zh: '待定', abbr: 'TBD', color: '#8A93A6' }
    const home = teams[0] ? lolTeam(teams[0], comp.accent, comp.key) : tbd
    const away = teams[1] ? lolTeam(teams[1], comp.accent, comp.key) : tbd
    // 上游 state 会滞后于实际赛果，判定逻辑见 tools/lol-status.js
    const st = lolStatus(ev)
    return {
      id: `${comp.key}-${ev.match.id}`,
      comp: comp.key,
      start: ev.startTime,
      date: beijingDay(ev.startTime),
      time: beijingTime(ev.startTime),
      status: st.status,
      statusText: st.statusText,
      stage: `${comp.name} · ${ev.blockName || '常规赛'}`,
      venue: '',
      broadcast: [],
      bo: ev.match.strategy?.count || null,
      home: { ...home, score: st.homeScore },
      away: { ...away, score: st.awayScore },
      historical: !!forced,
    }
  }

  let json
  try {
    json = await getJSON(base, headers)
  } catch (err) {
    console.warn(`\n  ! ${comp.key} 赛程抓取失败: ${err.message}`)
    return []
  }
  if (!json?.data?.schedule) return []

  const pages = [json.data.schedule.events || []]

  // 向前翻页，拿到已公布的未来赛程
  let newer = json.data.schedule.pages?.newer
  let guard = 0
  while (newer && guard < 12) {
    guard += 1
    let j
    try {
      j = await getJSON(`${base}&pageToken=${encodeURIComponent(newer)}`, headers)
    } catch { break }
    if (!j?.data?.schedule) break
    const evs = j.data.schedule.events || []
    pages.push(evs)
    if (!evs.length || new Date(evs[evs.length - 1].startTime) > upper) break
    newer = j.data.schedule.pages?.newer
  }

  const all = pages.flat().filter((ev) => ev.type === 'match' && ev.match)
  const inWindow = []
  const historic = []
  for (const ev of all) {
    const t = new Date(ev.startTime)
    if (t >= lower && t <= upper) inWindow.push(make(ev, false))
    else if (t < lower) historic.push(make(ev, true))
  }

  // 按赛事 ID 的翻页跨赛季不可靠：如果一次都没抓到「未开赛」的场次，
  // 再去全局赛程流里找一遍该赛事的比赛（S 赛放日程后主要靠这条通道进来）。
  if (!inWindow.some((m) => m.status !== 'finished')) {
    const extra = await fetchLolFromFeed(comp, make, lower, upper)
    if (extra.length) {
      process.stdout.write(` [赛程流补 ${extra.length} 场]`)
      const ids = new Set(inWindow.map((m) => m.id))
      extra.forEach((m) => { if (!ids.has(m.id)) inWindow.push(m) })
    }
  }

  if (inWindow.length) {
    const map = new Map(inWindow.map((m) => [m.id, m]))
    return [...map.values()].sort((a, b) => (a.start < b.start ? -1 : 1))
  }

  // 赛季间歇：退化为最近的历史赛程，UI 会标注「历史战绩」
  historic.sort((a, b) => (a.start < b.start ? 1 : -1))
  process.stdout.write(' [赛季间歇, 取历史赛程]')
  return historic.slice(0, 20)
}

/* ------------------------------------------------------------------ 王者荣耀 KPL */

/**
 * schedule_status 语义——以 KPL 官网前端为权威来源，不再是猜的。
 * 取证 2026-10-02：官网 https://kpl.qq.com/ → 懒加载 chunk /static/Schedule-B0oR1B8y.js，其中
 *   const Be = e => ({ 1:"未开始", 2:"已取消", 3:"进行中", 4:"已结束" })[e] || ""   // 卡片状态文案
 *   const De = e => ({ 1:"notstart", 3:"ongoing" })[e] || ""                       // 卡片样式类
 * 且模板里 Be(s.schedule_status) 直接用在本接口的字段上；
 * status===3 渲染 liveIcon +「观看直播」按钮，status===4 渲染回放入口，
 * 页面自动滚动定位取的是「今天第一场 schedule_status===1 或 3 的比赛」——2 被排除在外。
 *
 * 实拉数据佐证（2026-10-02 15:57 北京时间，seasonid:"" 返回本季共 37 场）：
 *   1 → 35 场，全部未到开赛时间、比分 0:0
 *   4 → 1 场，14:00 广州TTG 3:0 深圳DYG，已过开赛时间且已结算（round_settle_nums=3）
 *   3 → 1 场，17:00 KSG vs 济南RW侠（当时距开赛还有 1 小时，比分 0:0）
 *       ⇒ 上游会在直播开始前就把比赛切成 3，这是源站口径，照它显示即可
 *   （上赛季 KPL2026S2 共 136 场全部为 4，进一步印证 4=已结束）
 *
 * ⚠️ 旧版把 2 当成「进行中」是错的，官方语义 2=已取消。已取消的比赛不进列表：
 *    小程序只有 upcoming/live/finished 三态，挂成未开始会一直占位。
 */
const KPL_STATE = { 1: 'upcoming', 3: 'live', 4: 'finished' }
const KPL_CANCELED = 2

function kplTeam(id, name, accent) {
  // 季后赛未确定的对阵，两边都是"待定"且同 id，统一成 TBD，免得关注撞车
  const tbd = !name || name === '待定' || String(id || '').endsWith('_dd')
  const label = tbd ? '待定' : name
  return {
    id: tbd ? 'TBD' : String(id),
    name: label,
    zh: tbd ? '待定' : name,
    abbr: tbd ? 'TBD' : label,
    color: accent,
  }
}

async function fetchKpl(comp) {
  const lower = new Date(Date.now() - daysBack * 86400000)
  const upper = new Date(Date.now() + daysForward * 86400000)

  let json
  try {
    // seasonid 传空串 = 当前赛季；接口一次返回整赛季，本地再按时间窗裁
    json = await postJSON(`${KPL}/getScheduleList`, { seasonid: '' })
  } catch (err) {
    console.warn(`\n  ! ${comp.key} 赛程抓取失败: ${err.message}`)
    return []
  }

  const list = json?.data?.list || []
  const out = []
  for (const ev of list) {
    const ts = Number(ev.start_timestamp)
    if (!ts) continue
    const start = new Date(ts * 1000).toISOString()
    const t = new Date(start)
    if (t < lower || t > upper) continue

    // 2=已取消（官网语义），小程序没有 canceled 态，直接丢弃而不是挂成未开始
    if (ev.schedule_status === KPL_CANCELED) continue

    // 官方状态未覆盖到的取值兜底成未开赛；真出现上游滞后（打完了还报 1）就按比分补成已结束
    let status = KPL_STATE[ev.schedule_status] || 'upcoming'
    const played = Number(ev.team_a_score || 0) + Number(ev.team_b_score || 0)
    if (status === 'upcoming' && played > 0) status = 'finished'
    const showScore = status === 'finished' || status === 'live'
    const num = (v) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null)

    out.push({
      id: `${comp.key}-${ev.scheduleid}`,
      comp: comp.key,
      // 🔴 getScheduleDetail 的 scheduleid + seasonid **必须同时传**（只传一个 → 10020003）。
      //    scheduleid 可从 id 前缀还原，seasonid 没地方放 → 存在这里，详情抓取靠它。
      seasonid: ev.seasonid || '',
      start,
      date: beijingDay(start),
      time: beijingTime(start),
      status,
      statusText: status === 'finished' ? '已结束' : status === 'live' ? '进行中' : '',
      stage: `${comp.name} · ${ev.stage_name || '常规赛'}`,
      venue: ev.arenas || ev.location_name || '',
      broadcast: [],
      bo: num(ev.bo_total),
      home: { ...kplTeam(ev.team_a_id, ev.team_a_name, comp.accent), score: showScore ? num(ev.team_a_score) : null },
      away: { ...kplTeam(ev.team_b_id, ev.team_b_name, comp.accent), score: showScore ? num(ev.team_b_score) : null },
    })
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : 1))
}

/* ------------------------------------------------------------------ CBA */

/**
 * CBA 官方一次返回整赛季（490 场、280KB），本地按时间窗裁。
 * 只返回当前赛季：?season= / ?seasonid= 实测无效（2026-10-09 验证）。
 * /cbdl/game_detail 需要联赛权限，返回"没有该联赛的访问权限"，用不了。
 *
 * ⚠️ 状态推断 —— 2026-10-09 15:46 实测（赛季首场 15:00 开打，首次拿到非未开赛样本）：
 *   未开赛：Status=1，StatusCNName="未开始"，
 *           Quarter / Minutes / Seconds / 两队 Score 全是 null
 *   进行中：Status=2，StatusCNName="进行中"，
 *           Quarter=当前节次（实测 2），Minutes/Seconds=本节剩余倒计时（实测 3:05 → 2:26 递减），
 *           两队 Score 实时填充（实测 天津41-32广州 / 浙江46-49江苏 等 5 场）
 *   已结束：Status 推测为 3，StatusCNName 推测为"已结束"，比分保留 ——
 *           ❗截止验证时全赛季 490 场里还没有任何一场打完（最早比赛就是今天 15:00），
 *             所以"已结束"是**推测值，没有实测样本**，赛季首场打完后需回来复核。
 *
 * 判据优先级（不要再改回「Quarter 有值 → live」当首选）：
 *   1. StatusCNName —— 上游自己给的中文态，最权威。但它只对临近日期的比赛返回
 *      （实测 490 场里只有今天 10 场带这个字段，其余 480 场是 undefined）。
 *   2. Status 数字 —— 兜底，覆盖没给 StatusCNName 的远端赛程。
 *   3. 比分 / 节次 —— 最后兜底，Status 缺失或出现未知取值时才用。
 *   ⚠️ 旧逻辑把 Quarter 放在 Status 之前判 live：一旦赛后 Quarter 仍停在 4，
 *      已结束的比赛会被永久误判成"进行中"，所以必须让 Status/StatusCNName 先说话。
 *
 * 另外加了一道时间保险：开赛超过 5 小时还判成 live 的，一律按已结束处理。
 * CBA 一场加时也不到 4 小时，这是防止上游 Status 卡住导致"进行中"永不落地。
 */
const num_ = (v) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null)

function cbaStatusRaw(ev, hasScore) {
  // 1) 上游自带的中文态最可信
  const cn = String(ev.StatusCNName || '').trim()
  if (['已结束', '完场', '比赛结束', '已完场'].includes(cn)) return 'finished'
  if (cn === '进行中') return 'live'
  if (['未开始', '未开赛', '待定'].includes(cn)) return 'upcoming'

  // 2) Status 数字兜底（远端比赛没有 StatusCNName）
  const s = Number(ev.Status)
  if (s === 2) return 'live'
  if (s >= 3) return 'finished'      // 3 为推测的已结束码，>=3 一并兜住未知码
  if (s === 1) return 'upcoming'

  // 3) 都没给：退回比分与节次
  return num_(ev.Quarter) != null ? 'live' : hasScore ? 'finished' : 'upcoming'
}

function cbaStatus(ev, hasScore, startedAtMs) {
  const s = cbaStatusRaw(ev, hasScore)
  // 时间保险：开赛超过 5 小时仍判成 live 的，一律落地为 finished
  if (s === 'live' && startedAtMs != null && Date.now() - startedAtMs > 5 * 3600000) return 'finished'
  return s
}

async function fetchCba(comp) {
  const from = beijingDay(new Date(Date.now() - daysBack * 86400000).toISOString())
  const to = beijingDay(new Date(Date.now() + daysForward * 86400000).toISOString())

  let json
  try {
    json = await getJSON(`${CBA}/home/home_schedules`)
  } catch (err) {
    console.warn(`\n  ! ${comp.key} 赛程抓取失败: ${err.message}`)
    return []
  }

  const list = Array.isArray(json?.data) ? json.data : []
  const num = (v) => (v != null && v !== '' && !Number.isNaN(Number(v)) ? Number(v) : null)
  const out = []

  for (const ev of list) {
    const d = String(ev.dates || '')
    const tm = String(ev.time || '00:00')
    if (!/^\d{4}-\d{2}-\d{2}$/.test(d)) continue
    if (d < from || d > to) continue

    // dates + time 都是北京时间，直接按 +08:00 组装
    const start = new Date(`${d}T${tm}:00+08:00`).toISOString()
    const hasScore = num(ev.HomeTeamScore) != null || num(ev.VisitingTeamScore) != null
    const status = cbaStatus(ev, hasScore, new Date(start).getTime())
    const showScore = status !== 'upcoming' || hasScore
    const typeName = ev.ScheduleTypeDesc || (ev.ScheduleTypeID === 3 ? '季前赛' : '常规赛')

    out.push({
      id: `${comp.key}-${ev.ScheduleID}`,
      comp: comp.key,
      start,
      date: d,
      time: tm,
      status,
      statusText: status === 'finished' ? '已结束' : status === 'live' ? '进行中' : '',
      stage: `${comp.name} · ${ev.GroupName || typeName}`,
      venue: ev.stadium || '',
      broadcast: [],
      bo: null,
      home: {
        id: String(ev.HomeTeamID || ev.HomeTeamName || '?'),
        name: ev.HomeTeamName || '待定',
        zh: ev.HomeTeamName || '',
        abbr: ev.HomeTeamName || '待定',
        color: comp.accent,
        score: showScore ? num(ev.HomeTeamScore) : null,
      },
      away: {
        id: String(ev.VisitingTeamID || ev.VisitingTeamName || '?'),
        name: ev.VisitingTeamName || '待定',
        zh: ev.VisitingTeamName || '',
        abbr: ev.VisitingTeamName || '待定',
        color: comp.accent,
        score: showScore ? num(ev.VisitingTeamScore) : null,
      },
    })
  }
  return out.sort((a, b) => (a.start < b.start ? -1 : 1))
}

/* ------------------------------------------------------------------ 主流程 */

/** 赛事覆盖情况报告：一眼看出哪些赛事抓到了数据、未来赛程有没有进来 */
function report(all) {
  const today = beijingDay(new Date().toISOString())
  const lines = []
  const rows = COMPETITIONS.map((c) => {
    const list = all.filter((m) => m.comp === c.key)
    const upcoming = list.filter((m) => m.status === 'upcoming' && m.date >= today)
    return {
      name: c.name,
      total: list.length,
      first: list.length ? list[0].date : '-',
      last: list.length ? list[list.length - 1].date : '-',
      upcoming: upcoming.length,
      next: upcoming.length ? `${upcoming[0].date} ${upcoming[0].time}` : '无未来赛程',
    }
  })
  const w1 = Math.max(6, ...rows.map((r) => r.name.length))
  lines.push('')
  lines.push(`  ${'赛事'.padEnd(w1)}   场次   日期范围                次日/最近           未来`)
  lines.push(`  ${'-'.repeat(w1 + 60)}`)
  rows.forEach((r) => {
    lines.push(`  ${r.name.padEnd(w1)}  ${String(r.total).padStart(4)}   ${(r.first + ' ~ ' + r.last).padEnd(24)}  ${r.next.padEnd(18)}  ${r.upcoming}`)
    if (!r.total) lines.push(`      ⚠ 该赛事一场都没抓到，检查一下接口或联赛 ID`)
    else if (!r.upcoming) lines.push(`      · 赛季间歇期，展示的是历史赛程`)
  })
  lines.push('')
  return lines.join('\n')
}

/** 列出缺失中文名的球队（小程序里会静默回落英文名） */
function missingZh(all) {
  const map = new Map()
  all.forEach((m) => {
    [m.home, m.away].forEach((t) => {
      if (!t.zh && t.abbr !== 'TBD') map.set(t.id, `${t.abbr}  ${t.name}`)
    })
  })
  return [...map.values()].sort()
}

/**
 * 数据文件刻意写成 JS 模块（module.exports = …）而不是 .json，原因有两个：
 *  1. 小程序原生的 require 对独立 .json 的支持并不稳定，一旦加载失败，会在页面
 *     模块加载阶段就抛错，直接整页白屏（真机上比开发者工具更容易踩到）；
 *  2. 开发者工具的「上传时过滤无依赖文件」对纯数据 .json 的静态依赖分析不可靠，
 *     可能把数据文件整份漏掉 —— 那样真机打开就是彻底空白。
 * 换成 .js 之后 require 依赖是确定的，数据一定进包。
 */
function toModule(value) {
  return `/** 本文件由 node tools/sync.js 生成，请勿手动修改 */\nmodule.exports = ${JSON.stringify(value)}\n`
}

/** 读取上一轮生成的数据。历史版本写过 .json，这里做一次兼容 */
function loadExisting(jsPath) {
  const candidates = [jsPath, jsPath.replace(/\.js$/, '.json')]
  for (const p of candidates) {
    if (!fs.existsSync(p)) continue
    try {
      if (p.endsWith('.json')) return JSON.parse(fs.readFileSync(p, 'utf8'))
      // eslint-disable-next-line
      return decodeSnapshot(require(p))
    } catch (err) {
      console.warn(`  读取 ${path.basename(p)} 失败，按空数据处理：${err.message}`)
    }
  }
  return []
}

/** 清掉老版本遗留的 .json 数据文件，避免两边数据不一致 */
function dropLegacyJson() {
  ;['matches', 'meta'].forEach((name) => {
    const p = path.join(OUT_DIR, `${name}.json`)
    if (fs.existsSync(p)) {
      fs.unlinkSync(p)
      console.log(`  已移除旧数据文件 data/${name}.json`)
    }
  })
}

/**
 * 把补录表并进结果：ESPN 没有的赛事（亚运会等）靠它兜底。
 *
 * - 只保留落在抓取时间窗内的（补录表是长期文件，过期条目不该一直出现）
 * - id 撞车时以已有数据为准，避免同一场比赛出现两条
 * - 开赛超过 48 小时仍是 upcoming 的补录比赛直接丢弃：
 *   补录的比分没法自动更新，与其长期挂一场「未开始」的过期比赛，不如下架。
 */
function mergeManual(rows, range) {
  const manual = require('./manual-matches.js')
  const had = {}
  rows.forEach((m) => { had[m.id] = true })
  const staleBefore = Date.now() - 48 * 3600000
  return manual.filter((m) => {
    if (!m || !m.id || had[m.id]) return false
    if (m.date < range.from || m.date > range.to) return false
    if (m.status === 'upcoming' && Date.parse(m.start) < staleBefore) return false
    return true
  })
}

async function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  const existingPath = path.join(OUT_DIR, 'matches.js')
  const existing = loadExisting(existingPath)

  const metaRange = {
    from: beijingDay(new Date(Date.now() - daysBack * 86400000).toISOString()),
    to: beijingDay(new Date(Date.now() + daysForward * 86400000).toISOString()),
  }

  const fetched = []
  const kept = []
  const failed = []
  const targetKeys = targets.map((c) => c.key)

  // 非本次刷新的赛事沿用本地数据，不会被清空
  existing.filter((m) => targetKeys.indexOf(m.comp) === -1).forEach((m) => kept.push(m))

  for (const comp of targets) {
    process.stdout.write(`抓取 ${comp.name.padEnd(6)} …`)
    const rows = comp.source === 'lol'
      ? await fetchLol(comp)
      : comp.source === 'kpl'
        ? await fetchKpl(comp)
        : comp.source === 'cba'
          ? await fetchCba(comp)
          : await fetchEspn(comp)
    rows.sort((a, b) => (a.start < b.start ? -1 : 1))

    if (rows.length) {
      console.log(` ${rows.length} 场`)
      fetched.push(...rows)
      continue
    }

    // 接口偶发空返回时保住原有数据，不能让一次抖动把赛事清空
    const old = existing.filter((m) => m.comp === comp.key)
    if (old.length) {
      console.log(` 0 场（接口本次无数据，保留原有 ${old.length} 场）`)
      kept.push(...old)
    } else {
      console.log(' 0 场')
    }
    failed.push(comp.name)
  }

  // ESPN 覆盖不到的赛事（亚运会等）走补录表，详见 tools/manual-matches.js
  const manualRows = mergeManual([...kept, ...fetched], metaRange)

  const all = [...kept, ...fetched, ...manualRows].sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))

  const metaPath = path.join(OUT_DIR, 'meta.js')
  const oldMeta = path.join(OUT_DIR, 'meta.json')
  let meta = { generatedAt: '', range: {}, categories: [], competitions: [] }
  if (fs.existsSync(oldMeta)) {
    try { meta = JSON.parse(fs.readFileSync(oldMeta, 'utf8')) } catch { /* 用上面的默认值 */ }
  }
  meta.generatedAt = new Date().toISOString()
  meta.range = metaRange
  meta.categories = Object.entries(SPORT_CATS).map(([key, v]) => ({ key, name: v.name, competitions: v.competitions }))
  meta.competitions = COMPETITIONS.map((c) => ({
    key: c.key, name: c.name, full: c.full, cat: c.cat, accent: c.accent,
  }))

  fs.writeFileSync(metaPath, toModule(meta))
  // ⚠️ 快照用**紧凑格式**写（utils/snapshot.js 的 encodeSnapshot）：
  //    球队抽成共享字典、date/time 由 start 推、空值不写，实测 790KB → 230KB。
  //    读回来一律走 utils/snapshot.js 的 decodeSnapshot，运行时拿到的还是原来那个扁平数组。
  fs.writeFileSync(existingPath, toModule(encodeSnapshot(all, {
    generatedAt: meta.generatedAt,
    range: metaRange,
  })))
  dropLegacyJson()

  const sizeKB = Math.round(fs.statSync(existingPath).size / 1024)
  console.log(`\n写入 data/matches.js：${all.length} 场 / ${sizeKB} KB`)
  console.log(`抓取范围 ${meta.range.from} ~ ${meta.range.to}（本次更新：${targets.map((c) => c.name).join('、')}）`)
  console.log(report(all))

  const noZh = missingZh(all)
  if (noZh.length) {
    console.log(`  ⚠ ${noZh.length} 支球队没有中文名，小程序会显示英文名。补到 tools/zh-names.js：`)
    noZh.slice(0, 20).forEach((t) => console.log(`      ${t}`))
    if (noZh.length > 20) console.log(`      …还有 ${noZh.length - 20} 支`)
    console.log('')
  }
  if (failed.length) {
    console.log(`  ⚠ 以下赛事本次没抓到新数据：${failed.join('、')}（已保留原有数据，可稍后重试）\n`)
  }
}

// ⚠️ 必须守卫：`tools/live-watch.js` 会 require 本文件拿 COMPETITIONS（赛事表的唯一来源）。
//    不守卫的话 require 一次就跑一遍全量抓取，还会 process.exit(1)。
if (require.main === module) {
  main().catch((err) => {
    console.error(err)
    process.exit(1)
  })
}

// ⚠️ KPL_STATE / KPL_CANCELED 一并导出：match-detail.js 的快通道也要判 KPL 状态，
//    别让两边各写一份语义（第二处实现的老毛病）。
module.exports = { COMPETITIONS, beijingDay, beijingTime, KPL_STATE, KPL_CANCELED }
