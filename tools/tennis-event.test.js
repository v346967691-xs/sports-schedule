const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const event = require('../utils/tennis-event')
const bracket = require('../utils/tournament-bracket')
const { encodeSnapshot, decodeSnapshot } = require('../utils/snapshot')
const NOW = Date.parse('2026-10-16T12:00:00+08:00')
function match(id, round, home, away, winner, extra = {}) {
  return { id: `atp-${id}`, comp: 'atp', start: '2026-10-10T04:00:00Z', date: '2026-10-10', time: '12:00',
    eventId: 'fixture-2026', eventStart: '2026-09-28T04:00:00Z', eventEnd: '2026-10-18T04:00:00Z',
    stage: `China Open · ${round}`, venue: 'Beijing, China PR · Lotus', status: winner ? 'finished' : 'upcoming',
    statusText: winner ? '已结束' : '', broadcast: ['咪咕'], winnerId: winner || '',
    home: { id: home, name: `Player ${home}`, score: winner ? (winner === home ? 2 : 0) : null },
    away: { id: away, name: `Player ${away}`, score: winner ? (winner === away ? 2 : 0) : null }, ...extra }
}
function load(file, overrides = {}) {
  const filename = path.join(__dirname, '..', file), real = createRequire(filename)
  const box = { require: real, module: { exports: {} }, __dirname: path.dirname(filename), console,
    Date, setInterval, clearInterval, ...overrides }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), box, { filename })
  return box.module.exports
}
test('courts are station scoped, translated where known and missing courts stay unassigned', () => {
  assert.equal(event.courtOf({ venue: 'Beijing, China PR · Capital Group Diamond' }).name, '钻石球场')
  assert.equal(event.courtOf(match('1', 'Final', '1', '2')).name, '莲花球场')
  assert.equal(event.courtOf({ venue: 'Shanghai, China PR · Court 7' }).name, '7号球场')
  assert.equal(event.courtOf({ venue: 'Shanghai, China PR' }).key, 'unassigned')
  assert.equal(event.courtOf({ venue: 'X · Unknown Court' }).name, 'Unknown Court')
})

test('whole-event archive preserves early rounds across month/window changes and expires per event', () => {
  const early = match('1', 'Round 1', '1', '2', '1', { start: '2026-09-28T04:00:00Z', date: '2026-09-28' })
  const later = match('2', 'Round 2', '1', '3', '1')
  const initial = event.buildArchive([early], null, NOW)
  const next = event.buildArchive([later], initial, NOW)
  assert.equal(event.archiveRows(next).length, 2)
  assert.equal(next.events.length, 1)
  const restored = event.archiveRows(next).find(m => m.id === early.id)
  assert.equal(restored.stage, early.stage)
  assert.equal(restored.venue, early.venue)
  assert.equal(restored.winnerId, '1')
  assert.deepEqual(restored.broadcast, ['咪咕'])
  assert.equal(event.archiveRows(event.buildArchive([], next, Date.parse(early.eventEnd) + 31 * 86400000)).length, 0)
  const nextYear = { ...early, id: 'atp-next', eventId: 'fixture-2027', start: '2027-09-28T04:00:00Z', eventStart: '2027-09-28T04:00:00Z', eventEnd: '2027-10-18T04:00:00Z' }
  assert.notEqual(event.identity(early).key, event.identity(nextYear).key)
})

test('compact snapshots preserve event identity and official winners including retirement', () => {
  const retired = match('r', 'Final', '1', '2', '2', { statusText: '退赛', home: { id: '1', name: 'A', score: 1 }, away: { id: '2', name: 'B', score: 0 } })
  const restored = decodeSnapshot(encodeSnapshot([retired]))[0]
  assert.equal(restored.winnerId, '2')
  assert.equal(restored.eventId, retired.eventId)
  assert.equal(restored.eventStart, retired.eventStart)
  const node = bracket.tennisEntries([restored])[0]
  assert.equal(node.winnerId, '2')
  const missingWinner = bracket.tennisEntries([{ ...retired, winnerId: '' }])[0]
  assert.equal(missingWinner.winnerId, '')
})

test('authoritative event refresh cancels vanished empty slots without deleting real history or future slots', () => {
  const empty = id => match(id, 'Round 1', '-3', '-4')
  const vanished = empty('bye'), future = empty('future')
  const real = match('real', 'Round 1', '1', '2', '1')
  const pending = match('pending', 'Round 1', '3', '4')
  const other = { ...empty('other'), eventId: 'other-event' }
  const initial = event.buildArchive([vanished, future, real, pending, other], null, NOW)
  const incoming = [future, real]
  const regular = event.archiveRows(event.buildArchive(incoming, initial, NOW))
  assert.equal(regular.find(m => m.id === vanished.id).status, 'upcoming', 'partial windows cannot retract slots')
  const updated = event.archiveRows(event.buildArchive(incoming, initial, NOW, true))
  assert.equal(updated.find(m => m.id === vanished.id).status, 'canceled')
  for (const row of [future, pending, other]) assert.equal(updated.find(m => m.id === row.id).status, 'upcoming')
  assert.equal(updated.find(m => m.id === real.id).status, 'finished')
  assert.equal(event.mergeRows([vanished], updated).find(m => m.id === vanished.id).status, 'canceled', 'new archive suppresses bundled ghosts')
  assert.equal(bracket.tennisEntries(updated).some(m => m.id === vanished.id), false)
  assert.equal(event.archiveRows(event.buildArchive([], initial, NOW, true)).find(m => m.id === vanished.id).status, 'upcoming', 'failed/empty fetch is not a cancellation')
  const restored = event.archiveRows(event.buildArchive([{ ...vanished, home: real.home, away: real.away }], event.buildArchive(incoming, initial, NOW, true), NOW, true))
  assert.equal(restored.find(m => m.id === vanished.id).status, 'upcoming', 'a subsequently announced real match can reuse the slot')
})

test('legacy cloud records retain archived event identity, platforms and winners but live records have no final winner', () => {
  const prior = match('1', 'Round 1', '1', '2', '1')
  const legacy = { ...prior, broadcast: [], winnerId: '', eventId: '', eventStart: '', eventEnd: '' }
  const merged = event.mergeRows([prior], [legacy])[0]
  assert.equal(event.identity(merged).key, event.identity(prior).key)
  assert.deepEqual(merged.broadcast, ['咪咕'])
  assert.equal(merged.winnerId, '1')
  assert.equal(event.mergeRows([prior], [{ ...legacy, status: 'live' }])[0].winnerId, undefined)
  assert.equal(event.mergeRows([prior], [{ ...legacy, home: { id: '5' } }])[0].winnerId, undefined)
})

test('cloud refresh keeps archived early rounds out of normal schedules and overlays current scores on event pages', async () => {
  const early = match('1', 'Round 1', '1', '2', '1')
  const later = match('2', 'Round 2', '1', '3', '1')
  const archive = event.buildArchive([early, later], null, NOW)
  const fresh = { ...later, home: { ...later.home, score: 3 }, broadcast: [], eventId: '', eventStart: '', eventEnd: '', winnerId: '' }
  let cloudAt = '2026-10-16T03:00:00Z', clock = NOW + 2 * 3600000
  const cloud = { isReady: () => true, cloud: { database: { from: table => ({ select() { return this }, eq() { return this },
    maybeSingle: async () => ({ data: table === 'schedule_cache' ? {
      data: [fresh], meta: { generatedAt: cloudAt, categories: [], competitions: [] },
    } : null }) }) } } }
  const filename = path.join(__dirname, '../utils/data.js'), real = createRequire(filename)
  class Clock extends Date { static now() { return clock } }
  const data = load('utils/data.js', { Date: Clock, require: name => name === './cloud' ? cloud
    : name === '../data/tennis-events' ? archive : name === '../data/matches.js' ? encodeSnapshot([later])
      : name === '../data/meta.js' ? { generatedAt: '2026-10-15T00:00:00Z', categories: [], competitions: [] } : real(name) })
  assert.equal(data.matches().length, 1)
  assert.equal((await data.refresh()).updated, true)
  assert.equal(data.matches().length, 1)
  assert.equal(data.findMatch(early.id).id, early.id)
  assert.equal(data.findMatch(later.id).home.score, 2, 'older main snapshots must not overwrite fresher full-event results')
  cloudAt = '2026-10-16T05:00:00Z'
  clock += 6 * 60000
  assert.equal((await data.refresh()).updated, true)
  const eventRows = data.tennisEventMatches(event.identity(early).key)
  assert.equal(eventRows.length, 2)
  assert.equal(eventRows.find(m => m.id === later.id).home.score, 3)
  assert.deepEqual(Array.from(eventRows.find(m => m.id === later.id).broadcast), ['咪咕'])
})

test('progression uses player identity rather than match time and refuses unknown or conflicting links', () => {
  const q1 = match('1', 'Quarterfinal', '1', '2', '1')
  const q2 = match('2', 'Quarterfinal', '3', '4', '3')
  const q3 = match('3', 'Quarterfinal', '5', '6', '5')
  const q4 = match('4', 'Quarterfinal', '7', '8', '7')
  const s1 = match('s1', 'Semifinal', '5', '1', '1')
  const s2 = match('s2', 'Semifinal', '7', '3', '7')
  const final = match('f', 'Final', '7', '1', '1')
  const tree = bracket.build(bracket.tennisEntries([q1, q2, q3, q4, s1, s2, final]))
  assert.equal(tree.confirmed, 6)
  assert.equal(tree.champion, 'Player 1')
  const edges = bracket.confirmedLinks(tree.columns)
  assert.ok(edges.some(e => e.from === q1.id && e.to === s1.id))
  assert.ok(edges.some(e => e.from === q2.id && e.to === s2.id))
  const pending = bracket.build(bracket.tennisEntries([q1, q2, match('s', 'Semifinal', '-3', '-4')]))
  assert.equal(pending.confirmed, 0)
  assert.ok(pending.nodes.every(node => Number.isFinite(node.top)))
  const conflicting = bracket.build(bracket.tennisEntries([q1, s1, { ...s2, home: { id: '1', name: 'Duplicate' } }]))
  assert.equal(conflicting.confirmed, 0)
})

test('the generic graph retains a series match list and only completed series have winning sides', () => {
  const tree = bracket.build([{ id: 'series-1', matchIds: ['nba-1', 'nba-2'], round: { order: 1, label: '分区半决赛' },
    sides: [{ id: 'a', name: 'A', score: 2 }, { id: 'b', name: 'B', score: 1 }], status: 'live', winnerId: '' }])
  assert.equal(tree.nodes[0].matchIds.length, 2)
  assert.ok(tree.nodes[0].sides.every(side => !side.win))
})

test('a complete event spans all available rounds without overlapping cards in any round', () => {
  const china = [match('1', 'Round 1', '1', '2', '1'), match('2', 'Round 1', '3', '4', '3'),
    match('3', 'Round 1', '5', '6', '5'), match('4', 'Round 1', '7', '8', '7'),
    match('s1', 'Semifinal', '1', '3', '1'), match('s2', 'Semifinal', '5', '7', '5'), match('f', 'Final', '1', '5', '1')]
  const tree = bracket.build(bracket.tennisEntries(china))
  assert.equal(tree.nodes.length, 7)
  assert.equal(tree.columns.length, 3)
  assert.equal(tree.confirmed, 6)
  tree.columns.forEach(col => {
    const sorted = col.nodes.slice().sort((a, b) => a.top - b.top)
    sorted.slice(1).forEach((node, i) => assert.ok(node.top - sorted[i].top >= tree.nodeHeight, `${col.label} nodes overlap`))
  })
})

test('event page combines ATP/WTA court schedules, filters courts and keeps the complete tree independent of schedule filters', () => {
  const atp = [match('1', 'Round 1', '1', '2', '1'), match('2', 'Round 2', '1', '3', '1', { venue: 'Beijing, China PR · Capital Group Diamond' }), match('3', 'Final', '1', '4')]
  const wta = [ { ...match('4', 'Round 1', '5', '6', '5'), id: 'wta-4', comp: 'wta' } ]
  const rows = atp.concat(wta)
  let spec
  const fixtures = {
    tennisEvents: () => event.eventsOf(rows), tennisEventMatches: key => rows.filter(m => event.identity(m).key === key),
    tennisEventForMatch: event.identity, findMatch: id => rows.find(m => m.id === id),
    compOf: comp => ({ name: comp.toUpperCase(), cat: 'tennis', accent: '#1c6b45' }), generatedAt: () => '',
    tennisTournamentLevel: (comp, name, date) => date === '2026-10-10' ? `${comp.toUpperCase()} ${comp === 'atp' ? 500 : 1000}` : '',
    needsLivePoll: () => false, matchHasTeam: () => false,
  }
  const real = createRequire(path.join(__dirname, '../pages/tournament/tournament.js'))
  load('pages/tournament/tournament.js', { Page: value => { spec = value }, wx: { setNavigationBarTitle() {} },
    require: name => name.endsWith('/data') ? fixtures : name.endsWith('/team-follows') ? { asFilter: () => [] } : real(name) })
  const page = { ...spec, data: { ...spec.data }, setData(patch, cb) { Object.assign(this.data, patch); if (cb) cb() } }
  page.onLoad({ event: encodeURIComponent(event.identity(atp[0]).key) })
  page.build()
  assert.equal(page.data.total, 4)
  assert.equal(page.data.activeTour, 'all')
  assert.ok(page.data.event.levelLabel.includes('ATP 500'))
  assert.ok(page.data.event.levelLabel.includes('WTA 1000'))
  assert.equal(page.data.courts[0].name, '钻石球场')
  page.onCourt({ currentTarget: { dataset: { key: 'Lotus' } } })
  assert.equal(page.data.total, 3)
  page.onStatus({ currentTarget: { dataset: { key: 'upcoming' } } })
  assert.equal(page.data.total, 1)
  page.onTab({ currentTarget: { dataset: { key: 'bracket' } } })
  assert.equal(page.data.activeTour, 'atp')
  assert.equal(page.data.bracket.nodes.length, 3)
  assert.ok(page.onShareAppMessage().path.includes('tab=bracket'))
  const autoZoomLabel = page.data.zoomLabel
  page.onZoom({ currentTarget: { dataset: { step: '-0.2' } } })
  assert.equal(page.data.zoomLabel, autoZoomLabel - 20)
  assert.equal(page.data.autoFit, false)
  page.onBracketSwipe({detail:{current:1}})
  assert.equal(page.data.bracketIndex, 1)
  assert.equal(page.data.autoFit, true)
  page.onBracketRound({currentTarget:{dataset:{index:2}}})
  assert.equal(page.data.bracketIndex,1, 'tapping the final keeps the preceding round visible')
  assert.match(page.onShareAppMessage().path,/round=2/)
  page.onLoad({event:encodeURIComponent(event.identity(atp[0]).key),tab:'bracket',tour:'atp',round:'2'})
  page.build()
  assert.equal(page.data.bracketIndex,1, 'shared bracket reopens on the selected pair')
  page.onTour({ currentTarget: { dataset: { key: 'wta' } } })
  assert.ok(page.onShareAppMessage().path.includes('event=wta%7Cfixture-2026'))
  assert.ok(page.onShareAppMessage().path.includes('tour=wta'))
})
