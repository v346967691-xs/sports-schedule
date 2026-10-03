/**
 * 赛程数据源
 *
 * data/matches.js / data/meta.js 由 `node tools/sync.js` 生成，随小程序一起打包，
 * 运行时不发网络请求 —— 小程序 request 域名白名单不允许直接访问第三方体育站点。
 *
 * 注意：数据刻意存成 JS 模块（module.exports）而不是 .json。
 * 小程序原生的 require 并不保证能加载独立的 .json 文件，一旦加载失败会在页面模块
 * 加载阶段就抛错、整页白屏。这里再包一层 try/catch，保证数据出问题也只是列表为空，
 * 不会再把整个小程序拖白。
 */

const snapshot = require('./snapshot')

const META_FALLBACK = { generatedAt: '', range: { from: '', to: '' }, categories: [], competitions: [] }

/* 积分榜：同样是「本地包兜底 + 打开即读云端」。
   文件缺失时整个数值就是一个空表，页面会显示「暂无积分榜」，不会白屏。 */
const STANDINGS_FALLBACK = { generatedAt: '', tables: {} }

/* 射手榜 / 助攻榜：与积分榜同一个套路（本地包兜底 + 云端覆盖）。
   ⚠️ 它和积分榜是**两张独立的表**，各有各的赛事覆盖面：
     有积分榜的赛事不一定有射手榜（欧协联就没有），反之亦然（欧国联有榜没榜）。
      所以页面上「积分榜 / 射手榜 / 助攻榜」三档各自判断可用性，别互相推导。 */
const SCORERS_FALLBACK = { generatedAt: '', tables: {} }

let standingsData = (() => {
  try {
    return require('../data/standings.js')
  } catch (err) {
    console.error('[赛程助手] 积分榜数据加载失败', err)
    return STANDINGS_FALLBACK
  }
})()

let scorersData = (() => {
  try {
    return require('../data/scorers.js')
  } catch (err) {
    console.error('[赛程助手] 射手榜数据加载失败', err)
    return SCORERS_FALLBACK
  }
})()

let meta = (() => {
  try {
    return require('../data/meta.js')
  } catch (err) {
    console.error('[赛程助手] meta 数据加载失败', err)
    return META_FALLBACK
  }
})()

let cache = null

/* 云端赛程缓存：打开即读，无需重新发布即可看到最新比分（每小时由定时任务刷新云端） */
const cloudClient = require('./cloud')
const THROTTLE_MS = 5 * 60 * 1000 // 同一端最多每 5 分钟才请求一次云端，避免频繁打接口
let lastRefreshAt = 0
let inflight = null // 并发刷新共享同一个请求，避免 onLaunch 与 onShow 重复打接口
let dataSource = 'bundle' // 'bundle' 本地兜底包 | 'cloud' 云端快照

/**
 * ⚠️ data/matches.js 存的是**紧凑格式**（球队共享字典 + 短键名），
 *    直接读会拿到 `{v, teams, matches}` 而不是比赛数组 —— 必须过 decodeSnapshot。
 *    解码结果缓存在 cache 里，只在第一次读的时候解一次。
 *    （云端 schedule_cache 里还是老格式的扁平数组，decodeSnapshot 会原样返回。）
 */
function matches() {
  if (!cache) {
    try {
      // eslint-disable-next-line
      cache = snapshot.decodeSnapshot(require('../data/matches.js'))
    } catch (err) {
      console.error('[赛程助手] 赛程数据加载失败', err)
      cache = []
    }
  }
  return cache
}

function categories() {
  return meta.categories
}

function competitions() {
  return meta.competitions
}

function compMap() {
  const map = {}
  meta.competitions.forEach((c) => { map[c.key] = c })
  return map
}

function compOf(key) {
  const c = compMap()[key]
  return c || { key, name: key, full: key, cat: 'football', accent: '#6B7280' }
}

function findMatch(id) {
  return matches().find((m) => m.id === id) || null
}

/**
 * 按条件筛选
 * @param {Object} opt
 * @param {string[]} opt.comps   赛事 key 列表，空数组表示全部
 * @param {string}   opt.cat     大类 key（football / basketball / esports），为空表示全部
 * @param {string}   opt.status  upcoming | live | finished，为空表示全部
 * @param {string}   opt.from    起始日期（含）
 * @param {string}   opt.to      结束日期（含）
 * @param {string}   opt.date    单一日期
 * @param {Object}   opt.team    { comp, id } 只看该队
 * @param {Object[]} opt.teams   [{ comp, id }] 命中任意一支即可
 */
function query(opt) {
  const o = opt || {}
  const comps = (o.comps && o.comps.length ? o.comps : null)
  const catComp = o.cat ? (categories().find((c) => c.key === o.cat) || {}).competitions : null
  const teams = (o.teams && o.teams.length ? o.teams : null)
  return matches().filter((m) => {
    if (comps && comps.indexOf(m.comp) === -1) return false
    if (catComp && catComp.indexOf(m.comp) === -1) return false
    if (o.status) {
      const ss = Array.isArray(o.status) ? o.status : [o.status]
      if (ss.indexOf(m.status) === -1) return false
    }
    if (o.date && m.date !== o.date) return false
    if (o.from && m.date < o.from) return false
    if (o.to && m.date > o.to) return false
    if (o.team && !matchHasTeam(m, o.team)) return false
    if (teams && !teams.some((t) => matchHasTeam(m, t))) return false
    return true
  })
}

/** 这场比赛里有没有这支球队（足球 id 是数字串、电竞是英文码，统一按字符串比） */
function matchHasTeam(m, team) {
  if (!team || m.comp !== team.comp) return false
  const id = String(team.id)
  return String(m.home.id) === id || String(m.away.id) === id
}

/** 中文排序，localeCompare 不可用时回落到普通比较 */
function zhCompare(a, b) {
  try {
    return String(a).localeCompare(String(b), 'zh-Hans-CN')
  } catch (err) {
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
  }
}

/**
 * 某个赛事里出现过的全部球队（去重，按中文名排序）。
 * 球队不单独维护名单 —— 直接从赛程里抽，赛事扩面后自动跟着涨，
 * 也不用担心名单和赛程对不上。
 * @param {string} compKey
 */
function teamsOf(compKey) {
  const seen = {}
  const out = []
  matches().forEach((m) => {
    if (m.comp !== compKey) return
    ;[m.home, m.away].forEach((t) => {
      if (!t || !t.id) return
      const id = String(t.id)
      // 未确定的对阵（"待定"）不是一支真球队，不该出现在可关注列表里
      if (id === 'TBD' || t.name === '待定') return
      if (seen[id]) return
      seen[id] = true
      out.push({
        comp: compKey,
        id,
        name: t.name || '',
        zh: t.zh || '',
        abbr: t.abbr || '',
        color: t.color || '#9CA3AF',
        display: t.zh || t.name || t.abbr || id,
      })
    })
  })
  return out.sort((a, b) => zhCompare(a.display, b.display))
}

/** 未来赛程：从今天起，按时间升序 */
function upcoming(opt) {
  const today = require('./format').todayStr()
  // 进行中的比赛（live）也归入「即将开赛」一栏：赛程页只有「即将开赛 / 已结束」两个标签，
  // 若把 live 排除在外，正在进行的比赛会在两个标签里都消失，造成「比赛凭空不见」。
  const status = (opt && opt.status) ? [opt.status] : ['upcoming', 'live']
  return query(Object.assign({}, opt, { from: today, status }))
}

/** 已结束的比赛，按时间倒序 */
function finished(opt) {
  return query(Object.assign({}, opt, { status: 'finished' })).slice().reverse()
}

/**
 * 最近 hours 小时内已结束的比赛，按开赛时间倒序（最新在前）。
 *
 * 用于「关注球队的赛果」：只列未来赛程的话，用户刚看完的那场比赛反而找不到，
 * 而那恰恰是他最想回来看一眼的。
 *
 * ⚠️ 用开赛时刻近似结束时刻 —— 数据里只有开赛时间，没有终场时间。
 * 24 小时窗口按开赛算：够把「昨晚那场」捞出来，也不会翻出三天前的旧账。
 *
 * @param {Object} opt 同 query（一般传 teams 筛选）
 * @param {number} [hours=24]
 */
function recentFinished(opt, hours) {
  const h = Number(hours) || 24
  const since = Date.now() - h * 3600000
  return query(Object.assign({}, opt, { status: 'finished' }))
    .filter((m) => {
      const t = Date.parse(m.start)
      return Number.isFinite(t) && t >= since
    })
    .slice()
    .reverse()
}

/** 赛事的所有比赛日期（升序去重） */
function datesOf(list) {
  const set = []
  list.forEach((m) => { if (set.indexOf(m.date) === -1) set.push(m.date) })
  return set.sort()
}

/** 每个赛事未来最近一场，用于首页赛事入口 */
function nextMatchByComp() {
  const today = require('./format').todayStr()
  const out = {}
  matches().forEach((m) => {
    if (m.status === 'finished') return
    if (today && m.date < today) return
    if (!out[m.comp] || m.date < out[m.comp].date || (m.date === out[m.comp].date && m.time < out[m.comp].time)) out[m.comp] = m
  })
  return out
}

/** 每个赛事最近结束的一场，赛季间歇时用于兜底展示 */
function lastMatchByComp() {
  const out = {}
  matches().forEach((m) => {
    if (m.status !== 'finished') return
    if (!out[m.comp] || m.date > out[m.comp].date || (m.date === out[m.comp].date && m.time > out[m.comp].time)) out[m.comp] = m
  })
  return out
}

/* ------------------------------------------------------------------ 积分榜 */

/** 全部积分榜：{ [compKey]: table } */
function standingsTables() {
  return (standingsData && standingsData.tables) || {}
}

/** 某个赛事的积分榜；没有则返回 null（杯赛、国字号本来就没有排名） */
function standingsOf(compKey) {
  return standingsTables()[compKey] || null
}

/** 哪些赛事有积分榜（按 SPORT_CATS 的展示顺序输出，用于页面切换） */
function standingsKeys() {
  const has = standingsTables()
  const order = []
  categories().forEach((cat) => {
    cat.competitions.forEach((key) => { if (has[key]) order.push(key) })
  })
  return order
}

/**
 * 当前生效的积分榜生成时间（云端优先，回落本地包）。
 * 与赛程的生成时间是两个独立的值，不要混用。
 */
function standingsGeneratedAt() {
  return (standingsData && standingsData.generatedAt) || ''
}

/** 某支球队在积分榜里的那一行 */
function teamStanding(compKey, teamId) {
  const table = standingsOf(compKey)
  if (!table) return null
  const id = String(teamId)
  for (const g of table.groups || []) {
    const hit = (g.rows || []).find((r) => String(r.id) === id)
    if (hit) return Object.assign({ group: g.name || '' }, hit)
  }
  return null
}

/* -------------------------------------------------------- 射手榜 / 助攻榜 */

/** 全部射手榜：{ [compKey]: { season, players[] } } */
function scorersTables() {
  return (scorersData && scorersData.tables) || {}
}

/** 某个赛事的射手榜/助攻榜数据；没有则返回 null（上游不提供这两个榜） */
function scorersOf(compKey) {
  return scorersTables()[compKey] || null
}

/** 哪些赛事有射手榜（按 SPORT_CATS 的展示顺序输出，用于页面切换） */
function scorersKeys() {
  const has = scorersTables()
  const order = []
  categories().forEach((cat) => {
    cat.competitions.forEach((key) => { if (has[key]) order.push(key) })
  })
  return order
}

/** 当前生效的射手榜生成时间（云端优先，回落本地包） */
function scorersGeneratedAt() {
  return (scorersData && scorersData.generatedAt) || ''
}

/**
 * 某个赛事的射手榜 / 助攻榜前 N 名。
 *
 * ⚠️ 数据里**只存一份球员列表**（进球榜 ∪ 助攻榜去重后的并集），
 *    排序是页面按需现算的 —— 所以这里必须自己排，不要指望数据已经是排好的。
 *    并列时用进球数兜底，保证顺序稳定、不会每次渲染都跳。
 *
 * @param {string} compKey
 * @param {'goals'|'assists'} kind
 * @param {number} [n=20]
 */
function scorersTop(compKey, kind, n) {
  const table = scorersOf(compKey)
  if (!table || !Array.isArray(table.players)) return []
  const key = kind === 'assists' ? 'a' : 'g'
  const other = kind === 'assists' ? 'g' : 'a'
  const take = Number(n) || 20
  return table.players
    // 那一项没有数据的人不进这个榜（例如只上了助攻榜、进球数缺失的球员）
    .filter((p) => p && p[key] != null && p[key] > 0)
    .slice()
    .sort((x, y) => (y[key] - x[key]) || ((y[other] || 0) - (x[other] || 0)) || String(x.i).localeCompare(String(y.i)))
    .slice(0, take)
    .map((p, i) => ({
      pos: i + 1,
      id: p.i,
      // 中文名优先，未收录回落英文短名 —— 中英混排是预期内的正常状态
      name: p.z || p.s || '',
      en: p.s || '',
      hasZh: !!p.z,
      team: p.tz || '',
      teamId: p.t || '',
      value: p[key],
      other: p[other] || 0,
      played: p.p == null ? '' : String(p.p),
      jersey: p.j || 0,
    }))
}

/**
 * 某支球队的近期战绩（W/D/L），按时间倒序。
 *
 * ⚠️ 只在本地快照（含云端刷新后的那一份）里算 —— 快照是 ±窗口内的比赛，
 * 所以它表示的是「近期状态」而不是赛季总战绩，页面文案也按这个口径写。
 * 赛季总战绩请以积分榜为准（那份来自官方 / 整赛季自算）。
 */
function teamForm(compKey, teamId, n) {
  const take = Number(n) || 5
  const list = query({ comps: [compKey], status: 'finished', team: { comp: compKey, id: teamId } })
    .slice()
    .reverse()
  return list.slice(0, take).map((m) => {
    const isHome = String(m.home.id) === String(teamId)
    const mine = isHome ? m.home.score : m.away.score
    const theirs = isHome ? m.away.score : m.home.score
    let result = 'U'
    if (typeof mine === 'number' && typeof theirs === 'number') {
      result = mine > theirs ? 'W' : mine < theirs ? 'L' : 'D'
    }
    return {
      result,
      scoreText: typeof mine === 'number' && typeof theirs === 'number' ? `${mine}-${theirs}` : '',
      opponent: isHome ? (m.away.zh || m.away.name) : (m.home.zh || m.home.name),
      isHome,
      date: m.date,
      match: m,
    }
  })
}

/** 某支球队的即将 / 进行中比赛（球队详情页用） */
function teamUpcoming(compKey, teamId, n) {
  const today = require('./format').todayStr()
  const take = Number(n) || 10
  return query({ comps: [compKey], status: ['upcoming', 'live'], team: { comp: compKey, id: teamId } })
    .filter((m) => !today || m.date >= today)
    .slice(0, take)
}

/* ------------------------------------------------------------------ 云端刷新 */

/** 当前数据来源 */
function source() {
  return dataSource
}

/** 当前生效的数据生成时间（云端优先，回落本地包） */
function generatedAt() {
  return dataSource === 'cloud' && meta.generatedAt ? meta.generatedAt : meta.generatedAt || ''
}

/* 为什么是 3 小时：
   GitHub 的定时任务是「尽力而为」，实测实际频率约每 2.5~3 小时一次（并非设定的 15 分钟），
   你关机时更是只能靠它。若阈值仍按 90 分钟算，这条警示就会长期挂在页面上，
   既不准确，也会让用户看麻木、真出问题时反而不当回事。
   所以阈值对齐真实刷新粒度：超过 3 小时没更新，才说明定时任务真的挂了 —— 这时必须明说，
   别让用户误以为看到的是最新结果。 */
const STALE_MS = 180 * 60 * 1000

/**
 * 数据是否陈旧
 * @returns {{stale:boolean, minutes:number}} minutes = 距生成时间过去了多少分钟
 */
function staleInfo() {
  const t = Date.parse(generatedAt() || '')
  if (!t) return { stale: false, minutes: 0 }
  const diff = Date.now() - t
  if (diff < 0) return { stale: false, minutes: 0 }
  return { stale: diff > STALE_MS, minutes: Math.round(diff / 60000) }
}

/**
 * 把云端快照替换进内存（仅在云端比本地包更新时调用）。
 * ⚠️ 传进来的 `snapData` 必须先过 decodeSnapshot —— 云端推的是老格式的扁平数组，
 *    但以后若改推紧凑格式，这里不该再改一次。
 */
function applyCloudSnapshot(snapList, snapMeta) {
  cache = snapList
  meta = snapMeta
  dataSource = 'cloud'
}

/**
 * 打开即读云端：拉取 schedule_cache(id='latest')，若比本地包更新则替换内存数据。
 * 失败（无网络 / 云服务未就绪 / 云端更旧 / 形状非法）一律回落本地包，绝不抛错。
 * 节流 5 分钟：同一端的多次 onShow 不会反复请求云端。
 * @returns {Promise<{updated:boolean, reason?:string, source:string}>}
 */
async function refresh() {
  if (!cloudClient.isReady()) return { updated: false, reason: 'no-cloud', source: dataSource }
  const now = Date.now()
  // 已在刷新中：多个入口（onLaunch / onShow）共享同一次请求
  if (inflight) return inflight
  if (now - lastRefreshAt < THROTTLE_MS) return { updated: false, reason: 'throttled', source: dataSource }
  lastRefreshAt = now
  inflight = doRefresh().finally(() => { inflight = null })
  return inflight
}

/**
 * 积分榜同样打开即读云端。失败 / 云端更旧都沿用本地包，绝不抛错。
 * 与赛程共用一次 refresh 的节流窗口，不额外增加请求压力。
 */
async function refreshStandings() {
  if (!cloudClient.isReady()) return false
  try {
    const { data, error } = await cloudClient.cloud.database
      .from('standings_cache')
      .select('data, generated_at')
      .eq('id', 'latest')
      .maybeSingle()
    if (error || !data || !data.data || !data.data.tables) return false
    const cloudTime = data.data.generatedAt ? Date.parse(data.data.generatedAt) : 0
    const bundleTime = standingsData.generatedAt ? Date.parse(standingsData.generatedAt) : 0
    if (cloudTime <= bundleTime) return false
    standingsData = data.data
    return true
  } catch (err) {
    console.warn('[赛程助手] 云端积分榜读取失败，沿用本地数据', err)
    return false
  }
}

/**
 * 射手榜同样打开即读云端。失败 / 云端更旧都沿用本地包，绝不抛错。
 * 与赛程共用一次 refresh 的节流窗口，不额外增加请求压力。
 */
async function refreshScorers() {
  if (!cloudClient.isReady()) return false
  try {
    const { data, error } = await cloudClient.cloud.database
      .from('scorers_cache')
      .select('data, generated_at')
      .eq('id', 'latest')
      .maybeSingle()
    if (error || !data || !data.data || !data.data.tables) return false
    const cloudTime = data.data.generatedAt ? Date.parse(data.data.generatedAt) : 0
    const bundleTime = scorersData.generatedAt ? Date.parse(scorersData.generatedAt) : 0
    if (cloudTime <= bundleTime) return false
    scorersData = data.data
    return true
  } catch (err) {
    console.warn('[赛程助手] 云端射手榜读取失败，沿用本地数据', err)
    return false
  }
}

/**
 * 北京时间（UTC+8）下的 YYYYMMDD —— 与 tools/match-detail.js 归档口径必须一致，
 * 两边算法不同会导致「明明抓到了，页面却读不到」。
 */
function dayStampCN(iso) {
  const d = new Date(new Date(iso).getTime() + 8 * 3600 * 1000)
  return `${d.getUTCFullYear()}${String(d.getUTCMonth() + 1).padStart(2, '0')}${String(d.getUTCDate()).padStart(2, '0')}`
}

/**
 * 比赛详情（事件时间轴 / 双方近况 / 历史交锋 / 技术统计）。
 *
 * 云端按天分桶存（id = 'd-YYYYMMDD'），这里一次只读 1 行，避免把整表拖下来。
 * ⚠️ 读不到就返回 null，详情页据此把模块整个藏掉 —— 详情是增强内容，
 *    没有它页面照样要能用，绝不能因为拿不到就报错或留白块。
 */
async function matchDetail(match) {
  if (!match || !match.start || !cloudClient.isReady()) return null
  try {
    const { data, error } = await cloudClient.cloud.database
      .from('match_detail')
      .select('payload')
      .eq('id', `d-${dayStampCN(match.start)}`)
      .maybeSingle()
    if (error || !data || !data.payload) return null
    return data.payload[match.id] || null
  } catch (err) {
    console.warn('[赛程助手] 云端比赛详情读取失败', err)
    return null
  }
}

/**
 * 球队名单（含球员档案：位置 / 球衣号 / 年龄 / 国籍 / 身高体重）。
 *
 * 🔴 这份数据**不进代码包**，只在云端（`team_roster` 表，由 `tools/team-roster.js` 推送）。
 *    一支队 27 人 × 几百支球队打进包要 500KB+，包体积红线扛不住。
 *
 * ⚠️ 必须带缓存：球队页的 `onShow` 每次都会 render，没有缓存的话
 *    每次回前台就发一次请求，等于把名单当比分刷。
 *  · 命中缓存直接返回（10 分钟内）
 *  · 同一个 key 的并发请求合并成一个 Promise（onShow 与 render 会同时触发）
 *  · 读不到返回 null，页面据此把整块藏掉 —— 名单是增强内容，没有它页面照样能用
 */
const ROSTER_TTL = 10 * 60 * 1000
const rosterCache = {}
const rosterPending = {}

async function teamRoster(comp, teamId) {
  if (!comp || !teamId || !cloudClient.isReady()) return null
  const key = `${comp}:${teamId}`
  const hit = rosterCache[key]
  if (hit && Date.now() - hit.t < ROSTER_TTL) return hit.v
  if (rosterPending[key]) return rosterPending[key]
  rosterPending[key] = (async () => {
    try {
      const { data, error } = await cloudClient.cloud.database
        .from('team_roster')
        .select('payload')
        .eq('id', key)
        .maybeSingle()
      if (error || !data || !data.payload) return null
      rosterCache[key] = { t: Date.now(), v: data.payload }
      return data.payload
    } catch (err) {
      console.warn('[赛程助手] 云端球队名单读取失败', err)
      return null
    } finally {
      delete rosterPending[key]
    }
  })()
  return rosterPending[key]
}

/**
 * 单个球员档案。球员详情页要它，但**不值得为它再打一张表** ——
 * 名单里已经带了全部档案字段，按 athlete id 从所属队的名单里捞一行即可。
 * ⚠️ 捞不到返回 null（比如这名球员不在当前名册里，或名单还没抓）。
 */
async function playerProfile(comp, teamId, athleteId) {
  const roster = await teamRoster(comp, teamId)
  if (!roster || !roster.players) return null
  const id = String(athleteId)
  const row = roster.players.find((p) => String(p.i) === id)
  if (!row) return null
  return { player: row, team: roster.team, coach: roster.coach, season: roster.season }
}

async function doRefresh() {
  try {
    // 并行拉三张表：它们互不依赖，串行只会白白多等两个 RTT
    const [main] = await Promise.all([refreshSchedule(), refreshStandings(), refreshScorers()])

    // decodeSnapshot 同时吃「扁平数组」和「紧凑对象」，云端换格式时这里不用改
    const list = snapshot.decodeSnapshot(main.data && main.data.data)
    if (main.error || !main.data || !list.length || !main.data.meta) {
      return { updated: false, reason: 'invalid', source: dataSource }
    }
    const cloudTime = main.data.meta.generatedAt ? Date.parse(main.data.meta.generatedAt) : 0
    const bundleTime = meta.generatedAt ? Date.parse(meta.generatedAt) : 0
    if (cloudTime <= bundleTime) {
      return { updated: false, reason: 'not-newer', source: dataSource }
    }
    applyCloudSnapshot(list, main.data.meta)
    return { updated: true, source: 'cloud', generatedAt: main.data.meta.generatedAt }
  } catch (err) {
    console.warn('[赛程助手] 云端赛程读取失败，沿用本地数据', err)
    return { updated: false, reason: 'error', source: dataSource }
  }
}

/** 拉取云端赛程表；任何异常都在内部兜住（返回 error 而不是抛） */
async function refreshSchedule() {
  try {
    return await cloudClient.cloud.database
      .from('schedule_cache')
      .select('data, meta, generated_at')
      .eq('id', 'latest')
      .maybeSingle()
  } catch (err) {
    console.warn('[赛程助手] 云端赛程请求异常', err)
    return { error: err, data: null }
  }
}

module.exports = {
  // 用 getter 暴露 meta：refresh() 换成云端 meta 后，外部读到的也是最新一份
  get meta() { return meta },
  matches,
  categories,
  competitions,
  compMap,
  compOf,
  findMatch,
  query,
  matchHasTeam,
  teamsOf,
  upcoming,
  finished,
  recentFinished,
  datesOf,
  nextMatchByComp,
  lastMatchByComp,
  // 积分榜
  standingsTables,
  standingsOf,
  standingsKeys,
  standingsGeneratedAt,
  teamStanding,
  teamForm,
  teamUpcoming,
  // 射手榜 / 助攻榜
  scorersTables,
  scorersOf,
  scorersKeys,
  scorersGeneratedAt,
  scorersTop,
  matchDetail,
  teamRoster,
  playerProfile,
  refresh,
  source,
  generatedAt,
  staleInfo,
}
