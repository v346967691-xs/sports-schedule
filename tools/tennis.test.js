const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')

function load(file, overrides = {}) {
  const filename = path.join(__dirname, file)
  const box = { __dirname: path.dirname(filename), __filename: filename,
    require: createRequire(filename), module: { exports: {} }, console,
    process: { argv: [], env: {} }, Date, setTimeout, clearTimeout,
    AbortController, AbortSignal, ...overrides }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), box, { filename })
  return box
}

test('tennis scores count won sets and never turn absent results into zero', () => {
  const { tennisScore } = require('./sync')
  assert.equal(tennisScore({}), null)
  assert.equal(tennisScore({ score: '' }), null)
  assert.equal(tennisScore({ score: '0' }), 0)
  assert.equal(tennisScore({ linescores: [{ value: 6, winner: true }, { value: 4, winner: false }, { value: 7, winner: true }] }), 2)
})

test('Chinese player follows keep name matching through mine and schedule filters without crossing tours', () => {
  const data = require('../utils/data')
  const match = { comp: 'atp', home: { id: '11382', name: 'Yunchaokete Bu' }, away: { id: 'other', name: 'Other Player' } }
  const player = { comp: 'atp', id: 'cn-atp-bu-yunchaokete', name: 'Bu Yunchaokete', abbr: 'Bu Yunchaokete', display: '布云朝克特' }
  const storage = new Map()
  const follows = load('../utils/team-follows.js', {
    wx: { getStorageSync: key => storage.get(key), setStorageSync: (key, value) => storage.set(key, value) },
    require: name => name === './data' ? data : { isReady: () => false },
  }).module.exports
  follows.toggle(player)
  assert.equal(data.matchHasTeam(match, follows.asFilter()[0]), true)
  assert.equal(data.matchHasTeam({ ...match, comp: 'wta' }, follows.asFilter()[0]), false)
  let page
  const app = { globalData: {} }
  load('../pages/mine/mine.js', { Page: value => { page = value }, wx: { switchTab() {} },
    require: name => name.endsWith('/app-instance') ? { appInstance: () => app } : {} })
  page.data.teams = [player]
  page.onTeamTap({ currentTarget: { dataset: { index: 0 } } })
  assert.equal(data.matchHasTeam(match, app.globalData.pendingTeam), true)
})

test('tennis live discovery aligns home/away and deduplicates whole-tournament responses across date requests', async () => {
  const makeGame = (id, state = 'in') => ({ id, date: new Date(Date.now() - 60000).toISOString(),
    status: { period: 2, type: { state } }, round: { displayName: 'Round of 16' },
    competitors: [
      { id: 'away', homeAway: 'away', linescores: [{ value: 4, winner: false }, { value: 2, winner: false }] },
      { id: 'home', homeAway: 'home', linescores: [{ value: 6, winner: true }, { value: 3, winner: false }] },
    ] })
  let requests = 0
  const box = load('./live-watch.js', { fetch: async url => {
    requests += 1
    const tour = url.includes('/wta/') ? 'wta' : 'atp'
    const group = tour === 'atp' ? 'mens-singles' : 'womens-singles'
    const main = makeGame(tour + '-main'), final = makeGame(tour + '-final', 'post')
    const qualifying = { ...makeGame('qualifier'), round: { displayName: 'Qualifying' } }
    return { ok: true, json: async () => ({ events: [
      { id: tour === 'wta' ? '970-2026' : '315-2026', groupings: [{ grouping: { slug: group }, competitions: [main, final, qualifying] }] },
      ...(tour === 'wta' ? [{ id: 'not-tour-2026', groupings: [{ grouping: { slug: group }, competitions: [makeGame('itf')] }] }] : []),
    ] }) }
  } })
  const rows = await box.module.exports.scanTennis()
  assert.ok(requests >= 2)
  assert.equal(rows.length, 4)
  for (const row of rows) {
    assert.equal(row.hs, 1)
    assert.equal(row.as, 0)
    assert.deepEqual(Array.from(row.ls.h), [6, 3])
    assert.deepEqual(Array.from(row.ls.a), [4, 2])
  }
  assert.equal(rows.filter(row => row.st === 'finished').length, 2)
})

test('tennis set tables survive snapshot encoding and missing set values stay missing', () => {
  const { encodeSnapshot, decodeSnapshot } = require('../utils/snapshot')
  let page
  const detail = load('../pages/detail/detail.js', { Page: value => { page = value }, require: () => ({}) }).module.exports
  const match = { id: 'atp-fixture', comp: 'atp', start: '2026-10-15T12:00:00Z', status: 'live',
    home: { id: '1', name: 'A', score: 1 }, away: { id: '2', name: 'B', score: 0 }, sets: { h: [6, 3], a: [4, null] } }
  const decoded = decodeSnapshot(encodeSnapshot([match]))[0]
  assert.deepEqual(decoded.sets, match.sets)
  const table = detail.buildTennisSets(decoded, side => decoded[side].name)
  assert.deepEqual(Array.from(table.rows[1].scores), ['4', '-'])
})

test('idle tennis tours discover a newly live match on the next minute without waiting five rounds', async () => {
  let clock = Date.now(), round = 1
  const writes = []
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [clock])) }
    static now() { return clock }
  }
  const realRequire = createRequire(path.join(__dirname, 'live-watch.js'))
  const database = { from: () => ({
    select: () => ({ eq: () => ({ maybeSingle: async () => ({ data: { data: {} } }) }) }),
    upsert: async value => { writes.push(value.data.rows); return {} },
  }) }
  const box = load('./live-watch.js', {
    Date: Clock, process: { argv: ['node', 'live-watch', '--only=tennis', '--minutes=1.5', '--every=60'], env: {} },
    setTimeout: (fn, ms) => { if (ms === 60000) { clock += 60000; round += 1; fn() } return 0 },
    clearTimeout() {},
    require: name => name === '@tencent-ai/workbuddy-cloud-sdk' ? { createWorkBuddyCloud: () => ({ database }) } : realRequire(name),
    fetch: async () => ({ ok: true, json: async () => ({ data: {}, events: round === 1 ? [] : [{ id: '970-2026', groupings: [{
      grouping: { slug: 'womens-singles' }, competitions: [{ id: 'new-start', date: new Date(clock).toISOString(),
        status: { period: 1, type: { state: 'in' } }, competitors: [
          { homeAway: 'home', linescores: [{ value: 1, winner: false }] },
          { homeAway: 'away', linescores: [{ value: 0, winner: false }] },
        ] }],
    }] }] }) }),
  })
  await box.module.exports.main()
  assert.equal(writes.length, 2)
  assert.equal(writes[0].length, 0)
  assert.equal(writes[1][0].id, 'wta-new-start')
  assert.equal(box.process.exitCode, undefined)
})

test('tennis single matches use existing subscription rounds and sport-correct result summaries', () => {
  const config = require('../utils/match-notification-config')
  const { summary, compZh } = require('./brief-write')
  const match = { comp: 'wta', start: new Date(Date.now() + 7200000).toISOString(), status: 'upcoming',
    home: { name: '郑钦文', score: 2 }, away: { name: '王欣瑜', score: 0 } }
  assert.deepEqual(config.kindsFor(match), ['pre15', 'result'])
  assert.deepEqual(config.kindsFor({ ...match, status: 'live' }), ['result'])
  assert.equal(summary({ ...match, status: 'finished' }), '郑钦文以2-0战胜王欣瑜')
  assert.equal(summary({ ...match, status: 'finished', home: { name: '郑钦文', score: 0 } }), '比赛已结束，赛果待确认')
  assert.notEqual(compZh('atp'), 'atp')
  assert.notEqual(compZh('wta'), 'wta')
})
