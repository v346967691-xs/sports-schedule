/** LoL 官方站点单局 feed：只保存轻量统计，不猜单局胜方。 */
const { LOL, LOL_KEY, COMPETITIONS } = require('./sync')
const FEED = 'https://feed.lolesports.com/livestats/v1'
const KEYS = new Set(COMPETITIONS.filter(c => c.source === 'lol').map(c => c.key))
const isLol = comp => KEYS.has(comp)

async function request(url, headers = {}) {
  let problem
  for (let i = 0; i < 2; i += 1) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), 12000)
    try {
      const response = await fetch(url, { headers, signal: controller.signal })
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      return await response.json()
    } catch (err) { problem = err } finally { clearTimeout(timer) }
  }
  throw problem
}

const num = value => typeof value === 'number' && Number.isFinite(value) ? value : null
const required = ['kills', 'deaths', 'assists', 'creepScore', 'totalGold']

function pickRound(game, feed, homeId, awayId) {
  const frames = (feed && feed.frames || []).filter(f => Number.isFinite(Date.parse(f.rfc460Timestamp)))
  const frame = frames.sort((a, b) => Date.parse(a.rfc460Timestamp) - Date.parse(b.rfc460Timestamp)).pop()
  const meta = feed && feed.gameMetadata || {}
  const side = which => {
    const md = meta[`${which}TeamMetadata`]
    const team = frame && frame[`${which}Team`]
    if (!md || !team) return null
    const stats = new Map((team.participants || []).map(p => [String(p.participantId), p]))
    const players = (md.participantMetadata || []).map(p => {
      const s = stats.get(String(p.participantId))
      return {
        id: p.participantId, name: p.summonerName || '', champion: p.championId || '', role: p.role || '',
        k: num(s && s.kills), d: num(s && s.deaths), a: num(s && s.assists),
        cs: num(s && s.creepScore), gold: num(s && s.totalGold),
        complete: !!s && required.every(k => num(s[k]) != null) && !!p.summonerName && !!p.championId,
      }
    })
    return {
      id: String(md.esportsTeamId || ''), side: which, players,
      kills: num(team.totalKills), gold: num(team.totalGold), towers: num(team.towers),
      barons: num(team.barons), dragons: Array.isArray(team.dragons) ? team.dragons.length : null,
    }
  }
  const blue = side('blue')
  const red = side('red')
  const teams = [blue, red].filter(Boolean)
  const h = teams.find(t => t.id === String(homeId)) || null
  const a = teams.find(t => t.id === String(awayId)) || null
  const full = t => t && t.players.length === 5 && new Set(t.players.map(p => String(p.id))).size === 5
    && t.players.every(p => p.complete) && ['kills', 'gold', 'towers', 'barons', 'dragons'].every(k => t[k] != null)
  return {
    id: String(game.id), n: game.number, state: frame && frame.gameState || 'missing',
    at: frame && frame.rfc460Timestamp || '', h, a,
    complete: !!(frame && frame.gameState === 'finished' && h !== a && full(h) && full(a)
      && new Set(h.players.concat(a.players).map(p => String(p.id))).size === 10),
  }
}

async function fetchLolDetail(m, get = request, now = Date.now()) {
  const matchId = String(m.id).slice(m.comp.length + 1)
  const json = await get(`${LOL}/getEventDetails?hl=zh-CN&id=${matchId}`, { 'x-api-key': LOL_KEY })
  const event = json && json.data && json.data.event
  if (!event || String(event.id) !== matchId || !event.match) throw new Error('LoL 比赛详情结构不完整')
  const teams = event.match.teams || []
  const find = side => teams.find(t => String(t.code || t.name || '').slice(0, 6) === String(side.id))
  const home = find(m.home)
  const away = find(m.away)
  if (!home || !away || home.id === away.id) throw new Error('LoL 详情队伍映射不一致')
  const games = (event.match.games || []).filter(g => g.state === 'completed' || g.state === 'inProgress')
  if (!games.length) return null
  // 历史局使用晚于终局的时间，接口返回末帧；进行中保留一分钟安全缓冲。
  const at = new Date(Math.floor((now - 60000) / 10000) * 10000).toISOString()
  const rounds = []
  for (const game of games) {
    try {
      const feed = await get(`${FEED}/window/${game.id}?startingTime=${encodeURIComponent(at)}`)
      if (String(feed.esportsGameId) !== String(game.id) || String(feed.esportsMatchId) !== matchId) {
        throw new Error('LoL feed 比赛 ID 不匹配')
      }
      rounds.push(pickRound(game, feed, home.id, away.id))
    } catch (err) {
      console.warn(`[lol-detail] ${game.id} 缺数据：${err.message}`)
      rounds.push({ id: String(game.id), n: game.number, state: 'missing', at: '', complete: false, h: null, a: null })
    }
  }
  const wanted = Number(m.home.score || 0) + Number(m.away.score || 0)
  return {
    id: m.id, comp: m.comp, v: 6, ts: now, fin: m.status === 'finished',
    lol: {
      source: 'lolesports', complete: m.status === 'finished' && rounds.length >= wanted && rounds.every(r => r.complete),
      rounds,
    },
  }
}

module.exports = { isLol, pickRound, fetchLolDetail }
