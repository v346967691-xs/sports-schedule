/**
 * Worlds 对阵定向刷新（抽签 / 赛程调整）。
 *
 * 抽签把 `TBD–TBD` 换成真实队伍后，全量快照还要等 90 分钟节流闸，用户最多干等一个半小时。
 * 这里每班只花一次官方赛程请求，在**对阵真的变了**时才局部改写 schedule_cache
 * （每 15 分钟一班，不重抓足球 / 网球 / NBA）。
 *
 * 🔴 三条硬约束：
 *   ① **generated_at 必须保持原值** —— 它是 cloud-sync 90 分钟全量节流的唯一依据，
 *      改它等于把主闸一直往后推，其他赛事会越来越陈旧。
 *   ② **内容不变就不写** —— 先比官方签名，再比云端 meta 里记下的签名，两层都没命中才读整表。
 *   ③ **已确认的队伍绝不被回退成 TBD** —— 上游偶发降级时保留原有对阵，不用「缺失」推断取消。
 */

const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')

const WORLD_KEY = 'worlds'
const ID_PREFIX = `${WORLD_KEY}-`
// 官方接口回看 180 天；云端快照只持有最近 14 天 + 未来 45 天，合并时按同一窗口裁剪。
const WINDOW_BACK_MS = 14 * 86400000
const WINDOW_FORWARD_MS = 45 * 86400000

/** 官方与云端两侧一致的「队伍未知」判定。上游用字面量 `TBD`，中文名是「待定」。 */
function isTbd(team) {
  if (!team) return true
  const id = team.id
  return id === undefined || id === null || id === '' || String(id).toUpperCase() === 'TBD'
}

/**
 * 只比较会改变用户所见对阵的字段；颜色、转播、状态文案等装饰性差异不算变化。
 *
 * 🔴 `start` 必须按**时间戳**比，不能比字符串：云端快照走过 `utils/snapshot` 的紧凑编码，
 *    秒为 0 时会归一化成 `...T18:00Z`，而官方接口原样是 `...T18:00:00Z`。
 *    比字符串会把每一场都判成「变了」，等于每班重写一遍整表 —— 实测 44 场全中。
 */
function keyOf(m) {
  if (!m) return ''
  const at = Date.parse(m.start)
  return [
    m.id,
    Number.isFinite(at) ? Math.floor(at / 1000) : m.start,
    m.home && m.home.id,
    m.away && m.away.id,
    m.status,
    m.stage,
    m.bo,
  ].join('|')
}

/** 一组比赛的稳定签名。两侧都用它，用来判断「官方这一版我处理过了没有」。 */
function signature(rows) {
  const items = (rows || []).map(keyOf).sort()
  return crypto.createHash('sha256').update(items.join('\n')).digest('hex').slice(0, 32)
}

function relevant(m, now) {
  const t = Date.parse(m && m.start)
  return Number.isFinite(t) && t >= now - WINDOW_BACK_MS && t <= now + WINDOW_FORWARD_MS
}

/**
 * 取官方 Worlds 赛程（时间窗内）。
 * ⚠️ `fetchLol` 自己会向后再抓 45 天并做全局流兜底，这里只做窗口裁剪，不重复实现。
 */
async function collect(now = Date.now()) {
  const { COMPETITIONS, fetchLol } = require('./sync')
  const comp = COMPETITIONS.find(c => c.key === WORLD_KEY)
  if (!comp) throw Error('COMPETITIONS 里没有 worlds 赛事')
  const rows = await fetchLol(comp)
  return (rows || []).filter(m => relevant(m, now))
}

/** 快照里是否还留着「未来 Worlds 比赛、但双方没定」—— 闲时入口据此保留每班检查。 */
function hasPending(matches, now = Date.now()) {
  return (matches || []).some(m => m && typeof m.id === 'string' && m.id.startsWith(ID_PREFIX)
    && Date.parse(m.start) >= now && (isTbd(m.home) || isTbd(m.away)))
}

function readCache(file) {
  if (!file) return null
  try {
    const value = JSON.parse(fs.readFileSync(file, 'utf8'))
    return value && typeof value.sig === 'string' ? value : null
  } catch (_) {
    return null
  }
}

function writeCache(file, sig, now) {
  if (!file) return
  try {
    fs.mkdirSync(path.dirname(file), { recursive: true })
    fs.writeFileSync(file, JSON.stringify({ sig, at: new Date(now).toISOString() }))
  } catch (_) {
    // 缓存只是性能优化：写不进去最多多读一次云端，不能因此让刷新失败。
  }
}

/**
 * 把官方这一版整行并进云端那一行。
 * 官方说 TBD、云端已有真实队伍时，保留真实队伍 —— 上游降级不能把抽签结果抹掉。
 */
function mergeRow(cloud, official) {
  const keepHome = !isTbd(cloud.home) && isTbd(official.home)
  const keepAway = !isTbd(cloud.away) && isTbd(official.away)
  const merged = { ...cloud, ...official }
  if (keepHome) merged.home = { ...cloud.home }
  if (keepAway) merged.away = { ...cloud.away }
  return merged
}

function isWorldsRow(m) {
  return !!m && typeof m.id === 'string' && m.id.startsWith(ID_PREFIX)
}

/**
 * @param {object} cloud 云客户端
 * @param {{now?:number, cacheFile?:string, dryRun?:boolean}} options
 */
async function refresh(cloud, options = {}) {
  const now = options.now || Date.now()
  const cacheFile = options.cacheFile

  const official = await (options.collect || collect)(now)
  if (!official.length) {
    // 官方没给任何数据：保留线上原样，绝不据此清空对阵。
    return { checked: true, changed: 0, wrote: false, reason: 'no-official-rows' }
  }

  const sig = signature(official)
  const cached = readCache(cacheFile)
  if (cached && cached.sig === sig) {
    return { checked: true, changed: 0, wrote: false, reason: 'unchanged', via: 'cache' }
  }

  // 第二层：只看 meta（约 40KB）就够判断，省掉整表 0.8MB 的读取。
  const metaRead = await cloud.database
    .from('schedule_cache')
    .select('meta')
    .eq('id', 'latest')
    .maybeSingle()
  if (metaRead.error) throw Error('读取 schedule_cache.meta 失败：' + JSON.stringify(metaRead.error).slice(0, 160))
  const cloudMeta = (metaRead.data && metaRead.data.meta) || {}
  if (cloudMeta.worldsSig === sig) {
    writeCache(cacheFile, sig, now)
    return { checked: true, changed: 0, wrote: false, reason: 'unchanged', via: 'meta' }
  }

  const res = await cloud.database
    .from('schedule_cache')
    .select('data, meta, generated_at')
    .eq('id', 'latest')
    .single()
  if (res.error) throw Error('读取 schedule_cache 失败：' + JSON.stringify(res.error).slice(0, 160))
  if (!res.data) throw Error('schedule_cache 无 latest 行')

  const { decodeSnapshot } = require('../utils/snapshot')
  const data = decodeSnapshot(res.data.data)
  if (!Array.isArray(data) || !data.length) throw Error('云端快照为空，拒绝写入（避免清空线上数据）')

  const byId = new Map(official.map(m => [m.id, m]))
  const held = new Set()
  const out = []
  let changed = 0

  for (const m of data) {
    // 非 Worlds 的比赛原样带过 —— 这段是「不碰其他赛事」的唯一保证。
    if (!isWorldsRow(m)) {
      out.push(m)
      continue
    }
    const next = byId.get(m.id)
    if (!next) {
      // 官方这次没返回这场：保留云端原样，绝不用缺失推断「比赛被取消」。
      out.push(m)
      continue
    }
    held.add(m.id)
    const merged = mergeRow(m, next)
    if (keyOf(merged) === keyOf(m)) {
      out.push(m)
      continue
    }
    out.push(merged)
    changed += 1
  }

  // 官方有、云端还没有：只补**还没开打**的场次；历史场次交给全量推送，避免把已裁剪的旧场次灌回来。
  const additions = official
    .filter(m => !held.has(m.id) && Date.parse(m.start) >= now)
    .sort((a, b) => Date.parse(a.start) - Date.parse(b.start))
  if (additions.length) {
    let at = -1
    for (let i = 0; i < out.length; i += 1) if (isWorldsRow(out[i])) at = i
    out.splice(at + 1, 0, ...additions.map(m => ({ ...m })))
    changed += additions.length
  }

  if (!changed) {
    // 签名变了但对阵没变（例如只改了队伍颜色 / 状态文案），不写云端，只记住这一版。
    writeCache(cacheFile, sig, now)
    return { checked: true, changed: 0, wrote: false, reason: 'signature-changed-no-match-diff' }
  }

  if (options.dryRun) {
    return { checked: true, changed, wrote: false, reason: 'dry-run', total: out.length }
  }

  const meta = {
    ...(res.data.meta || cloudMeta),
    worldsSig: sig,
    worldsRefreshedAt: new Date(now).toISOString(),
  }
  const pushed = await cloud.database.from('schedule_cache').upsert({
    id: 'latest',
    data: out,
    meta,
    // 🔴 刻意沿用原值：这是 90 分钟全量节流的依据，局部对阵更新不得冒充全站刚刷新。
    generated_at: res.data.generated_at,
  })
  if (pushed.error) throw Error('写入 schedule_cache 失败：' + JSON.stringify(pushed.error).slice(0, 160))

  writeCache(cacheFile, sig, now)
  return { checked: true, changed, wrote: true, reason: 'worlds-fixtures-updated', total: out.length }
}

module.exports = { refresh, signature, collect, hasPending, relevant, keyOf, isTbd, WORLD_KEY, ID_PREFIX }

if (require.main === module) {
  const cloud = require('@tencent-ai/workbuddy-cloud-sdk').createWorkBuddyCloud(require('../utils/cloud-config'))
  refresh(cloud, { cacheFile: process.env.WORLDS_CACHE, dryRun: process.argv.includes('--dry-run') })
    .then(r => console.log('[worlds-refresh]', JSON.stringify(r)))
    .catch(error => {
      console.error('[worlds-refresh]', error.message)
      process.exitCode = 1
    })
}
