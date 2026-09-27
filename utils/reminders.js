/**
 * 「特别关注 / 开赛提醒」存储
 *
 * 设计取向和「关注球队」一致：**本地优先，云端补位**。
 * 开赛提醒不该被登录门槛挡住 —— 没登录也要能设、能看、能被提醒。
 * 所以本地 storage 永远是主数据源，登录后才和云端 public.match_reminders 做一次合并，
 * 云服务不可用时全程静默降级，不影响使用。
 *
 * 云端表：owner_id TEXT DEFAULT auth.uid() + owner 级 RLS + UNIQUE(owner_id, match_id)，
 * 前端从不上送 owner_id，由数据库自己写入并做隔离。
 *
 * 说明：这里只做「App 内提醒」所需的数据。真正的微信服务通知（订阅消息）需要
 * 微信 openid + access_token + 订阅模板，当前 WorkBuddy 云不提供下發能力，
 * 等能力就绪后可在 dueReminders() 的结果上再叠加一层服务端下发。
 */

const { cloud, isReady, getSession } = require('./cloud')

const TABLE = 'match_reminders'
const STORE_KEY = 'match_reminders_v1'

/** 提醒提前量：开赛前 30 分钟 */
const LEAD_MINUTES = 30

let cache = null

function normalize(row) {
  return {
    matchId: String(row.matchId || row.match_id || ''),
    comp: String(row.comp || ''),
    stage: row.stage || '',
    home: row.home || '',
    away: row.away || '',
    date: row.date || '',
    time: row.time || '',
    startAt: row.startAt || row.start_at || '',
  }
}

function readStore() {
  try {
    const raw = wx.getStorageSync(STORE_KEY)
    const list = Array.isArray(raw) ? raw : []
    return list.map(normalize).filter((r) => r.matchId)
  } catch (err) {
    return []
  }
}

function writeStore(list) {
  cache = list
  try {
    wx.setStorageSync(STORE_KEY, list)
  } catch (err) {
    console.error('[赛程助手] 保存开赛提醒失败', err)
  }
}

/** 当前全部提醒（去重） */
function all() {
  if (!cache) cache = readStore()
  const seen = {}
  return cache.filter((r) => {
    if (seen[r.matchId]) return false
    seen[r.matchId] = true
    return true
  })
}

function has(matchId) {
  const id = String(matchId)
  return all().some((r) => r.matchId === id)
}

/** 用一场比赛对象设定提醒，返回操作后的状态 */
function add(match) {
  const item = normalize({
    matchId: match.id,
    comp: match.comp,
    stage: match.stage || '',
    home: match.home.zhName || match.home.zh || match.home.abbr || match.home.name,
    away: match.away.zhName || match.away.zh || match.away.abbr || match.away.name,
    date: match.date,
    time: match.time,
    startAt: match.start,
  })
  const list = all()
  if (list.some((r) => r.matchId === item.matchId)) {
    return { added: false, already: true, item }
  }
  list.push(item)
  writeStore(list)
  syncPush(item)
  return { added: true, already: false, item }
}

function remove(matchId) {
  const id = String(matchId)
  const list = all().filter((r) => r.matchId !== id)
  writeStore(list)
  syncRemove(id)
  return list
}

/**
 * 到点的提醒：开赛前 LEAD_MINUTES 分钟内、且还没开赛的场次。
 * 用于首页顶部「开赛提醒」卡片 —— 只要时间落在窗口内就会显示，开赛后自动消失，
 * 因此不需要额外的「已提醒过」标记，天然幂等。
 */
function dueReminders(leadMinutes) {
  const now = Date.now()
  const win = (leadMinutes == null ? LEAD_MINUTES : leadMinutes) * 60 * 1000
  return all()
    .map((r) => {
      const ts = r.startAt ? Date.parse(r.startAt) : NaN
      return {
        matchId: r.matchId,
        comp: r.comp,
        stage: r.stage,
        home: r.home,
        away: r.away,
        date: r.date,
        time: r.time,
        startTs: ts,
        inMs: ts - now,
      }
    })
    .filter((r) => Number.isFinite(r.startTs) && r.inMs > 0 && r.inMs <= win)
    .sort((a, b) => a.inMs - b.inMs)
}

/* ------------------------------------------------------------ 云端同步 */

async function sessionOrNull() {
  if (!isReady()) return null
  const { data: session, error } = await getSession()
  if (error || !session) return null
  return session
}

/** 尽力而为：同步失败不影响本地已保存的结果 */
async function syncPush(item) {
  const session = await sessionOrNull()
  if (!session) return
  try {
    await cloud.database.from(TABLE).insert({
      match_id: item.matchId,
      comp: item.comp,
      stage: item.stage,
      home: item.home,
      away: item.away,
      date: item.date,
      time: item.time,
      start_at: item.startAt || null,
    })
  } catch (err) {
    console.warn('[赛程助手] 开赛提醒同步到云端失败', err)
  }
}

async function syncRemove(matchId) {
  const session = await sessionOrNull()
  if (!session) return
  try {
    await cloud.database.from(TABLE).delete().eq('match_id', matchId)
  } catch (err) {
    console.warn('[赛程助手] 取消开赛提醒同步到云端失败', err)
  }
}

/**
 * 登录后把云端和本地做一次并集。
 * 本地有的补推到云端，云端有的（换设备设的）拉回本地，两边谁先谁后都不丢。
 */
async function pullFromCloud() {
  const session = await sessionOrNull()
  if (!session) return { data: all(), error: null, synced: false }

  let rows = []
  try {
    const res = await cloud.database
      .from(TABLE)
      .select('match_id, comp, stage, home, away, date, time, start_at')
      .order('created_at', { ascending: true })
    if (res.error) throw new Error(res.error.message)
    rows = res.data || []
  } catch (err) {
    console.warn('[赛程助手] 读取云端开赛提醒失败', err)
    return { data: all(), error: null, synced: false }
  }

  const list = all()
  const localKeys = {}
  list.forEach((r) => { localKeys[r.matchId] = true })

  // 云端有、本地没有 → 补进本地
  let added = 0
  rows.forEach((row) => {
    const item = normalize(row)
    if (localKeys[item.matchId]) return
    list.push(item)
    localKeys[item.matchId] = true
    added += 1
  })
  if (added) writeStore(list)

  // 本地有、云端没有 → 补推到云端
  const cloudKeys = {}
  rows.forEach((row) => { cloudKeys[normalize(row).matchId] = true })
  const missing = list.filter((r) => !cloudKeys[r.matchId])
  if (missing.length) {
    try {
      await cloud.database.from(TABLE).insert(missing.map((r) => ({
        match_id: r.matchId,
        comp: r.comp,
        stage: r.stage,
        home: r.home,
        away: r.away,
        date: r.date,
        time: r.time,
        start_at: r.startAt || null,
      })))
    } catch (err) {
      console.warn('[赛程助手] 本地开赛提醒补推云端失败', err)
    }
  }

  return { data: all(), error: null, synced: true, added }
}

/** 测试用：重置内存快照 */
function resetCache() {
  cache = null
}

module.exports = {
  LEAD_MINUTES,
  all,
  has,
  add,
  remove,
  dueReminders,
  pullFromCloud,
  resetCache,
}
