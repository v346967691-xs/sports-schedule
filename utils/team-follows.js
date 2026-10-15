/**
 * 「关注球队」存储
 *
 * 设计取向：**本地优先，云端补位**。
 * 关注球队是个性化设置，不该被登录门槛挡住 —— 没登录也要能选、能看。
 * 所以本地 storage 永远是主数据源，登录后才和云端 public.team_follows 做一次合并，
 * 云服务不可用时全程静默降级，不影响使用。
 *
 * 🔴 **关注是「球队维度」的，不是「赛事维度」的**（2026-10-11 改）。
 *    ESPN 的数字 team id 在同一个大类内唯一，而同一支队会跨赛事出场 ——
 *    巴萨在西甲和欧冠都是 `83`。老口径把 `comp:id` 当主键，于是：
 *      · 关注了西甲巴萨，去欧冠版球队页看还是「未关注」；
 *      · 「我的」页拉不到它的欧冠赛程（`data.matchHasTeam` 也要求 comp 相同）。
 *    → 现在**同一支队 = 同大类 + 同 id**（`sameTeam`）。存的时候仍然带上 comp
 *      （卡片要显示赛事名，云端表也有 UNIQUE(owner_id, comp, team_id)），
 *      但判断/删除一律按球队。
 *
 * 云端表：owner_id TEXT DEFAULT auth.uid() + owner 级 RLS + UNIQUE(owner_id, comp, team_id)，
 * 前端从不上送 owner_id，由数据库自己写入并做隔离。
 */

const { cloud, isReady, getSession } = require('./cloud')
// ⚠️ 只为了拿 catOf —— data.js 不 require 本文件，不会成环
const data = require('./data')
const tennisNames = require('./tennis-names')

const TABLE = 'team_follows'
const STORE_KEY = 'team_follows_v1'

/** 内存快照，避免每次都读 storage */
let cache = null

function key(comp, id) {
  return `${comp}:${id}`
}

/**
 * 同一支队的判据：同大类 + 同 id。
 * ⚠️ 必须带大类：不同大类的数字 id 会撞车（NBA 底特律活塞与解放者杯的
 *    Estudiantes de La Plata 都是 `8`），只比 id 会把两队当成一支。
 * 与 `utils/data.js: matchHasTeam` 是同一套口径 —— 改一处要改两处。
 */
function sameTeam(a, b) {
  if (!a || !b) return false
  if (String(a.id || '') !== String(b.id || '')) return false
  if (!a.comp || !b.comp) return a.comp === b.comp
  if (data.catOf(a.comp) === 'tennis' || data.catOf(b.comp) === 'tennis') return a.comp === b.comp
  return a.comp === b.comp || data.catOf(a.comp) === data.catOf(b.comp)
}

/** 球队维度的去重键（`all()` 与云端合并都用它） */
function teamKey(t) {
  if (data.catOf(t.comp) === 'tennis') return `${t.comp}|${String(t.id)}`
  return `${data.catOf(t.comp)}|${String(t.id)}`
}

function normalize(team) {
  const zh = (team.comp === 'atp' || team.comp === 'wta')
    ? tennisNames.nameZh(team.name) || tennisNames.nameZh(team.abbr) || team.zh || ''
    : team.zh || ''
  return {
    comp: String(team.comp || ''),
    id: String(team.id || ''),
    name: team.name || '',
    zh,
    abbr: team.abbr || '',
    color: team.color || '#9CA3AF',
    display: ((team.comp === 'atp' || team.comp === 'wta') && zh) || team.display || zh || team.name || team.abbr || String(team.id || ''),
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

/**
 * 当前关注列表。
 * 🔴 按**球队**去重（不是 `comp:id`）：老版本可能给同一支队存了多条
 *    （西甲 + 欧冠各一条），这里一并折叠掉，页面上不会出现两支「巴萨」。
 */
function all() {
  if (!cache) cache = readStore()
  const seen = {}
  return cache.filter((t) => {
    const k = teamKey(t)
    if (seen[k]) return false
    seen[k] = true
    return true
  })
}

function has(comp, id) {
  return all().some((t) => sameTeam(t, { comp, id }))
}

/** 关注 / 取关，返回操作后的状态。取关会把该队的所有记录（含历史多赛事条目）一起清掉 */
function toggle(team) {
  const t = normalize(team)
  const list = all()
  const doomed = list.filter((x) => sameTeam(x, t))
  if (doomed.length) {
    writeStore(list.filter((x) => !sameTeam(x, t)))
    doomed.forEach((x) => syncRemove(x))
    return { followed: false, team: t }
  }
  list.push(t)
  writeStore(list)
  syncPush(t)
  return { followed: true, team: t }
}

function remove(comp, id) {
  const t = { comp, id: String(id) }
  const list = all()
  const doomed = list.filter((x) => sameTeam(x, t))
  writeStore(list.filter((x) => !sameTeam(x, t)))
  doomed.forEach((x) => syncRemove(x))
  return all()
}

function clear() {
  const list = all()
  writeStore([])
  syncClear()
  return list.length
}

/** 网球补充排名使用稳定的名单 ID，筛选时同时保留选手姓名用于与上游 ID 对齐。 */
function asFilter() {
  return all().map((t) => ({ comp: t.comp, id: t.id, name: t.name, abbr: t.abbr, display: t.display }))
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
  list.forEach((t) => { localKeys[teamKey(t)] = true })

  // 云端有、本地没有 → 补进本地
  // ⚠️ 按**球队**比对，不是 `comp:id`：云端可能留着上一版存下的多条同队记录
  //    （西甲巴萨 + 欧冠巴萨），按 comp:id 比会当成两支不同的队、又补进本地一份。
  let added = 0
  rows.forEach((r) => {
    const k = teamKey({ comp: r.comp, id: r.team_id })
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
  rows.forEach((r) => { cloudKeys[teamKey({ comp: r.comp, id: r.team_id })] = true })
  const missing = list.filter((t) => !cloudKeys[teamKey(t)])
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
  teamKey,
  sameTeam,
  all,
  has,
  toggle,
  remove,
  clear,
  asFilter,
  pullFromCloud,
  resetCache,
}
