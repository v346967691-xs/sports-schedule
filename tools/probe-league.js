/**
 * 临时探针：验证新增赛事在上游到底有没有数据（一次性工具，用完即删）。
 * ESPN：node tools/probe-league.js espn <sport>/<league> [YYYYMM ...]
 *   例：node tools/probe-league.js espn soccer/chn.1 202609 202610
 * 自定义：node tools/probe-league.js raw <url>
 */
const mode = process.argv[2] || 'espn'
const rest = process.argv.slice(3)

async function getJSON(url) {
  const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' } })
  if (!res.ok) throw new Error(`HTTP ${res.status}`)
  return res.json()
}

function showEspn(json, tag) {
  const lg = (json.leagues && json.leagues[0]) || {}
  const evs = json.events || []
  console.log(
    `${tag}  赛事=${lg.name || '?'} (${lg.abbreviation || '?'})  赛季=${(lg.season && lg.season.year) || '?'}  场次=${evs.length}`
  )
  const byState = {}
  evs.forEach((e) => {
    byState[e.status?.type?.state || '?'] = (byState[e.status?.type?.state || '?'] || 0) + 1
  })
  console.log(`   状态分布：${Object.entries(byState).map(([k, v]) => `${k}=${v}`).join(' ')}`)
  evs.slice(0, 5).forEach((e) => {
    const c = (e.competitions && e.competitions[0]) || {}
    const teams = (c.competitors || [])
      .map((t) => `${t.team?.displayName || '?'}${t.score != null ? ' ' + t.score : ''}`)
      .join(' vs ')
    console.log(`   ${e.date}  ${e.status?.type?.detail || e.status?.type?.name}  ${teams}`)
  })
}

;(async () => {
  if (mode === 'raw') {
    const j = await getJSON(rest[0])
    console.log(JSON.stringify(j).slice(0, 1500))
    return
  }
  const target = rest[0]
  const months = rest.slice(1)
  const list = months.length ? months : [new Date().toISOString().slice(0, 7).replace('-', '')]
  for (const m of list) {
    const url = `https://site.api.espn.com/apis/site/v2/sports/${target}/scoreboard?dates=${m}`
    try {
      const j = await getJSON(url)
      showEspn(j, `${target} ${m}`)
    } catch (e) {
      console.log(`${target} ${m} -> ${e.message}`)
    }
  }
})()
