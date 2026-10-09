/**
 * 赛程卡片的视图模型
 * WXML 里不做复杂表达式运算，统一在这里把展示字段算好。
 */

const fmt = require('./format')

/**
 * 这段是不是「轮次描述」本身？
 * 用尾部/整词匹配，不能用包含匹配 —— 「全球总决赛」里含「决赛」二字，
 * 包含匹配会把它当成轮次，结果「全球总决赛 · 瑞士轮」削不掉赛事名（踩过）。
 */
const EXACT_ROUND = ['决赛', '半决赛', '季军赛', '四分之一决赛', '淘汰赛', '入围赛', '资格赛', '常规赛', '季后赛']
function isRoundPart(s) {
  if (/^第\s*\d+/.test(s)) return true          // 第 4 周 / 第10轮
  if (/(轮|周|组|阶段)$/.test(s)) return true   // 瑞士轮 / 第 4 周 / D1组 / 联赛阶段
  return EXACT_ROUND.indexOf(s) > -1
}

/**
 * 编码损坏的字符：U+FFFD 替换字符，以及不该出现在标签里的控制字符。
 *
 * 🔴 上游 blockName 真的会坏：2026-10-25 全球总决赛有一场的 blockName 是
 *    「全球总决赛 · \uFFFD\uFFFD士轮」（`瑞` 被替换成两个替换字符）。这种半截词
 *    **宁可什么都不显示，也不能把「��士轮」印到卡片上** —— 它还会额外拼出一个
 *    只有一个场次的垃圾阶段筛选条。所以只要结果里沾到就整段丢弃。
 *    （同一条红线：宁可都不写，也不要错的。）
 */
const BROKEN = /[\uFFFD\u0000-\u001F]/

/**
 * 「赛事名 · 轮次」→「轮次」；拿不到轮次时退回「赛事名」
 *
 * 第一段不是轮次描述时视为赛事名前缀，削掉，避免「LPL · 第 1 周」在小字里
 * 又写一遍 LPL；「联赛阶段 · D1组」这类第一段本身就是阶段，保留。
 *
 * ⚠️ 足球与 NBA 的 stage 数据里**只有赛事名**（实测："英超"/"欧冠"/"NBA"），
 * 因为 ESPN 各端点都不提供轮次号（见 sync.js 注释）。
 * 2026-09-30 用户决定：这种情况**小字显示赛事名**，不留空（曾短暂改成留空，
 * 卡片看着太空）。别再改回留空，也别去「推导」轮次（第几场=第几轮的算法已被否决）。
 *
 * ⚠️ 唯一例外是上面的 BROKEN：上游脏数据回空串，让调用方走「没有轮次就不渲染」的分支。
 */
function roundLabel(stage, compName) {
  const raw = String(stage || '').trim()
  const name = String(compName || '').trim()
  if (!raw) return name
  const parts = raw.split('·').map((s) => s.trim()).filter(Boolean)
  if (parts.length > 1 && !isRoundPart(parts[0])) parts.shift()
  const out = parts.join(' · ') || name
  // 脏数据整段丢弃 —— 返回空串而不是半截词，调用方（卡片小字 / 阶段筛选条）据此不渲染
  return BROKEN.test(out) ? '' : out
}

/**
 * 队名归一，落不到中文时回落英文名。
 *
 * 🔴 未确定的对阵必须显示「待定」而不是接口占位符：LoL 的赛程接口在抽签前
 *    对所有场次返回 `TBD`，一个淘汰赛阶段能占十几行 —— 卡片上「TBD vs TBD」
 *    对用户等于没信息，而「待定 vs 待定」至少说明"是对阵未定，不是数据坏了"。
 *    （2026-10-09 全球总决赛 40 场全 TBD 时发现。）
 *
 * ⚠️ 规则内联在这里，不能 require tools/zh-names.js —— `tools/` 不进小程序包。
 *    两处判定要保持一致：`tools/zh-names.js` 的 placeholderZh 也认 TBD/TBD Home/TBD Away。
 */
function nameOf(t) {
  const raw = String((t && (t.zh || t.name)) || '').trim()
  if (!raw || /^TBD([\s_-]*(home|away))?$/i.test(raw)) return '待定'
  return raw
}

function decorate(m) {
  const ctx = this || {}
  const comp = ctx.compOf ? ctx.compOf(m.comp) : { name: m.comp, accent: '#6B7280' }
  const isEsports = m.bo !== null && m.bo !== undefined
  const homeWin = m.status === 'finished' && typeof m.home.score === 'number' && typeof m.away.score === 'number' && m.home.score > m.away.score
  const awayWin = m.status === 'finished' && typeof m.home.score === 'number' && typeof m.away.score === 'number' && m.away.score > m.home.score
  const hasScore = m.status !== 'upcoming' && typeof m.home.score === 'number' && typeof m.away.score === 'number'

  let statusLabel = m.statusText
  let statusHint = ''
  if (m.status === 'upcoming') {
    statusLabel = isEsports && m.bo ? `BO${m.bo}` : '未开始'
    statusHint = fmt.countdownText(m.start)
  } else if (m.status === 'live') {
    statusLabel = m.statusText || '进行中'
    statusHint = ''
  } else {
    // 🔴 这里曾经写的是 `hasScore ? fmt.sinceText(m.start) : ...`，把「距开赛多久」
    //    显示成了「X 小时前结束」—— 00:00 开球的比赛，02:00 打完就写成「2 小时前结束」，
    //    等于用开赛时间冒充结束时间（2026-10-03 用户报的正是这个）。
    //
    //    ESPN 的 status 里**没有墙钟结束时间**（只有比赛时钟 clock / displayClock），
    //    真实结束时刻无从得知 → 按用户要求，不猜，直接给确定的信息。
    //    而且 statusText 本身信息更丰富：已延期 / 点球大战 / 加时赛 / 已结束。
    statusLabel = m.statusText || '已结束'
  }

  // 中文名优先，取不到再回落英文名；未定对阵统一成「待定」
  const withZh = (t) => Object.assign({}, t, { zhName: nameOf(t) })

  // 卡片小字只展示「轮次/阶段」，不重复 tag 上已经写着的赛事名。
  // 数据里的 stage 形如「全球总决赛 · 瑞士轮」「LEC · 第 4 周」——
  // 第一段是赛事名，去掉；「联赛阶段 · D1组」这种第一段本身就是阶段，保留。
  const stageLabel = roundLabel(m.stage, comp.name)

  return Object.assign({}, m, {
    home: withZh(m.home),
    away: withZh(m.away),
    _comp: comp,
    _compName: comp.name,
    _accent: comp.accent,
    _dayLabel: fmt.dayLabel(m.date),
    _weekday: fmt.weekdayLabel(m.date),
    _statusLabel: statusLabel,
    _statusHint: statusHint,
    _stageLabel: stageLabel,
    _hasScore: hasScore,
    _homeWin: homeWin,
    _awayWin: awayWin,
    _bo: m.bo ? `BO${m.bo}` : '',
    _isEsports: isEsports,
    _historical: !!m.historical,
  })
}

/** 批量转换 */
function decorateList(list, ctx) {
  return list.map((m) => decorate.call(ctx || {}, m))
}

/** 把比赛按日期分组，返回 [{ date, dayLabel, items }]。分组顺序沿用传入列表的顺序 */
function groupByDate(list, ctx) {
  const map = {}
  const order = []
  list.forEach((m) => {
    if (!map[m.date]) {
      map[m.date] = []
      order.push(m.date)
    }
    map[m.date].push(m)
  })
  return order.map((d) => ({
    date: d,
    dayLabel: fmt.dayLabel(d),
    weekday: fmt.weekdayLabel(d),
    items: (ctx ? decorateList(map[d], ctx) : map[d]),
  }))
}

// roundLabel 一并导出：冒烟测试要用它验证「小字只写轮次、不重复赛事名」
// nameOf 导出：赛程分享卡直接读原始 match（没有 zhName），要与卡片显示同一套规则
module.exports = { decorate, decorateList, groupByDate, roundLabel, nameOf }
