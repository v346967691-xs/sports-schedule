/**
 * 一次性探测脚本（不进包、不参与同步）：英雄联盟官方积分榜接口
 *
 *   node tools/probe-lol-standings.js
 *
 * 结论写回 .workbuddy/memory，本文件用于复核端点是否还活着。
 */
const LOL = 'https://esports-api.lolesports.com/persisted/gw'
const KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z'
const H = { 'x-api-key': KEY }

const g = async (p) => {
  const r = await fetch(`${LOL}${p}`, { headers: H })
  return r.json()
}

const LEAGUES = {
  lpl: '98767991314006698',
  lck: '98767991310872058',
  lec: '98767991302996019',
  worlds: '98767975604431411',
  msi: '98767991325878492',
}

async function standingsOf(name, id) {
  const tr = await g(`/getTournamentsForLeague?hl=zh-CN&leagueId=${id}`)
  const ts = (tr.data.leagues[0].tournaments || []).slice()
    .sort((a, b) => b.startDate.localeCompare(a.startDate))
  const t = ts[0]
  const st = await g(`/getStandings?hl=zh-CN&tournamentId=${t.id}`)
  const stages = (st.data.standings || []).reduce((acc, s) => acc.concat(s.stages || []), [])
  const groups = stages.map((s) => (s.sections || []).map((x) => x.name).join(','))
  const teams = stages.reduce((acc, s) => acc.concat(
    (s.sections || []).reduce((a2, sec) => a2.concat(
      (sec.rankings || []).reduce((a3, r) => a3.concat(r.teams || []), [])
    ), [])
  ), [])
  console.log(`${name}\t${t.slug}\tstages=${stages.length}\t组=${groups.join(' | ').slice(0, 70)}\t队伍=${teams.length}`)
  if (teams.length) {
    console.log('   样例:', teams.slice(0, 4).map((x) => `${x.code}(${x.record.wins}-${x.record.losses})`).join(' '))
  }
}

;(async () => {
  for (const k of Object.keys(LEAGUES)) {
    try {
      await standingsOf(k, LEAGUES[k])
    } catch (e) {
      console.log(k, '失败:', e.message)
    }
  }

  const tm = await g('/getTeams?hl=zh-CN')
  const all = tm.data.teams || []
  const cn = all.filter((t) => /[\u4e00-\u9fa5]/.test(t.name))
  console.log(`\ngetTeams zh-CN: 总队数 ${all.length}，含中文名 ${cn.length}`)
  console.log('  中文样例:', JSON.stringify(cn.slice(0, 6)).slice(0, 400))
  const blg = all.find((t) => t.code === 'BLG')
  console.log('  BLG:', JSON.stringify(blg))
})()
