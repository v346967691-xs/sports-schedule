const assert = require('node:assert/strict')
const { SCHEMA, BASKET_STAT_LABELS, espnFinal, kplFinal, pickBasketballMvp,
  pickFootballMvp, pickKplMvp, pickBasketballPlayers, pickLineups, needsFetch } = require('./match-detail')

const clone = value => JSON.parse(JSON.stringify(value))
const match = comp => ({ id: `${comp}-123`, comp, seasonid: 'S1', status: 'finished',
  start: new Date(Date.now() - 30 * 3600000).toISOString(),
  home: { id: 'H', score: 2 }, away: { id: 'A', score: 1 } })
const header = { id: '123', competitions: [{ status: { type: { completed: true, state: 'post' } } }] }
const basketballPlayer = (id, min = '25', overrides = {}) => ({
  athlete: { id, displayName: `Player ${id}`, position: { abbreviation: 'G' } },
  stats: [min, '20', '8-12', '2-4', '2-2', '6', '5', '1', '2', '1', '2', '4', '3', '+4'],
  ...overrides,
})
const basketball = { header, boxscore: { players: ['H', 'A'].map((id, index) => ({ team: { id },
  statistics: [{ labels: BASKET_STAT_LABELS, athletes: [basketballPlayer(String(index + 1))] }] })) } }

// 完赛必须由官方本场响应确认，不能只信本地赛程状态或其他场次返回。
const unfinished = clone(basketball)
unfinished.header.competitions[0].status.type.completed = false
assert.equal(espnFinal(unfinished, match('nba')), false)
assert.equal(pickBasketballMvp(unfinished, match('nba')), null)
const wrongEvent = clone(basketball)
wrongEvent.header.id = '999'
assert.equal(pickBasketballMvp(wrongEvent, match('nba')), null)
assert.equal(espnFinal(basketball, { ...match('nba'), status: 'live' }), false)
const abandoned = clone(basketball)
abandoned.header.competitions[0].status.type.name = 'STATUS_ABANDONED'
assert.equal(espnFinal(abandoned, match('epl')), false)

const nba = clone(basketball)
nba.boxscore.players[0].statistics[0].athletes.push(
  basketballPlayer('3', '0'), basketballPlayer('4', '0:00'), basketballPlayer('5', '30', { didNotPlay: true }),
  basketballPlayer('6', '0:01'))
const nbaMvp = pickBasketballMvp(nba, match('nba'))
assert.deepEqual(nbaMvp.candidates.map(p => p.id), ['espn:1', 'espn:6', 'espn:2'])
assert.equal(nbaMvp.kind, 'basketball')
assert.deepEqual(nbaMvp.candidates[0].stats.find(s => s.label === '得分'), { label: '得分', value: '20' })
assert.equal(nbaMvp.candidates[0].roleKey, 'BG')
assert.equal(pickBasketballPlayers(nba, 'H').home.length, 2)
assert.equal(pickBasketballPlayers(nba, 'H').home[0].i, '1')
const missingNbaId = clone(nba)
delete missingNbaId.boxscore.players[0].statistics[0].athletes[0].athlete.id
assert.equal(pickBasketballMvp(missingNbaId, match('nba')), null)
// MVP 按真实列名读取，既有 box 表仍守住固定列序契约。
const reordered = clone(basketball)
for (const team of reordered.boxscore.players) {
  const segment = team.statistics[0]
  segment.labels.reverse()
  segment.athletes[0].stats.reverse()
}
assert.equal(pickBasketballMvp(reordered, match('nba')).candidates[0].stats.find(s => s.label === '得分').value, '20')
assert.equal(pickBasketballPlayers(reordered, 'H'), null)
const wrongTeam = clone(basketball)
wrongTeam.boxscore.players[1].team.id = 'unknown'
assert.equal(pickBasketballMvp(wrongTeam, match('nba')), null)

const footballPlayer = (id, extra = {}) => ({ athlete: { id, displayName: `Football ${id}` },
  position: { name: 'Forward' }, stats: [{ name: 'totalGoals', displayValue: '1' }], ...extra })
const football = { header, rosters: [
  { team: { id: 'H' }, roster: [footballPlayer('10', { starter: true }),
    footballPlayer('11', { starter: false, subbedIn: true, position: { name: 'Substitute' } }),
    footballPlayer('12', { starter: false, subbedIn: false, stats: [{ name: 'appearances', value: 21 }, { name: 'subIns', value: 12 }] }),
    footballPlayer('13', { starter: false })] },
  { team: { id: 'A' }, roster: [footballPlayer('20', { starter: true })] },
] }
const footballMvp = pickFootballMvp(football, match('epl'))
assert.deepEqual(footballMvp.candidates.map(p => p.id), ['espn:10', 'espn:11', 'espn:20'])
assert.equal(footballMvp.candidates[1].roleKey, 'SUB')
assert.deepEqual(footballMvp.candidates[1].stats, [{ label: '进球', value: '1' }])
assert.equal(pickLineups(football, 'H').home[0].i, '10')
const missingFootballId = clone(football)
delete missingFootballId.rosters[0].roster[1].athlete.id
assert.equal(pickFootballMvp(missingFootballId, match('epl')), null)
const noLineup = clone(football)
noLineup.rosters[1].roster[0].starter = false
assert.equal(pickFootballMvp(noLineup, match('epl')), null)

const kplMatch = match('kpl')
const schedule = { scheduleid: '123', seasonid: 'S1', schedule_status: 4,
  team_a_id: 'H', team_b_id: 'A', team_a_score: 2, team_b_score: 1 }
const people = Array.from({ length: 11 }, (_, index) => ({ playerid: String(100 + index),
  team_id: index < 5 || index === 10 ? 'H' : 'A', player_name_short: `选手${index}`, position: index % 5 + 1 }))
const round = (number, win) => ({ round: number, win_team: win, players:
  people.slice(0, 10).map((player, index) => ({ playerid: player.playerid, position: index % 5 + 1,
    hero_id: String(200 + index + number * 10), hero_name: `英雄${index}` })) })
const kpl = { data: { players: people, round_details: [round(1, 'H'), round(2, 'A'), round(3, 'H')] } }
assert.equal(kplFinal(schedule, kplMatch), true)
assert.equal(kplFinal({ ...schedule, schedule_status: 1 }, kplMatch), false)
assert.equal(pickKplMvp(kpl, kplMatch, { ...schedule, schedule_status: 3 }), null)
assert.equal(pickKplMvp(kpl, kplMatch, { ...schedule, seasonid: 'wrong' }), null)
assert.equal(pickKplMvp({ ...kpl, result: 10020003 }, kplMatch, schedule), null)
const series = pickKplMvp(kpl, kplMatch, schedule)
assert.equal(series.candidates.length, 10) // 名单中的未出场替补不进入候选
assert.equal(series.candidates[0].games, 3)
assert.deepEqual(series.candidates[0].stats, [{ label: '出场', value: '3' }, { label: '胜局', value: '2' }])
assert.equal(series.candidates[0].champions.length, 3)
assert.equal(series.candidates[0].roleKey, '1')
const substituted = clone(kpl)
substituted.data.round_details[2].players[0].playerid = '110'
const substitutes = pickKplMvp(substituted, kplMatch, schedule)
assert.equal(substitutes.candidates.length, 11)
assert.equal(substitutes.candidates.find(p => p.id === 'kpl:110').games, 1)
assert.equal(substitutes.candidates.find(p => p.id === 'kpl:100').games, 2)
const duplicates = clone(kpl)
duplicates.data.round_details.push(clone(duplicates.data.round_details[0]))
assert.deepEqual(pickKplMvp(duplicates, kplMatch, schedule), series)
const conflict = clone(duplicates)
conflict.data.round_details[3].win_team = 'A'
assert.equal(pickKplMvp(conflict, kplMatch, schedule), null)
const invalidWin = clone(kpl)
invalidWin.data.round_details[0].win_team = 'third-team'
assert.equal(pickKplMvp(invalidWin, kplMatch, schedule), null)
assert.equal(pickKplMvp(kpl, kplMatch, { ...schedule, team_a_score: 1, team_b_score: 2 }), null)
const missingKplId = clone(kpl)
missingKplId.data.round_details[0].players[0].playerid = ''
assert.equal(pickKplMvp(missingKplId, kplMatch, schedule), null)
const repeatedPick = clone(kpl)
repeatedPick.data.round_details[0].players[1] = clone(repeatedPick.data.round_details[0].players[0])
assert.equal(pickKplMvp(repeatedPick, kplMatch, schedule), null)
const partial = clone(kpl)
partial.data.round_details.pop()
assert.equal(pickKplMvp(partial, kplMatch, schedule), null)

// box 已经过期不代表 MVP 过期；缺失候选仍能在 48h 内补齐。
const cached = { v: SCHEMA, ts: Date.now() - 3600000, fin: true, box: null, mvp: nbaMvp }
assert.equal(needsFetch(match('nba'), { 'nba-123': cached }), false)
assert.equal(needsFetch(match('nba'), { 'nba-123': { ...cached, mvp: null } }), true)
assert.equal(needsFetch({ ...match('nba'), start: new Date(Date.now() - 49 * 3600000).toISOString() },
  { 'nba-123': { ...cached, mvp: null } }), false)

console.log('match-mvp-data: official final state, actual participants, stable IDs, substitutes, DNP, series dedup and win totals passed')
