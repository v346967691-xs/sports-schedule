/**
 * 赛程快照的紧凑编解码
 *
 * 为什么要有这个文件：`data/matches.js` 是**打进小程序包**的，而主包只有 2MB。
 * 快照占了包体积的一多半，实测 1929 场比赛 745KB（场均 396 字节），其中：
 *   · 球队对象每场重复两份（home / away），合计 319KB —— 但全量只有 525 支不同的队
 *   · `date` / `time` 完全由 `start` 推得（北京时间）
 *   · 字段名、空值、`[]`、`null` 都在白占字节
 * 紧凑格式把重复项抽成共享字典、能推的字段不存、空值不写，实测省一半左右。
 *
 *   {
 *     v: 2,
 *     generatedAt, range,
 *     teams:   { "359": ["阿森纳","Arsenal","ARS","EF0107"] },   // id → [中文名, 英文名, 简称, 颜色(无#)]
 *     matches: { ucl: [ {...短键...} ], epl: [ ... ] }            // 按赛事分组，省掉每条一个 "c"
 *   }
 *
 * ⚠️ 编解码是**同一张字段表**，`encodeSnapshot` 与 `decodeMatch` 必须成对改。
 *    `tools/sync.js` 写、`utils/data.js` 读；smoke 有「编解码往返一致」的断言守着。
 * ⚠️ `decodeSnapshot` 对**旧格式（纯数组）原样返回** —— 云端 `schedule_cache` 里存的
 *    还是老结构（已发布的线上版本在按老结构读，不能动），所以两条路都得走得通。
 */

const V = 2

const STATUS_ENC = { upcoming: 'u', live: 'l', finished: 'f' }
const STATUS_DEC = { u: 'upcoming', l: 'live', f: 'finished' }

const p2 = (n) => String(n).padStart(2, '0')

/**
 * 开赛时刻只存**秒级时间戳**（10 位）而不是 ISO 串（20 位），1929 场省 17KB。
 *
 * ⚠️ 代价是丢了「有没有写秒」这一个写法差异：上游 ESPN 写 `...T13:00Z`、
 *    LoL 写 `...T17:15:00Z`，还原时统一成不带秒的 `...T17:15Z`（秒为 0 时不补）。
 *    两者表示同一时刻，且全项目对 start 的用法只有 `Date.parse` / `new Date()`
 *    （没有任何地方做字符串相等或定长假设），所以这是安全的归一化。
 */
function startToSec(iso) {
  const t = Date.parse(iso)
  return Number.isFinite(t) ? Math.floor(t / 1000) : 0
}

function secToStart(sec) {
  const d = new Date(sec * 1000)
  const base = `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}` +
    `T${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`
  return d.getUTCSeconds() ? `${base}:${p2(d.getUTCSeconds())}Z` : `${base}Z`
}

/** 北京时间（与 tools/sync.js 的 beijingDay / beijingTime 同一口径） */
function beijingParts(sec) {
  const d = new Date(sec * 1000 + 8 * 3600 * 1000)
  return {
    date: `${d.getUTCFullYear()}-${p2(d.getUTCMonth() + 1)}-${p2(d.getUTCDate())}`,
    time: `${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}`,
  }
}

const hex = (c) => String(c || '').replace(/^#/, '')

/**
 * 球队字典的键。
 * 真实的 ESPN 队 id 是纯数字，直接用；
 * 其余（英雄联盟的简码 T1/BLG、待定、淘汰赛占位对阵）**没有真实 id**，
 * 只有名字 —— 而同一支 T1 在 LCK 和 MSI 的兜底颜色不同（各自取赛事主色），
 * 所以这些队必须把颜色并进键里，否则去重会把某个赛事的配色吃掉。
 */
function teamKey(t) {
  const id = String(t.id == null ? '' : t.id)
  return /^[0-9]+$/.test(id) ? id : `${id}|${hex(t.color)}`
}

/* --------------------------------- 编码 --------------------------------- */

function encodeSnapshot(list, extra) {
  const teams = {}
  const byComp = {}

  const encTeam = (t) => {
    if (!t) return null
    const key = teamKey(t)
    if (!Object.prototype.hasOwnProperty.call(teams, key)) {
      teams[key] = [t.zh || '', t.name || '', t.abbr || '', hex(t.color)]
    }
    // 尾部可选段固定为 [比分, 胜, 负]，**按需增长**：
    //   · 既没比分也没战绩 → `[key]`
    //   · 只有比分（足球 / NBA 的绝大多数）→ `[key, score]`，一字节都不多花
    //   · 有战绩（英雄联盟）→ 补齐 4 段，位置不能变，否则解码会把胜场当比分
    // 🔴 加这两段对**已发布的线上版本是安全的**：老解码器只读 ref[1] 拿比分，
    //    多出来的元素会被忽略（见 decTeam）。所以不用升格式版本号 V。
    // ⚠️ 注意别为了「格式统一」把只有比分的场次也补成 4 段 —— 那会因为两串 null
    //    给近千场足球/NBA 各多花 9 字节，白白涨十几 KB 包体积。
    const hasRec = t.wins != null || t.losses != null
    if (t.score == null && !hasRec) return [key]
    if (!hasRec) return [key, t.score]
    return [
      key,
      t.score == null ? null : t.score,
      t.wins == null ? null : t.wins,
      t.losses == null ? null : t.losses,
    ]
  }

  ;(list || []).forEach((m) => {
    const rec = { s: startToSec(m.start), t: STATUS_ENC[m.status] || 'u' }
    const prefix = `${m.comp}-`
    if (String(m.id).indexOf(prefix) === 0) rec.e = String(m.id).slice(prefix.length)
    else rec.i = m.id
    rec.h = encTeam(m.home)
    rec.a = encTeam(m.away)
    if (m.stage) rec.g = m.stage
    if (m.venue) rec.v = m.venue
    if (m.statusText) rec.x = m.statusText
    if (m.bo != null) rec.o = m.bo
    if (m.broadcast && m.broadcast.length) rec.b = m.broadcast
    if (m.slug) rec.l = m.slug
    // KPL 专用：getScheduleDetail 必须同时传 seasonid（scheduleid 可从 id 还原）。
    // ⚠️ 新增可选键对老解码器是安全的（只读自己认识的键），云端老格式里没有它也不影响。
    if (m.seasonid) rec.n = m.seasonid
    if (m.historical) rec.z = 1
    if (!byComp[m.comp]) byComp[m.comp] = []
    byComp[m.comp].push(rec)
  })

  return Object.assign({ v: V }, extra || {}, { teams, matches: byComp })
}

/* --------------------------------- 解码 --------------------------------- */

function decTeam(ref, teams) {
  const key = Array.isArray(ref) ? String(ref[0]) : String(ref || '')
  // ref 尾部是可选段：1=比分、2=胜、3=负。老快照只到 ref[1]，缺的位置取到 undefined → null。
  const slot = (i) => (Array.isArray(ref) && ref[i] != null ? ref[i] : null)
  const score = slot(1)
  const wins = slot(2)
  const losses = slot(3)
  const row = teams[key]
  const id = key.split('|')[0]
  // 字段顺序与 tools/sync.js 的 normTeam 保持一致，方便直接 diff 两边的输出
  if (!row) {
    return { id, name: id, zh: '', abbr: id, color: '#6B7280', score, wins, losses }
  }
  return {
    id,
    name: row[1] || id,
    zh: row[0] || '',
    abbr: row[2] || id,
    color: row[3] ? `#${row[3]}` : '#6B7280',
    score,
    wins,
    losses,
  }
}

function decodeMatch(rec, comp, teams) {
  const { date, time } = beijingParts(rec.s || 0)
  const m = {
    id: rec.i != null ? rec.i : `${comp}-${rec.e}`,
    comp,
    start: secToStart(rec.s || 0),
    date,
    time,
    status: STATUS_DEC[rec.t] || 'upcoming',
    statusText: rec.x || '',
    stage: rec.g || '',
    venue: rec.v || '',
    broadcast: rec.b || [],
    bo: rec.o == null ? null : rec.o,
    home: decTeam(rec.h, teams),
    away: decTeam(rec.a, teams),
  }
  if (rec.l) m.slug = rec.l
  if (rec.n) m.seasonid = rec.n
  if (rec.z) m.historical = true
  return m
}

/**
 * 返回运行时用的扁平数组（按开赛时刻升序）。
 * `finished()` 依赖「升序 + reverse」拿到倒序，所以这里的排序不能省。
 * 传入已经是数组的（云端老格式 / 测试数据）就原样返回。
 */
function decodeSnapshot(raw) {
  if (!raw) return []
  if (Array.isArray(raw)) return raw
  const groups = raw.matches
  if (!groups || typeof groups !== 'object') return []
  const teams = raw.teams || {}
  const out = []
  Object.keys(groups).forEach((comp) => {
    const rows = groups[comp]
    if (!Array.isArray(rows)) return
    rows.forEach((rec) => {
      if (rec && typeof rec === 'object') out.push(decodeMatch(rec, comp, teams))
    })
  })
  out.sort((a, b) => (a.start < b.start ? -1 : a.start > b.start ? 1 : 0))
  return out
}

module.exports = { V, encodeSnapshot, decodeSnapshot, teamKey, startToSec, secToStart, beijingParts }
