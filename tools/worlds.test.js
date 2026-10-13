const test = require('node:test')
const assert = require('node:assert/strict')
const worlds = require('../utils/worlds')
function match(id, date, time, status, home, away) {
  return { id, comp: 'worlds', date, time, start: `${date}T${time}:00+08:00`, stage: '全球总决赛 · 瑞士轮', status, bo: 3, home: home || { id: 'A', name: 'A' }, away: away || { id: 'B', name: 'B' } }
}
test('Worlds 2026 excludes previous seasons and outside event dates', () => {
  const list = [match('old', '2025-10-20', '01:00', 'finished'), match('start', '2026-10-15', '04:00', 'upcoming'), match('final', '2026-11-15', '06:00', 'upcoming'), match('late', '2026-11-16', '01:00', 'upcoming')]
  assert.deepEqual(worlds.eventMatches(list).map((m) => m.id), ['start', 'final'])
  assert.equal(worlds.eventMatches([Object.assign({}, list[1], { comp: 'lpl' })]).length, 0)
})
test('Beijing labels distinguish tonight, tomorrow dawn and early morning independent of host timezone', () => {
  const now = Date.parse('2026-10-15T21:00:00+08:00')
  assert.equal(worlds.beijingDay(now), '2026-10-15')
  assert.match(worlds.timeLabel(match('a', '2026-10-15', '23:00'), now), /^今晚 · 2026-10-15 23:00 北京时间$/)
  assert.match(worlds.timeLabel(match('b', '2026-10-16', '00:00'), now), /^明天凌晨/)
  assert.match(worlds.timeLabel(match('c', '2026-10-16', '06:00'), now), /^明天清晨/)
  assert.match(worlds.timeLabel(match('d', '2026-10-16', '07:00'), now), /^明天 ·/)
})
test('filters use LPL ids and follow match predicate; empty follows never become all', () => {
  const list = [match('a', '2026-10-15', '23:00', 'upcoming'), match('b', '2026-10-16', '00:00', 'live', { id: 'C' }, { id: 'D' })]
  assert.deepEqual(worlds.filterMatches(list, 'lpl', { lplIds: ['C'] }).map((m) => m.id), ['b'])
  assert.deepEqual(worlds.filterMatches(list, 'followed', { teams: [] }), [])
  assert.deepEqual(worlds.filterMatches(list, 'followed', { teams: [{ id: 'A' }], matchHasTeam: (m, t) => m.home.id === t.id }).map((m) => m.id), ['a'])
})
test('live is next ahead of upcoming; finished newest first', () => {
  const list = [match('f1', '2026-10-15', '00:00', 'finished'), match('u', '2026-10-17', '00:00', 'upcoming'), match('l', '2026-10-16', '00:00', 'live'), match('f2', '2026-10-15', '02:00', 'finished')]
  const model = worlds.build(list)
  assert.equal(model.next.id, 'l')
  assert.deepEqual(model.finished.map((m) => m.id), ['f2', 'f1'])
})
test('verified 2026 LPL roster remains available without LPL schedule snapshots; exact codes avoid false positives', () => {
  const list = ['AL', 'BLG', 'TES', 'IG', 'T1', 'G2', 'DIG', 'ALTERNATE'].map((code, i) => match(code, '2026-10-20', '02:00', 'upcoming', { id: code, name: code }, { id: 'TBD' }))
  assert.deepEqual(worlds.filterMatches(list, 'lpl', { lplIds: [] }).map((m) => m.id), ['AL', 'BLG', 'TES', 'IG'])
  assert.equal(worlds.isLplTeam({ id: '123', abbr: 'BLG', name: 'Bilibili Gaming' }), true)
  assert.equal(worlds.isLplTeam({ id: '123', name: 'TES Academy' }), false)
  assert.equal(worlds.isLplTeam({ id: 'DIG', name: 'Dignitas' }), false)
  assert.equal(worlds.isLplTeam({ id: 'TBD' }), false)
})
test('qualification labels explain official record thresholds and reject invalid records', () => {
  assert.equal(worlds.qualification(3, 2), '已晋级')
  assert.equal(worlds.qualification(2, 3), '已淘汰')
  assert.equal(worlds.qualification(2, 2), '晋级 / 淘汰关键战')
  assert.equal(worlds.qualification(2, 1), '再胜1场晋级')
  assert.equal(worlds.qualification(1, 2), '再负1场淘汰')
  assert.equal(worlds.qualification(0, 1), '还需3胜晋级')
  assert.equal(worlds.qualification(3, 3), '')
  assert.equal(worlds.qualification(2.5, 0), '')
})
test('Swiss groups use official records despite contradictory scores; missing or unbalanced records stay hidden', () => {
  const m = match('f', '2026-10-20', '02:00', 'finished', { id: 'A', name: 'A', wins: 3, losses: 0, score: 0 }, { id: 'B', name: 'B', wins: 0, losses: 3, score: 2 })
  const groups = worlds.build([m]).swiss
  assert.equal(groups.find((g) => g.key === '3-0').qualification, '已晋级')
  assert.equal(worlds.build([match('no', '2026-10-20', '02:00', 'finished')]).swiss.length, 0)
  assert.equal(worlds.build([Object.assign({}, m, { away: { id: 'B', wins: 0, losses: 2 } })]).swiss.length, 0)
})
