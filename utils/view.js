/**
 * 赛程卡片的视图模型
 * WXML 里不做复杂表达式运算，统一在这里把展示字段算好。
 */

const fmt = require('./format')

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

module.exports = { decorate, decorateList, groupByDate }
