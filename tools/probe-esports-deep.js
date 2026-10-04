/**
 * 电竞（LoL / KPL）「比赛详细数据」还能挖什么 —— 一次性探测脚本。
 *
 * 背景：目前 sync.js 对 LoL 只用了 getSchedule（时间/简码/BO/胜场数），
 *       KPL 只拿到赛程。单局比分、选手、BP、实时经济都没用上。
 *       本脚本逐个试上游端点，把「有没有数据 / 字段长什么样 / 赛后还留不留」记下来。
 *
 * 用法： node tools/probe-esports-deep.js [--lol] [--kpl] [--all]
 * ⚠️ 只读探测，不写任何文件，不碰云端。
 */
const KEY = '0TvQnueqKa5mxJntVWt0w4LpLfEkrV1Ta8rQBb9Z'
const GW = 'https://esports-api.lolesports.com/persisted/gw'
const FEED = 'https://feed.lolesports.com/livestats/v1'
const H = { 'x-api-key': KEY }

const args = process.argv.slice(2)
const want = (n) => args.length === 0 || args.includes('--all') || args.includes(n)

async function j(u, headers, opt) {
  try {
    const r = await fetch(u, { headers, ...opt })
    const t = await r.text()
    try {
      return { ok: r.ok, status: r.status, json: JSON.parse(t) }
    } catch {
      return { ok: r.ok, status: r.status, raw: t.slice(0, 200) }
    }
  } catch (err) {
    return { ok: false, err: err.message }
  }
}

const head = (s) => console.log(`\n${'='.repeat(64)}\n${s}\n${'='.repeat(64)}`)
const show = (label, v) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v)
  console.log(`  ${label}: ${s == null ? '(无)' : String(s).slice(0, 400)}`)
}

/* ------------------------------------------------------------ LoL 部分 */

async function probeLol() {
  head('LoL：先找一个已结束的比赛，拿到 matchId / gameId')

  const sch = await j(`${GW}/getSchedule?hl=zh-CN&leagueId=98767991314006698`, H) // LPL
  const evs = sch.json?.data?.schedule?.events || []
  console.log(`  LPL 赛程事件数：${evs.length}`)

  const done = evs.filter((e) => e.state === 'completed' && e.match?.id)
  const live = evs.filter((e) => e.state === 'inProgress' && e.match?.id)
  console.log(`  已结束：${done.length}   进行中：${live.length}`)

  const pick = done[done.length - 1] || evs[0]
  if (!pick) {
    console.log('  ❌ 拿不到任何比赛，后面的探测跳过')
    return
  }
  const matchId = pick.match.id
  show('选中的 matchId', matchId)
  show('startTime', pick.startTime)
  show('blockName', pick.blockName)
  show('bo (strategy.count)', pick.match.strategy?.count)
  show('teams[0].code', pick.match.teams?.[0]?.code)
  show('teams[0].result', pick.match.teams?.[0]?.result)
  show('games (getSchedule 里带的)', pick.match.games)

  // ---- 1) getEventDetails：官方的「比赛详情」端点
  head('① getEventDetails?id={matchId}')
  const det = await j(`${GW}/getEventDetails?hl=zh-CN&id=${matchId}`, H)
  if (!det.ok || !det.json?.data) {
    show('结果', `失败 ${det.status || det.err}`)
  } else {
    const d = det.json.data.event
    show('顶层字段', Object.keys(det.json.data))
    show('match.id', d.match?.id)
    show('match.games 数量', d.match?.games?.length)
    show('match.games[0]', d.match?.games?.[0])
    show('match.teams[0]', JSON.stringify(d.match?.teams?.[0])?.slice(0, 500))
    show('league', d.league?.name)
    show('vods', d.vods)
  }

  // 从 getEventDetails 里挖 gameId（livestats 要用）
  const games = det.json?.data?.event?.match?.games || pick.match.games || []
  const gameId = games[0]?.id || games[0]?.gameId || null
  show('挖到的 gameId', gameId)

  if (!gameId) {
    head('② feed livestats —— 没有 gameId，跳过')
    return
  }

  // ---- 2) livestats window：实时 / 赛后对局帧
  head(`② feed livestats /window/{gameId}  (gameId=${gameId})`)
  const win = await j(`${FEED}/window/${gameId}`, {})
  if (!win.ok) {
    show('结果', `失败 ${win.status || win.err}`)
  } else {
    const w = win.json || {}
    show('顶层字段', Object.keys(w))
    const md = w.gameMetadata
    show('gameMetadata.blueTeamMetadata 选手数', md?.blueTeamMetadata?.participantMetadata?.length)
    show('选手样例', md?.blueTeamMetadata?.participantMetadata?.[0])
    show('frames 帧数', w.frames?.length)
    const last = w.frames?.[w.frames.length - 1]
    show('最后一帧 rfc460Timestamp', last?.rfc460Timestamp)
    show('最后一帧 blueTeam', last?.blueTeam)
    show('最后一帧 redTeam', last?.redTeam)
    show('最后一帧 participants[0]', last?.participants?.[0])
  }

  // ---- 3) livestats details：选手装备 / 符文
  const pids = []
  for (let i = 1; i <= 10; i += 1) pids.push(i)
  head(`③ feed livestats /details/{gameId}`)
  const dts = await j(`${FEED}/details/${gameId}?participantIds=${pids.join(',')}`, {})
  if (!dts.ok) {
    show('结果', `失败 ${dts.status || dts.err}`)
  } else {
    const arr = dts.json?.frames || []
    show('frames 数', arr.length)
    const lf = arr[arr.length - 1]
    show('最后一帧 participants[0]', lf?.participants?.[0])
  }

  // ---- 4) 历史老比赛的 window 还在不在（关键：能不能做「赛后回看」）
  const old = done[0]
  if (old && old !== pick) {
    const oldGames = old.match.games || []
    const og = oldGames[0]?.id || oldGames[0]?.gameId
    if (og) {
      head(`④ 老比赛（${old.startTime}）的 window 是否还留着`)
      const ow = await j(`${FEED}/window/${og}`, {})
      show('gameId', og)
      show('结果', ow.ok ? `✅ 还在，帧数 ${ow.json?.frames?.length}` : `❌ ${ow.status}`)
    }
  }

  // ---- 5) getTeams：队伍 + 选手名单（ roster ）
  head('⑤ getTeams?hl=zh-CN → 俱乐部与选手名单')
  const tm = await j(`${GW}/getTeams?hl=zh-CN`, H)
  if (tm.ok && tm.json?.data?.teams) {
    const list = tm.json.data.teams
    const arr = Array.isArray(list) ? list : Object.values(list)
    show('队伍总数', arr.length)
    const t1 = arr.find((t) => t.slug === 't1') || arr.find((t) => t.code === 'T1') || arr[0]
    show('样例队', JSON.stringify(t1)?.slice(0, 600))
  } else {
    show('结果', `失败 ${tm.status || tm.err}`)
  }

  // ---- 6) getTournamentsForLeague
  head('⑥ getTournamentsForLeague → 拿 tournamentId')
  const tn = await j(`${GW}/getTournamentsForLeague?hl=zh-CN&leagueId=98767991314006698`, H)
  const tours = tn.json?.data?.leagues?.[0]?.tournaments || []
  show('赛事数', tours.length)
  show('最近一个', tours[tours.length - 1])

  // ---- 7) getTeams 里的 players 结构（选手名单 / 位置 / 国籍）
  head('⑦ getTeams 的 players 字段结构')
  const tm2 = await j(`${GW}/getTeams?hl=zh-CN`, H)
  const arr2 = tm2.json?.data?.teams ? Object.values(tm2.json.data.teams) : []
  const t1 = arr2.find((t) => t.code === 'T1') || arr2[0]
  show('队', `${t1?.code} / ${t1?.name}`)
  show('顶层字段', Object.keys(t1 || {}))
  const ps = t1?.players || []
  show('选手数', ps.length)
  show('选手[0]', ps[0])
  show('队内角色分布', [...new Set(ps.map((p) => p.role))])
}

/**
 * 关键验证：livestats 在「真正的比赛」上到底有没有真实数据。
 * 第一次探的 LPL 赛区资格赛全是 0（totalGold=0 / level=1 / 只有 10 帧），
 * 必须换赛事交叉验证，否则会误判成「这个端点没用」。
 */
async function probeLolDeep() {
  const leagues = [
    ['worlds', '98767975604431411', '全球总决赛'],
    ['lck', '98767991310872058', 'LCK'],
    ['lec', '98767991302996019', 'LEC'],
    ['lpl', '98767991314006698', 'LPL'],
    ['msi', '98767991325878492', '季中冠军赛'],
  ]

  head('验证：livestats 在真实比赛上是否有数据（逐赛事交叉验证）')

  for (const [key, id, name] of leagues) {
    const sch = await j(`${GW}/getSchedule?hl=zh-CN&leagueId=${id}`, H)
    const evs = sch.json?.data?.schedule?.events || []
    const done = evs.filter((e) => e.state === 'completed' && e.match?.id)
    if (!done.length) {
      console.log(`  ${name.padEnd(6)} ❌ 无已结束比赛`)
      continue
    }
    // 取最近 3 场，只要有一场有数据就算通过
    let best = null
    for (const ev of done.slice(-3)) {
      const det = await j(`${GW}/getEventDetails?hl=zh-CN&id=${ev.match.id}`, H)
      const games = det.json?.data?.event?.match?.games || []
      if (!games.length) continue
      const gid = games[0].id
      const w = await j(`${FEED}/window/${gid}`, {})
      const fr = w.json?.frames || []
      const last = fr[fr.length - 1]
      const gold = last?.blueTeam?.totalGold || 0
      const kills = last?.blueTeam?.totalKills || 0
      const cand = {
        name,
        ev: `${ev.match.teams?.[0]?.code} vs ${ev.match.teams?.[1]?.code}`,
        start: ev.startTime,
        games: games.length,
        gameId: gid,
        frames: fr.length,
        gold,
        kills,
        towers: last?.blueTeam?.towers,
        dragons: JSON.stringify(last?.blueTeam?.dragons),
        champion: w.json?.gameMetadata?.blueTeamMetadata?.participantMetadata?.[0]?.championId,
        summoner: w.json?.gameMetadata?.blueTeamMetadata?.participantMetadata?.[0]?.summonerName,
      }
      if (!best || gold > best.gold) best = cand
    }
    if (!best) {
      console.log(`  ${name.padEnd(6)} ⚠️ 取不到 gameId`)
      continue
    }
    const ok = best.gold > 0 || best.frames > 20
    console.log(
      `  ${name.padEnd(6)} ${ok ? '✅ 有真实数据' : '⚠️ 疑似空数据'} | ${best.ev} | ${best.start}`
    )
    console.log(
      `         局数=${best.games} 帧数=${best.frames} 经济=${best.gold} 击杀=${best.kills} 塔=${best.towers} 龙=${best.dragon || '-'}`
    )
    console.log(`         样例英雄=${best.champion} 选手=${best.summoner}`)
  }

  head('验证：单局胜负怎么拿（getEventDetails 的 games[].state / teams[]）')
  const sch = await j(`${GW}/getSchedule?hl=zh-CN&leagueId=98767975604431411`, H)
  const evs = sch.json?.data?.schedule?.events || []
  const done = evs.filter((e) => e.state === 'completed' && e.match?.id)
  if (done.length) {
    const ev = done[done.length - 1]
    const det = await j(`${GW}/getEventDetails?hl=zh-CN&id=${ev.match.id}`, H)
    const g = det.json?.data?.event?.match?.games || []
    console.log(`  ${ev.match.teams?.[0]?.code} vs ${ev.match.teams?.[1]?.code}  共 ${g.length} 局`)
    g.forEach((x) => {
      console.log(
        `    局${x.number} state=${x.state} winner=${x.winner || '(无此字段)'} teams=${JSON.stringify(x.teams)} vods=${x.vods?.length}`
      )
    })
    show('games[0] 全部字段', Object.keys(g[0] || {}))
    show('vods[0]', g[0]?.vods?.[0])
  }
}

/* ------------------------------------------------------------ KPL 部分 */

const KPL = 'https://kplshop-op.timi-esports.qq.com/kplow'

// ⚠️ KPL 后端要求这三个头（从 kpl.qq.com 前端包挖出来的），缺了会 404
const KPL_H = {
  'Content-Type': 'application/json',
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122 Safari/537.36',
  Referer: 'https://kpl.qq.com/',
  Origin: 'https://kpl.qq.com',
}

async function kplPost(path, body) {
  return j(`${KPL}/${path}`, KPL_H, { method: 'POST', body: JSON.stringify(body || {}) })
}

async function probeKpl() {
  head('KPL：先拿赛程，看现有接口给了什么')

  const sch = await kplPost('getScheduleList', { seasonid: '' })
  show('/getScheduleList 状态', sch.status)
  const list = sch.json?.data?.list || []
  const done = list.filter((e) => Number(e.schedule_status) === 4)
  show('总场次', list.length)
  show('已结束场次', done.length)
  if (list.length) {
    const sample = done[done.length - 1] || list[0]
    show('样例（全部字段）', JSON.stringify(sample))
  }

  head('KPL 深入①：getScheduleDetail 传 scheduleid 后的完整结构')
  if (done.length) {
    const sid = done[done.length - 1].scheduleid
    show('传入 scheduleid', sid)
    const sd = await kplPost('getScheduleDetail', { scheduleid: sid })
    const D = sd.json?.data || {}
    show('data 顶层字段', Object.keys(D))
    const rounds = D.round_details || []
    show('局数 (round_details)', rounds.length)
    rounds.forEach((r, i) => {
      console.log(
        `    局${i + 1} 胜方=${r.win_team_name} vid=${r.vid} 选手数=${r.players?.length}`
      )
    })
    show('局1 全部字段', Object.keys(rounds[0] || {}))
    show('局1 选手[0]', rounds[0]?.players?.[0])
    show('局1 选手[1]', rounds[0]?.players?.[1])
    show('是否有 ban/pick 字段', JSON.stringify(rounds[0] || {}).match(/ban|pick/i))
  }

  head('KPL 深入②：getPlayerRank 有哪些榜')
  const pr = await kplPost('getPlayerRank', { seasonid: '' })
  const P = pr.json?.data || {}
  show('data 顶层字段', Object.keys(P))
  Object.keys(P).forEach((k) => {
    const arr = P[k]
    if (Array.isArray(arr)) {
      console.log(`    ${k}: ${arr.length} 条  样例=${JSON.stringify(arr[0])?.slice(0, 200)}`)
    }
  })

  head('KPL 深入③：getBattleDetail 传 scheduleid 试试（实时对局？）')
  if (done.length) {
    const sid = done[done.length - 1].scheduleid
    const bd = await kplPost('getBattleDetail', { scheduleid: sid })
    show('结果', JSON.stringify(bd.json)?.slice(0, 400))
  }

  head('KPL：批量试驼峰命名的接口（只看 HTTP 状态与有无数据）')
  const cand = [
    'getScheduleDetail',
    'getMatchDetail',
    'getMatchInfo',
    'getMatchLive',
    'getMatchData',
    'getBattleDetail',
    'getBpInfo',
    'getTeamList',
    'getTeamDetail',
    'getTeamRank',
    'getPlayerList',
    'getPlayerRank',
    'getPlayerDetail',
    'getSeasonList',
    'getNewsList',
    'getLiveList',
    'getRankList',
    'getDataRank',
    'getHeroList',
  ]
  for (const p of cand) {
    const r = await kplPost(p, { seasonid: '' })
    const size = r.json ? JSON.stringify(r.json).length : 0
    const ok = r.ok && size > 60
    console.log(
      `  ${ok ? '✅' : '❌'} ${p.padEnd(20)} status=${String(r.status || r.err).padEnd(6)} bytes=${size}`
    )
    if (ok) console.log(`       ${JSON.stringify(r.json).slice(0, 300)}`)
  }
}

/* ------------------------------------------------------------------ */

;(async () => {
  if (want('--lol')) await probeLol()
  if (args.includes('--verify')) await probeLolDeep()
  if (want('--kpl')) await probeKpl()
  console.log('\n探测结束（只读，未写入任何文件）\n')
})()
