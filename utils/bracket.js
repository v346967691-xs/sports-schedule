/**
 * 淘汰赛对阵树 + 瑞士轮战绩分组
 *
 * 纯函数模块：不 require wx，不碰云，不持状态 —— 冒烟测试可以直接 require 它喂样本，
 * 页面只负责把算好的结果铺开（**几何全部在这里算完**，WXML 里不做任何算术）。
 *
 * ---------------------------------------------------------------- 两条硬约束
 *
 * 🔴 **上游不给晋级关系。** `match.previousMatchIds` 在 2025 与 2026 的全球总决赛里
 *    **恒为 `[]`**（逐场查过）——「哪场八强的胜者进了哪场半决赛」官方根本没给。
 *    唯一可用的规律是：**同一轮次内按开赛时间两两配对**
 *    （八强第 0/1 场 → 半决赛第 0 场，第 2/3 场 → 半决赛第 1 场）。2025 实测该规则成立。
 *    ⚠️ 只要是推断就必须能被证伪：一旦「上一列的胜者集合」与「下一列的双方集合」对不上，
 *       **整段连线不画**，只留分列展示。宁可少画一条线，也不能画错一条。
 *
 * 🔴 **战绩一律读上游 `record`，绝不自己从比分累加。** 我们的快照只覆盖有限时间窗，
 *    场次一旦被窗口裁掉，累加结果就会**静默算错**；而 `record` 永远是官方给的精确值。
 *    （与「只拉官方榜」同一条红线。）
 */

const view = require('./view')

/* ---------------------------------------------------------------- 几何常量
 *
 * 🔴 这几个尺寸是**本模块与 pages/schedule/schedule.wxss 共用的**：
 *    连线端点的纵坐标完全由它们推出来，改了 WXSS 里 .ko-node 的高度就必须同步改这里，
 *    否则连线会整体错位。与排行页 `standings.js: COLUMNS` ↔ `rank.js: renderRow()`
 *    是同一类「改一处要改两处」的耦合。
 */
const NODE_H = 92      // 每张对阵卡的高度（rpx）
const NODE_GAP = 18    // 同一列里两张卡之间的竖直间距
const LINK_W = 36      // 相邻两列之间的「连线走廊」宽度
const ARM = LINK_W / 2 // 走廊中线；横向两段各画一半，在中间接上竖线

const SWISS_RE = /瑞士轮|swiss/i

/**
 * 这一段是不是瑞士轮。
 *
 * ⚠️ 上游 blockName 出现过**编码损坏**（2026-10-25 全球总决赛有一场的 blockName 是
 *    「全球总决赛 · \uFFFD\uFFFD士轮」，`瑞` 被替换成两个替换字符）。这种值已经在
 *    `view.roundLabel` 里被清成**空串**，所以这里天然判为「不是瑞士轮」——
 *    也就是说那一场不进战绩表。它两边的队名当时都是 TBD（没有 record），
 *    放进不放进结果完全一样，所以这个取舍不需要额外处理。
 */
function isSwiss(label) {
  return SWISS_RE.test(String(label || ''))
}

/**
 * 淘汰赛轮次 → 列序号（0 八强 / 1 半决赛 / 2 决赛）；不是淘汰赛轮次返回 -1。
 *
 * ⚠️ 判定顺序**不能调换**：「四分之一决赛」「半决赛」里都含「决赛」二字，
 *    先判「决赛」会把八强和半决赛统统塞进最后一列。
 * ⚠️ 入围赛（play-in）刻意**不进树** —— 6 场 BO5 的赛制不是整齐的对半收敛，
 *    硬塞进来会破坏 2:1 的配对前提，宁可不画。
 */
function koIndexOf(label) {
  const s = String(label || '')
  if (/四分之一|quarter\s*final|1\s*\/\s*4/i.test(s)) return 0
  if (/半决赛|semi\s*-?\s*final/i.test(s)) return 1
  if (/决赛|grand\s*final/i.test(s)) return 2
  return -1
}

/** 一张对阵卡：两支队伍 + 比分 +（已完赛时）胜者 */
function makeNode(m) {
  const finished = m.status === 'finished'
  // idx 只为了让 WXML 的 wx:key 有唯一值 —— 未定对阵时两行的 key 都是 'TBD'，
  // 拿 key 当 wx:key 会撞车。
  const teamOf = (t, idx) => ({
    idx,
    key: String((t && t.id) || ''),
    name: view.nameOf(t),
    abbr: (t && t.abbr) || '',
    color: (t && t.color) || '#8A93A6',
    score: t && typeof t.score === 'number' ? t.score : null,
    win: false,
  })
  const rows = [teamOf(m.home, 0), teamOf(m.away, 1)]
  const a = rows[0].score
  const b = rows[1].score
  // 只有已完赛才判胜负：live 时 1:0 只是「暂时领先」，标成胜者就是撒谎
  if (finished && typeof a === 'number' && typeof b === 'number' && a !== b) {
    rows[a > b ? 0 : 1].win = true
  }
  return {
    id: m.id,
    start: m.start,
    time: m.time || '',
    bo: m.bo || null,
    finished,
    rows,
    /** 有没有一方拿得到比分（决定卡片右侧画不画数字） */
    hasScore: rows[0].score !== null || rows[1].score !== null,
    /** 连到下一列的第几场（-1 = 没连线） */
    feed: -1,
  }
}

/** 这一场的胜者队伍 key；没分胜负（或还没判）回空串 */
function winnerOf(node) {
  const w = node.rows.filter((r) => r.win)[0]
  return w ? w.key : ''
}

/**
 * 相邻两列之间能不能画连线。
 *
 * 规则（顺序不能换）：
 *  1. 场数必须是 2:1 —— 不符就是结构性错误，直接放弃；
 *  2. 若**任意一处**无从校验（下一列对阵还是「待定」，或上一列还有场次没打完），
 *     整体退回「按时间配对」照常画线。这时的树本来大半是「待定」，画错也传不出错误信息；
 *     而有胜负的那一刻，正好就是校验生效的那一刻。
 *  3. 全部可校验时严格比对：上一列各场的胜者集合必须与下一列各场的双方集合**逐组相等**，
 *     任一组对不上就判定上游排列不是「按对阵树相邻」，**整段连线不画**。
 */
function canLink(a, b) {
  if (a.nodes.length !== b.nodes.length * 2) return false

  const winners = []
  for (let i = 0; i < a.nodes.length; i += 1) {
    const w = winnerOf(a.nodes[i])
    if (!w) return true // 上一列还没打完 → 无从校验（规则 2）
    winners.push(w)
  }
  for (let k = 0; k < b.nodes.length; k += 1) {
    const got = b.nodes[k].rows.map((r) => r.key)
    // 下一列还有「待定」→ 这一组无从校验（规则 2）
    if (got.some((x) => !x || x === 'TBD')) return true
  }
  for (let k = 0; k < b.nodes.length; k += 1) {
    const want = [winners[2 * k], winners[2 * k + 1]].slice().sort().join('|')
    const got = b.nodes[k].rows.map((r) => r.key).slice().sort().join('|')
    if (want !== got) return false // 校验失败（规则 3）
  }
  return true
}

/**
 * 用一组比赛构造淘汰赛对阵树。
 *
 * @param {Object[]} list     同一赛事的比赛（**不要先按轮次过滤** —— 树要看到全部轮次）
 * @param {string}   compName 赛事中文名，用于把「赛事名 · 轮次」削成「轮次」
 * @returns {null|{totalH:number, columns:Array, gaps:Array}}
 *          拿不到 ≥2 个轮次时返回 null（只有一列不叫对阵图，页面据此整块不渲染）
 */
function buildBracket(list, compName) {
  const bucket = {}
  const labels = {}
  ;(list || []).forEach((m) => {
    const lb = view.roundLabel(m.stage, compName)
    const i = koIndexOf(lb)
    if (i < 0) return
    if (!bucket[i]) {
      bucket[i] = []
      labels[i] = lb
    }
    bucket[i].push(m)
  })

  const idxs = Object.keys(bucket).map(Number).sort((x, y) => x - y)
  if (idxs.length < 2) return null

  // 每列按开赛时间升序 —— 配对规则就建立在「同列按时间排序」这个前提上
  const columns = idxs.map((i) => {
    const ms = bucket[i].slice().sort((x, y) => {
      const tx = Date.parse(x.start)
      const ty = Date.parse(y.start)
      return (Number.isFinite(tx) ? tx : 0) - (Number.isFinite(ty) ? ty : 0)
    })
    return { label: labels[i], nodes: ms.map(makeNode), padTop: 0 }
  })

  // 列高 = 卡高 × 张数 + 间距 × (张数-1)；整树取最高的那一列，
  // 其余列各自居中 —— 这样「四场八强」正好落在「两场半决赛」的左右两侧。
  const heightOf = (col) => col.nodes.length * NODE_H + Math.max(0, col.nodes.length - 1) * NODE_GAP
  const totalH = columns.reduce((mx, c) => Math.max(mx, heightOf(c)), 0)
  columns.forEach((c) => { c.padTop = Math.round((totalH - heightOf(c)) / 2) })
  const centerOf = (col, i) => col.padTop + i * (NODE_H + NODE_GAP) + NODE_H / 2

  const gaps = []
  for (let k = 0; k < columns.length - 1; k += 1) {
    const a = columns[k]
    const b = columns[k + 1]
    const linked = canLink(a, b)
    const segs = []
    if (linked) {
      a.nodes.forEach((n, i) => {
        const target = Math.floor(i / 2)
        if (target >= b.nodes.length) return
        n.feed = target
        const y1 = centerOf(a, i)
        const y2 = centerOf(b, target)
        // 三段拼成一个「⊐」：左横臂 → 竖脊 → 右横臂
        segs.push(seg(segs.length, 0, y1 - 1, ARM, 2))
        segs.push(seg(segs.length, ARM - 1, Math.min(y1, y2), 2, Math.abs(y1 - y2)))
        segs.push(seg(segs.length, ARM - 1, y2 - 1, ARM + 1, 2))
      })
    }
    gaps.push({ height: totalH, segs, linked })
  }

  // 线性化：WXML 里「列 → 走廊 → 列 → 走廊 → 列」交替铺开。
  // 🔴 刻意不写成两个循环（列循环 + 走廊循环）—— 那样要在列循环里读 `gaps[index]`，
  //    最后一列没有对应走廊，模板里会去读 undefined 的属性，是会真炸的写法。
  const items = []
  columns.forEach((c, i) => {
    items.push({ key: `c${i}`, type: 'col', label: c.label, padTop: c.padTop, nodes: c.nodes })
    if (i < gaps.length) {
      items.push({ key: `g${i}`, type: 'gap', height: gaps[i].height, segs: gaps[i].segs })
    }
  })

  return { totalH, columns, gaps, items }
}

/** 一条连线线段（rpx）。k 只为了给 WXML 当 wx:key（同一走廊内唯一即可） */
function seg(k, left, top, width, height) {
  return {
    k,
    left: Math.round(left),
    top: Math.round(top),
    width: Math.round(width),
    height: Math.round(height),
  }
}

/**
 * 瑞士轮战绩分组。
 *
 * 只做「按官方战绩分组」这一件事：
 *  · **不排序位、不标晋级** —— 同战绩内官方本来就没有名次（靠小分/抽签），
 *    自己编一个 1..16 的名次就是造假；晋级与否由战绩本身说话。
 *  · 战绩取**该队最晚一场**那份 `record` = 阶段当前战绩；阶段结束后自然收敛成最终战绩。
 *  · 跳过 `record` 缺失与 `0-0` 的行 —— 官方对未开赛场次就给 `0-0`，
 *    当成战绩会凭空多出一堆「0-0 的队伍」。
 *
 * 🔴 **平衡校验：胜场总和必须等于负场总和，不等就整张表不返回。**
 *    每场比赛恰好贡献 1 胜 1 负，所以一个**连贯的单一阶段**必然满足
 *    `Σwins === Σlosses`（全球总决赛 2025 实测 33 === 33）。
 *    反例：2026 德玛西亚杯的 `record` 是**跨阶段混装**的 ——
 *    同一个 RED 在 10-03 那场是 1-2、在 10-08 那场变成 0-1，
 *    拼出来的表 Σwins=15 / Σlosses=8，明显不平衡。
 *    这种表宁可不显示：用户看不出哪里不对，但它确实是错的。
 *    （上游**没有**任何可用来分阶段的字段：`tournament` 缺失、`blockName` 两段都叫「瑞士轮」，
 *      27 场逐场查过，所以只能靠这个不变量兜底。）
 *
 * @returns {Array<{key:string, wins:number, losses:number, teams:Array}>} 空数组 = 没有可用的瑞士轮数据
 */
function swissGroups(list, compName) {
  const seen = {}
  ;(list || []).forEach((m) => {
    if (!isSwiss(view.roundLabel(m.stage, compName))) return
    const t = Date.parse(m.start)
    const when = Number.isFinite(t) ? t : 0
    ;[m.home, m.away].forEach((team) => {
      if (!team) return
      const id = String(team.id || '')
      if (!id || id === 'TBD') return
      const w = team.wins
      const l = team.losses
      if (typeof w !== 'number' || typeof l !== 'number') return
      if (w === 0 && l === 0) return
      const prev = seen[id]
      if (prev && prev.when > when) return
      seen[id] = {
        when,
        id,
        name: view.nameOf(team),
        abbr: team.abbr || '',
        color: team.color || '#8A93A6',
        wins: w,
        losses: l,
      }
    })
  })

  const rows = Object.keys(seen).map((k) => seen[k])
  if (!rows.length) return []

  // 平衡校验（见函数头注释）：不平衡说明这些 record 不属于同一个连贯阶段 → 整张表作废
  const sumW = rows.reduce((n, r) => n + r.wins, 0)
  const sumL = rows.reduce((n, r) => n + r.losses, 0)
  if (sumW !== sumL) return []

  rows.sort((a, b) => (b.wins - a.wins) || (a.losses - b.losses) || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))

  const out = []
  const at = {}
  rows.forEach((r) => {
    const gk = `${r.wins}-${r.losses}`
    if (at[gk] === undefined) {
      at[gk] = out.length
      out.push({ key: gk, wins: r.wins, losses: r.losses, teams: [] })
    }
    out[at[gk]].teams.push({
      id: r.id,
      name: r.name,
      abbr: r.abbr,
      color: r.color,
    })
  })
  return out
}

module.exports = {
  NODE_H,
  NODE_GAP,
  LINK_W,
  isSwiss,
  koIndexOf,
  buildBracket,
  swissGroups,
}
