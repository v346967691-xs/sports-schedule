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

const META_FALLBACK = { generatedAt: '', range: { from: '', to: '' }, categories: [], competitions: [] }

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

function matches() {
  if (!cache) {
    try {
      cache = require('../data/matches.js')
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

/** 把云端快照替换进内存（仅在云端比本地包更新时调用） */
function applyCloudSnapshot(snapData, snapMeta) {
  cache = snapData
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

async function doRefresh() {
  try {
    const { data, error } = await cloudClient.cloud.database
      .from('schedule_cache')
      .select('data, meta, generated_at')
      .eq('id', 'latest')
      .maybeSingle()
    if (error || !data || !Array.isArray(data.data) || !data.meta) {
      return { updated: false, reason: 'invalid', source: dataSource }
    }
    const cloudTime = data.meta.generatedAt ? Date.parse(data.meta.generatedAt) : 0
    const bundleTime = meta.generatedAt ? Date.parse(meta.generatedAt) : 0
    if (cloudTime <= bundleTime) {
      return { updated: false, reason: 'not-newer', source: dataSource }
    }
    applyCloudSnapshot(data.data, data.meta)
    return { updated: true, source: 'cloud', generatedAt: data.meta.generatedAt }
  } catch (err) {
    console.warn('[赛程助手] 云端赛程读取失败，沿用本地数据', err)
    return { updated: false, reason: 'error', source: dataSource }
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
  refresh,
  source,
  generatedAt,
  staleInfo,
}
