/**
 * 探针：拉取 KPL 官方赛程接口，统计当前出现的 schedule_status 取值，
 * 每种取值为一个样例打印明细（scheduleid / 北京时间 / 队名 / 比分 / 距今时长）。
 *
 * 用法：node tools/probe-kpl-status.js [seasonid]
 *   seasonid 省略或空串 = 当前赛季；传具体值如 KPL2026S2 可查历史赛季（历史赛季已全部结束，用于核对「已结束」取值）
 */
const seasonid = process.argv[2] || ''
const body = JSON.stringify({ seasonid })

const fmtBJ = (ts) => {
  // start_timestamp 是 UTC 秒，转北京时间字符串
  const d = new Date(ts * 1000)
  return new Intl.DateTimeFormat('zh-CN', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).format(d)
}

const dur = (ms) => {
  const abs = Math.abs(ms)
  const m = Math.floor(abs / 60000)
  const h = Math.floor(m / 60)
  const mm = m % 60
  const sign = ms >= 0 ? '+' : '-'
  return `${sign}${h}h${String(mm).padStart(2, '0')}m`
}

;(async () => {
  const res = await fetch('https://kplshop-op.timi-esports.qq.com/kplow/getScheduleList', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
      Referer: 'https://kpl.qq.com/',
      Origin: 'https://kpl.qq.com',
    },
    body,
  })
  const json = await res.json()
  console.log(`HTTP ${res.status}  result=${json.result}  body=${body}`)

  const list = json?.data?.list || []
  console.log(`总场次：${list.length}`)

  // 按 schedule_status 分组
  const groups = new Map()
  for (const ev of list) {
    const s = ev.schedule_status
    if (!groups.has(s)) groups.set(s, [])
    groups.get(s).push(ev)
  }

  const now = Date.now()
  console.log('\n=== schedule_status 取值分布 ===')
  const keys = [...groups.keys()].sort((a, b) => Number(a) - Number(b))
  console.log('取值 | 场次 | 占比')
  for (const k of keys) {
    const arr = groups.get(k)
    console.log(`  ${k}  | ${String(arr.length).padStart(4)} | ${((arr.length / list.length) * 100).toFixed(1)}%`)
  }

  console.log('\n=== 每种取值的样例 ===')
  for (const k of keys) {
    const arr = groups.get(k)
    console.log(`\n--- status=${k} （共 ${arr.length} 场）---`)
    // 取时间最早的一场做样例，另外额外列出该 status 下已过开赛时间的场次，方便判断
    const sorted = [...arr].sort((a, b) => Number(a.start_timestamp) - Number(b.start_timestamp))
    for (const ev of sorted.slice(0, 3)) {
      const ts = Number(ev.start_timestamp)
      const played = Number(ev.team_a_score || 0) + Number(ev.team_b_score || 0)
      console.log(
        `  #${ev.scheduleid} ${ev.stage_name || '-'} | ${fmtBJ(ts)} (距现在 ${dur(ts * 1000 - now)}) | ` +
          `${ev.team_a_name} ${ev.team_a_score}:${ev.team_b_score} ${ev.team_b_name} | BO${ev.bo_total} | 有比分=${played > 0}`
      )
    }
    // 该 status 下，有多少场已过开赛时间
    const past = arr.filter((e) => Number(e.start_timestamp) * 1000 < now).length
    const withScore = arr.filter((e) => Number(e.team_a_score || 0) + Number(e.team_b_score || 0) > 0).length
    console.log(`  >> 已过开赛时间: ${past}/${arr.length}，有比分: ${withScore}/${arr.length}`)
  }

  // 重点：今天（北京时间）的比赛全量明细
  console.log('\n=== 今天前后 24h 内场次明细（北京时间）===')
  const today = list
    .filter((e) => Math.abs(Number(e.start_timestamp) * 1000 - now) < 24 * 3600 * 1000)
    .sort((a, b) => Number(a.start_timestamp) - Number(b.start_timestamp))
  if (!today.length) console.log('  （近 24h 无场次）')
  for (const ev of today) {
    const ts = Number(ev.start_timestamp)
    console.log(
      `  #${ev.scheduleid} status=${ev.schedule_status} | ${fmtBJ(ts)} (${dur(ts * 1000 - now)}) | ` +
        `${ev.team_a_name} ${ev.team_a_score}:${ev.team_b_score} ${ev.team_b_name} | ${ev.stage_name || '-'}`
    )
  }
})()
