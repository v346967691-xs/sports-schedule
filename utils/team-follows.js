/**
 * 「关注球队」存储
 *
 * 设计取向：**本地优先，云端补位**。
 * 关注球队是个性化设置，不该被登录门槛挡住 —— 没登录也要能选、能看。
 * 所以本地 storage 永远是主数据源，登录后才和云端 public.team_follows 做一次合并，
 * 云服务不可用时全程静默降级，不影响使用。
 *
 * 云端表：owner_id TEXT DEFAULT auth.uid() + owner 级 RLS + UNIQUE(owner_id, comp, team_id)，
 * 前端从不上送 owner_id，由数据库自己写入并做隔离。
 */

const { cloud, isReady, getSession } = require('./cloud')

const TABLE = 'team_follows'
const STORE_KEY = 'team_follows_v1'

/** 内存快照，避免每次都读 storage */
let cache = null

function key(comp, id) {
  return `${comp}:${id}`
}

function normalize(team) {
  return {
    comp: String(team.comp || ''),
    id: String(team.id || ''),
    name: team.name || '',
    zh: team.zh || '',
    abbr: team.abbr || '',
    color: team.color || '#9CA3AF',
    display: team.display || team.zh || team.name || team.abbr || String(team.id || ''),
  }
}

function readStore() {
  try {
    const raw = wx.getStorageSync(STORE_KEY)
    const list = Array.isArray(raw) ? raw : []
    return list.map(normalize).filter((t) => t.comp && t.id)
  } catch (err) {
    return []
  }
}

function writeStore(list) {
  cache = list
  try {
    wx.setStorageSync(STORE_KEY, list)
  } catch (err) {
    console.error('[赛程助手] 保存关注球队失败', err)
  }
}

/** 当前关注列表（去重） */
function all() {
  if (!cache) cache = readStore()
  const seen = {}
  return cache.filter((t) => {
    const k = key(t.comp, t.id)
    if (seen[k]) return false
    seen[k] = true
    return true
  })
}

function has(comp, id) {
  const k = key(comp, id)
  return all().some((t) => key(t.comp, t.id) === k)
}

/** 关注 / 取关，返回操作后的状态 */
function toggle(team) {
  const t = normalize(team)
  const k = key(t.comp, t.id)
  const list = all()
  const idx = list.findIndex((x) => key(x.comp, x.id) === k)
  if (idx > -1) {
    list.splice(idx, 1)
    writeStore(list)
    syncRemove(t)
    return { followed: false, team: t }
  }
  list.push(t)
  writeStore(list)
  syncPush(t)
  return { followed: true, team: t }
}

function remove(comp, id) {
  const list = all().filter((x) => !(x.comp === comp && String(x.id) === String(id)))
  writeStore(list)
  syncRemove({ comp, id })
  return list
}

function clear() {
  const list = all()
  writeStore([])
  syncClear()
  return list.length
}

/** 给 data.query 用的 [{ comp, id }] */
function asFilter() {
  return all().map((t) => ({ comp: t.comp, id: t.id }))
}

/* ------------------------------------------------------------ 云端同步 */

async function sessionOrNull() {
  if (!isReady()) return null
  const { data: session, error } = await getSession()
  if (error || !session) return null
  return session
}

/** 尽力而为：同步失败不影响本地已保存的结果 */
async function syncPush(team) {
  const session = await sessionOrNull()
  if (!session) return
  try {
    await cloud.database.from(TABLE).insert({
      comp: team.comp,
      team_id: team.id,
      team_name: team.zh || team.name,
      team_abbr: team.abbr,
    })
  } catch (err) {
    console.warn('[赛程助手] 关注球队同步到云端失败', err)
  }
}

async function syncRemove(team) {
  const session = await sessionOrNull()
  if (!session) return
  try {
    await cloud.database.from(TABLE)
      .delete()
      .eq('comp', team.comp)
      .eq('team_id', String(team.id))
  } catch (err) {
    console.warn('[赛程助手] 取消关注同步到云端失败', err)
  }
}

async function syncClear() {
  const session = await sessionOrNull()
  if (!session) return
  try {
    await cloud.database.from(TABLE).delete().neq('comp', '')
  } catch (err) {
    console.warn('[赛程助手] 清空关注同步到云端失败', err)
  }
}

/**
 * 登录后把云端和本地做一次并集。
 * 本地有的补推到云端，云端有的（换设备关注的）拉回本地，两边谁先谁后都不丢。
 */
async function pullFromCloud() {
  const session = await sessionOrNull()
  if (!session) return { data: all(), error: null, synced: false }

  let rows = []
  try {
    const res = await cloud.database
      .from(TABLE)
      .select('comp, team_id, team_name, team_abbr')
      .order('created_at', { ascending: true })
    if (res.error) throw new Error(res.error.message)
    rows = res.data || []
  } catch (err) {
    console.warn('[赛程助手] 读取云端关注球队失败', err)
    return { data: all(), error: null, synced: false }
  }

  const list = all()
  const localKeys = {}
  list.forEach((t) => { localKeys[key(t.comp, t.id)] = true })

  // 云端有、本地没有 → 补进本地
  let added = 0
  rows.forEach((r) => {
    const k = key(r.comp, r.team_id)
    if (localKeys[k]) return
    list.push(normalize({
      comp: r.comp,
      id: r.team_id,
      zh: r.team_name,
      name: r.team_name,
      abbr: r.team_abbr,
    }))
    localKeys[k] = true
    added += 1
  })
  if (added) writeStore(list)

  // 本地有、云端没有 → 补推到云端
  const cloudKeys = {}
  rows.forEach((r) => { cloudKeys[key(r.comp, r.team_id)] = true })
  const missing = list.filter((t) => !cloudKeys[key(t.comp, t.id)])
  if (missing.length) {
    try {
      await cloud.database.from(TABLE).insert(missing.map((t) => ({
        comp: t.comp,
        team_id: t.id,
        team_name: t.zh || t.name,
        team_abbr: t.abbr,
      })))
    } catch (err) {
      console.warn('[赛程助手] 本地关注补推云端失败', err)
    }
  }

  return { data: all(), error: null, synced: true, added }
}

/** 测试用：重置内存快照 */
function resetCache() {
  cache = null
}

module.exports = {
  key,
  all,
  has,
  toggle,
  remove,
  clear,
  asFilter,
  pullFromCloud,
  resetCache,
}
