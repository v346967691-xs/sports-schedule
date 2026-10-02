/**
 * 一次性探测脚本（不进包、不参与同步）：CBA / KPL 的「排名端点」是否存在
 *
 *   node tools/probe-cn-rank.js
 *
 * 赛程接口是通的，这里只回答一个问题：官方有没有现成的积分榜/排名接口。
 */
const CBA = 'https://portal-server.cbaleague.com'
const KPL = 'https://kplshop-op.timi-esports.qq.com/kplow'

const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15'

async function probe(url, opt) {
  try {
    const r = await fetch(url, Object.assign({ headers: { 'User-Agent': UA, Referer: 'https://www.cbaleague.com/' } }, opt || {}))
    const t = await r.text()
    return `${r.status} ${t.length}B ${t.slice(0, 90).replace(/\s+/g, ' ')}`
  } catch (e) {
    return `ERR ${e.message}`
  }
}

;(async () => {
  console.log('=== CBA 排名端点候选 ===')
  const cba = [
    '/home/home_rank', '/home/home_ranking', '/home/rank', '/home/team_rank',
    '/home/home_team_rank', '/home/home_score', '/home/home_data', '/home/home_standing',
  ]
  for (const p of cba) console.log(p.padEnd(26), await probe(CBA + p))

  console.log('\n=== KPL 排名端点候选（POST）===')
  const kpl = ['getRankList', 'getRank', 'getTeamRank', 'getScoreRank', 'getSeasonRank', 'getRankInfo']
  for (const p of kpl) {
    console.log(p.padEnd(26), await probe(`${KPL}/${p}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
      body: JSON.stringify({ seasonid: '' }),
    }))
  }

  console.log('\n=== 赛季是否已开打（决定自算榜何时能出）===')
  const cbaSched = await fetch(`${CBA}/home/home_schedules`, { headers: { 'User-Agent': UA } }).then((r) => r.json())
  const cbaList = (cbaSched && cbaSched.data) || []
  const cbaDone = cbaList.filter((m) => m.home_score != null && m.home_score !== '')
  console.log(`CBA 赛程 ${cbaList.length} 场，已有比分 ${cbaDone.length} 场`)

  const kplSched = await fetch(`${KPL}/getScheduleList`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'User-Agent': UA },
    body: JSON.stringify({ seasonid: '' }),
  }).then((r) => r.json())
  const list = (kplSched && (kplSched.data && (kplSched.data.list || kplSched.data))) || []
  const kplDone = Array.isArray(list) ? list.filter((m) => m.schedule_status === 4) : []
  console.log(`KPL 赛程 ${Array.isArray(list) ? list.length : 0} 场，已结束 ${kplDone.length} 场`)
  if (kplDone.length) {
    console.log('  样例:', JSON.stringify(kplDone[0]).slice(0, 260))
  }
})()
