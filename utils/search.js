/**
 * 全站搜索：球队 + 赛事（**纯本地内存索引，零后端、零网络**）
 *
 * 为什么不复用「关注球队」页那个输入框：
 *   关注页的搜索**只在当前分类内**过滤，而且只覆盖 SELECTABLE 里那些「适合关注」的赛事
 *   （欧战/世界赛都被排除了）。但用户想找的经常正是分类外的东西 ——
 *   欧冠的拜仁、亚冠的利雅得新月，甚至赛事本身（"英超"）。
 *   所以这里建一份**全量**索引：26 个赛事、597 条球队行去重后约 480 支 + 26 个赛事。
 *
 * ⚠️ 这是页面层（`utils/` 与 `pages/` 同属页面层）：改完**必须发版**才生效，
 *    不像 data/ 那样推云端就能更新。
 *
 * 索引有四条约定，改动前先读：
 *
 *  ① **按「大类 + id」去重**：同一支球队会同时出现在多个赛事里
 *     （阿森纳既在 ucl 也在 epl，ESPN 给的是同一个 id 359）→ 按 id 去重就不会出现两行阿森纳。
 *     但不能只按 id：足球/篮球的 id 都是数字，NBA 是小数字（凯尔特人 2、开拓者 22），
 *     CBA 是 29115 这种，两套 id 空间互相独立 —— 只按 id 去重会有极小概率把两个不同球队并成一行。
 *     加上大类（football/basketball/esports）就同时满足这两条。
 *
 *  ② **一支球队只能有一个「主场赛事」**：去重之后还得挑一个赛事用来做标签和跳转目标。
 *     不挑的话就按 `data.competitions()` 的顺序，第一个是 ucl —— 阿森纳会被标成「欧冠」，
 *     而用户心里的阿森纳是英超的。所以按 COMP_PRIORITY（国内联赛 > 洲际杯赛）挑。
 *     其余赛事不丢，记在 item.comps 里备用。
 *
 *  ③ **简称别名**：数据里的中文名是规范名（皇家马德里 / 巴塞罗那），
 *     而用户张口就是「皇马」「巴萨」。ALIAS 只做**扩召回** —— 命中别名与命中本体同分，
 *     绝不改展示名，也不会凭空造出数据里没有的球队。
 *
 *  ④ **单字母英文查询直接返回空**：`a` 这种查询会命中几十支球队的缩写，结果毫无意义。
 *     中文一个字就有信息量（"曼" → 曼联/曼城），所以只对纯拉丁查询要求 ≥2 个字符。
 */
const data = require('./data')

/** 常见简称 → 数据里的规范名（球队名或赛事名，需与 display / name 完全一致） */
const ALIAS = {
  // —— 欧洲足球豪门：数据里是规范全名，用户说的是简称
  皇马: '皇家马德里',
  巴萨: '巴塞罗那',
  国米: '国际米兰',
  马竞: '马德里竞技',
  多特: '多特蒙德',
  尤文: '尤文图斯',
  拜仁: '拜仁慕尼黑',
  大巴黎: '巴黎圣日耳曼',
  枪手: '阿森纳',
  红军: '利物浦',
  蓝军: '切尔西',
  蓝月亮: '曼城',
  红魔: '曼联',
  // —— 赛事俗称
  S赛: '全球总决赛',
  世界赛: '全球总决赛',
  MSI: '季中冠军赛',
  德杯: '德玛西亚杯',
}

/**
 * 「主场赛事」优先级：越靠前越优先。
 * 思路是**国内联赛 > 洲际/国际杯赛 > 资格赛/友谊赛** —— 与用户谈球队时的习惯一致
 * （说"阿森纳"默认指英超，说"上海海港"默认指中超而不是亚冠）。
 * 没列到的赛事排在最后，按 data.competitions() 的顺序。
 */
const COMP_PRIORITY = [
  'epl', 'liga', 'seriea', 'bundesliga', 'ligue1', 'nations', 'chn', 'csl',
  'nba', 'cba', 'lpl', 'lck', 'kpl', 'lec', 'msi', 'worlds', 'demacia', 'agames',
  'asiacup', 'uel', 'uecl', 'ucl', 'acl', 'u17', 'u17w', 'friendly',
]

/** 空状态下的推荐词（点一下就能搜）。**必须是查得到的**，否则点了没结果更伤体验 */
const HOT_WORDS = [
  '欧冠', '英超', '西甲', '意甲', '德甲', '中超', 'NBA', 'LPL', 'LCK', 'KPL',
  '全球总决赛', '中国国字号',
  '皇马', '巴萨', '曼联', '阿森纳', '利物浦', '湖人', '勇士', 'T1', 'BLG', 'JDG',
]

/**
 * 归一化：统一小写、剥掉变音符号与一切标点/空格。
 * 目的就是让「A.C. 米兰」「ac米兰」「AC米兰」落成同一个 key，
 * 以及让 Müller / Muller 能互相搜到。
 * `normalize` 在个别老客户端上可能不存在，所以兜一层 try。
 */
function fold(s) {
  let t = String(s == null ? '' : s).toLowerCase()
  try { t = t.normalize('NFD').replace(/[\u0300-\u036f]/g, '') } catch (err) { /* 老客户端忽略 */ }
  return t.replace(/[^0-9a-z\u4e00-\u9fff]+/g, '')
}

/** 别名反查表：规范名的 fold → 该规范名对应的全部简称 fold */
const ALIAS_KEYS = (() => {
  const out = {}
  Object.keys(ALIAS).forEach((k) => {
    const target = fold(ALIAS[k])
    const key = fold(k)
    if (!target || !key || target === key) return
    if (!out[target]) out[target] = []
    out[target].push(key)
  })
  return out
})()

/* ------------------------------------------------------------------ 索引 */

let index = null

/** 中文排序，localeCompare 不可用时回落普通比较（与 utils/data.js 同一套） */
function zhCompare(a, b) {
  try {
    return String(a).localeCompare(String(b), 'zh-Hans-CN')
  } catch (err) {
    return String(a) < String(b) ? -1 : String(a) > String(b) ? 1 : 0
  }
}

function buildIndex() {
  const comps = data.competitions().map((c, i) => {
    const name = c.name || c.key
    const full = c.full || ''
    return {
      kind: 'comp',
      key: c.key,
      name,
      full,
      cat: c.cat,
      accent: c.accent || '#6B7280',
      display: name,
      hasStandings: !!data.standingsOf(c.key),
      seq: i,
      _f: { d: fold(name), f: fold(full), k: fold(c.key), al: ALIAS_KEYS[fold(name)] || [] },
    }
  })

  const compName = {}
  comps.forEach((c) => { compName[c.key] = c.name })

  const prio = (key) => {
    const i = COMP_PRIORITY.indexOf(key)
    return i === -1 ? 100 + comps.findIndex((c) => c.key === key) : i
  }

  const teams = []
  const byId = {}
  data.competitions().forEach((c) => {
    data.teamsOf(c.key).forEach((t) => {
      // ① 大类 + id 去重
      const id = String(t.id)
      const key = `${c.cat}/${id}`
      const hit = byId[key]
      if (hit) {
        if (hit.comps.indexOf(c.key) === -1) hit.comps.push(c.key)
        return
      }
      const display = t.display || t.name || t.abbr || id
      const item = {
        kind: 'team',
        id,
        cat: c.cat,
        name: t.name || '',
        zh: t.zh || '',
        abbr: t.abbr || '',
        color: t.color || '#9CA3AF',
        display,
        comps: [c.key],
        comp: c.key, // 先占位，下面统一挑「主场赛事」
        compName: c.name,
        _f: { d: fold(display), n: fold(t.name || ''), a: fold(t.abbr || ''), al: ALIAS_KEYS[fold(display)] || [] },
      }
      byId[key] = item
      teams.push(item)
    })
  })

  // ② 挑主场赛事（去重后每支队只留一个展示赛事）
  teams.forEach((t) => {
    const best = t.comps.slice().sort((a, b) => prio(a) - prio(b))[0]
    t.comp = best
    t.compName = compName[best] || best
  })

  const list = comps.concat(teams)
  return {
    list,
    teams,
    comps,
    // 「主赛事 / 副赛事」的名字表，页面要展示「另有 N 个赛事」时用得上
    compName,
  }
}

function ensure() {
  if (!index) index = buildIndex()
  return index
}

/** 数据被云端刷新换掉后，索引必须重建（球队可能增减） */
function rebuild() {
  index = null
}

/* ------------------------------------------------------------------ 匹配 */

/** 命中给分：完全一致 > 前缀 > 包含；没命中返回 0 */
function hit(v, q, exact, prefix, part) {
  if (!v) return 0
  if (v === q) return exact
  if (v.indexOf(q) === 0) return prefix
  if (v.indexOf(q) > -1) return part
  return 0
}

function score(it, q) {
  const f = it._f
  let best = 0
  if (it.kind === 'team') {
    best = Math.max(best, hit(f.d, q, 100, 85, 65)) // 展示名（中文优先）
    best = Math.max(best, hit(f.n, q, 92, 76, 58)) // 英文全名
    best = Math.max(best, hit(f.a, q, 90, 72, 52)) // 三字母缩写
  } else {
    best = Math.max(best, hit(f.d, q, 100, 88, 70)) // 赛事简称（英超）
    best = Math.max(best, hit(f.f, q, 96, 82, 62)) // 赛事全称
    best = Math.max(best, hit(f.k, q, 94, 80, 55)) // 赛事 key（epl）
  }
  // ③ 简称别名与本体同分
  for (let i = 0; i < f.al.length; i += 1) {
    best = Math.max(best, hit(f.al[i], q, 100, 85, 65))
  }
  return best
}

/** 赛事排在球队前面：搜到赛事名通常是想看这个赛事，而球队只是"名字里带这两个字" */
function kindRank(it) {
  return it.kind === 'comp' ? 0 : 1
}

/**
 * 搜索。
 * @param {string} kw
 * @param {number} [limit=40]
 * @returns {Object[]} 命中项（kind: 'comp' | 'team'），按相关度排序
 */
function search(kw, limit) {
  const q = fold(kw)
  // ④ 纯拉丁查询至少要 2 个字符
  if (!q) return []
  if (q.length < 2 && /^[0-9a-z]+$/.test(q)) return []

  const idx = ensure()
  const hits = []
  idx.list.forEach((it) => {
    const s = score(it, q)
    if (s > 0) hits.push({ it, s })
  })
  hits.sort((a, b) => (b.s - a.s) || (kindRank(a.it) - kindRank(b.it)) || zhCompare(a.it.display, b.it.display))
  return hits.slice(0, Number(limit) || 40).map((h) => h.it)
}

/**
 * 空状态推荐词：每条都**实测过能搜到**才返回（搜不到的推荐词比没有推荐更糟）。
 * @returns {{w:string, kind:string, display:string}[]}
 */
function hot() {
  const out = []
  const seen = {}
  HOT_WORDS.forEach((w) => {
    const first = search(w, 1)[0]
    if (!first || seen[first.display]) return
    seen[first.display] = true
    out.push({ w, kind: first.kind, display: first.display })
  })
  return out
}

/** 索引规模，用于页面上的说明文案与自检 */
function stats() {
  const idx = ensure()
  return { teams: idx.teams.length, comps: idx.comps.length, rows: idx.list.length }
}

module.exports = { search, hot, stats, rebuild, fold, ALIAS, COMP_PRIORITY, HOT_WORDS }
