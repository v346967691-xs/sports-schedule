const pad = (n) => (n < 10 ? `0${n}` : `${n}`)

const WEEK = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/** 本地时间下的今天 YYYY-MM-DD（用户在中国即北京时间） */
function todayStr() {
  const d = new Date()
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 把 YYYY-MM-DD 解析成本地零点 */
function parseDay(str) {
  return new Date(`${str.replace(/-/g, '/')} 00:00:00`)
}

function shiftDay(str, delta) {
  const d = parseDay(str)
  d.setDate(d.getDate() + delta)
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

/** 日期标题：今天 / 明天 / 10月2日 周四 / 2025年11月9日 */
function dayLabel(str) {
  if (!str) return ''
  const today = todayStr()
  if (str === today) return '今天'
  if (str === shiftDay(today, 1)) return '明天'
  if (str === shiftDay(today, -1)) return '昨天'
  const d = parseDay(str)
  const sameYear = d.getFullYear() === new Date().getFullYear()
  const md = `${d.getMonth() + 1}月${d.getDate()}日`
  const ymd = `${d.getFullYear()}年${md}`
  return `${sameYear ? md : ymd} ${WEEK[d.getDay()]}`
}

/** 日期条用的短标签：今天 / 10-02 周四 */
function shortDayLabel(str) {
  const today = todayStr()
  if (str === today) return '今天'
  if (str === shiftDay(today, 1)) return '明天'
  const d = parseDay(str)
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}

function weekdayLabel(str) {
  const d = parseDay(str)
  return WEEK[d.getDay()]
}

/** 距离开赛还有多久 */
function countdownText(start) {
  const diff = new Date(start).getTime() - Date.now()
  if (diff <= 0) return '即将开始'
  const mins = Math.floor(diff / 60000)
  if (mins < 1) return '即将开始'
  if (mins < 60) return `${mins} 分钟后`
  const hours = Math.floor(mins / 60)
  if (hours < 24) return `${hours} 小时后`
  const days = Math.floor(hours / 24)
  if (days < 7) return `${days} 天后`
  return `${Math.floor(days / 7)} 周后`
}

/*
 * 🔴 这里曾经有个 `sinceText(start)`，算的是「距开赛多久」（now - start），
 *    却被拿去当「X 小时前结束」显示 —— 用开赛时间冒充结束时间。
 *    00:00 开球的比赛 02:00 打完，卡片上写「2 小时前结束」，是错的。
 *
 *    已删除，别再写回来：ESPN 的 status 里**没有墙钟结束时间**
 *   （只有比赛时钟 clock / displayClock），真实结束时刻凭空算不出来。
 *    需要展示状态就直接用 `match.statusText`（已延期 / 点球大战 / 加时赛 / 已结束），
 *    它来自上游，是确定的。smoke 有一条断言守着这个函数不再出现。
 */

/** 把服务端北京时间 ISO 串转成本地可读的开赛时间 */
function startTimeLabel(start, date, time) {
  return `${dayLabel(date)} ${time}`
}

module.exports = {
  pad,
  WEEK,
  todayStr,
  parseDay,
  shiftDay,
  dayLabel,
  shortDayLabel,
  weekdayLabel,
  countdownText,
  startTimeLabel,
}
