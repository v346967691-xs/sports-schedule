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
 * 「赛事名 · 轮次」→「轮次」
 *
 * 卡片 tag 上已经写着赛事名，小字再写一遍就是截图里那种「欧联 欧联」。
 * 第一段不是轮次描述时视为赛事名前缀，去掉；「联赛阶段 · D1组」这类第一段
 * 本身就是阶段，保留。
 *
 * ⚠️ 拿不到轮次就返回空串，由 WXML 用 wx:if 整行隐藏 —— 宁缺毋滥，
 * 绝不写 ESPN 数据里没有的东西（ESPN 各端点实测都没有足球轮次号，见 sync.js 注释）。
 */
function roundLabel(stage, compName) {
  const raw = String(stage || '').trim()
  if (!raw) return ''
  const parts = raw.split('·').map((s) => s.trim()).filter(Boolean)
  if (parts.length > 1 && !isRoundPart(parts[0])) parts.shift()
  const label = parts.join(' · ')
  // 退化检查：削完还是赛事名（说明数据里根本没有轮次），就别显示了
  return label === compName ? '' : label
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
    statusLabel = hasScore ? fmt.sinceText(m.start) : (m.statusText || '已结束')
  }

  // 中文名优先，取不到再回落英文名
  const withZh = (t) => Object.assign({}, t, { zhName: t.zh || t.name })

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
module.exports = { decorate, decorateList, groupByDate, roundLabel }
