const test = require('node:test')
const assert = require('node:assert/strict')
const model = require('../pages/worlds-swiss/swiss-model')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

function match(id, home, away, day = 24, extra = {}) {
  return { id, comp: 'worlds', stage: '全球总决赛 · 瑞士轮', date: `2026-10-${day}`, time: '01:00',
    start: `2026-10-${day}T01:00:00+08:00`, bo: 1, status: 'upcoming',
    home: { id: home, name: home, score: null, wins: 0, losses: 0 },
    away: { id: away, name: away, score: null, wins: 0, losses: 0 }, ...extra }
}
function firstRound(finished = false) {
  return Array.from({ length: 8 }, (_, i) => {
    const m = match(`worlds-${i}`, `H${i}`, `A${i}`)
    if (finished) { m.status = 'finished'; m.home.score = 1; m.away.score = 0 }
    return m
  })
}

test('first-round official pairs fill eight slots; later draws remain structural placeholders', () => {
  const rows = firstRound(), before = JSON.stringify(rows)
  rows.push(match('future', 'TBD', 'TBD', 25))
  const result = model.build(rows)
  assert.equal(result.published, 8)
  assert.equal(result.rounds[0].groups[0].matches.length, 8)
  assert.deepEqual(result.rounds.map(r => r.groups.reduce((n, g) => n + g.slots, 0)), [8, 8, 8, 6, 3])
  assert.ok(result.rounds.slice(1).every(r => r.groups.every(g => !g.matches.length)))
  assert.equal(JSON.stringify(rows.slice(0, 8)), before)
  assert.equal(result.rounds[0].groups[0].matches[0].hasScore, false)
})

test('complete history assigns rounds across days by series wins, never by map scores or dates', () => {
  const rows = firstRound(true)
  // Official schedule records can change after the game; historical results remain authoritative.
  for (const m of rows) { m.home.wins = 2; m.home.losses = 0; m.away.wins = 0; m.away.losses = 2 }
  rows.push(match('worlds-r2w', 'H0', 'H1', 25, { status: 'finished', home: { id: 'H0', score: 1 }, away: { id: 'H1', score: 0 } }))
  rows.push(match('worlds-r2w2', 'H2', 'H3', 25, { status: 'finished', home: { id: 'H2', score: 1 }, away: { id: 'H3', score: 0 } }))
  rows.push(match('worlds-r3', 'H0', 'H2', 27, { bo: 3, status: 'finished', home: { id: 'H0', score: 2 }, away: { id: 'H2', score: 1 } }))
  const result = model.build(rows)
  assert.equal(result.rounds[1].groups.find(g => g.key === '1-0').matches.length, 2)
  assert.equal(result.rounds[2].groups.find(g => g.key === '2-0').matches[0].id, 'worlds-r3')
  assert.equal(result.qualified[0].id, 'H0')
  assert.equal(result.qualified[0].record, '3–0')
})

test('missing history, tied finals, duplicate IDs and other stages cannot fabricate advancement', () => {
  const incomplete = [match('later', 'H', 'A', 29, { status: 'finished', home: { id: 'H', score: 2 }, away: { id: 'A', score: 1 }, bo: 3 })]
  assert.equal(model.build(incomplete).unplaced.length, 1)
  const rows = firstRound(true)
  rows[0].home.score = 0
  rows.push(match('unknown-next', 'H0', 'H1', 25, { home: { id: 'H0' }, away: { id: 'H1' } }))
  const result = model.build(rows.concat(rows[1], match('knockout', 'X', 'Y', 29, { stage: '全球总决赛 · 八强赛' })))
  assert.equal(result.published, 9)
  assert.ok(result.unplaced.some(m => m.id === 'unknown-next'))
  assert.equal(result.qualified.length, 0)
})

test('upcoming pairs can use equal official records; unequal or impossible records remain unplaced', () => {
  const m = match('later', 'X', 'Y', 30, { home: { id: 'X', wins: 2, losses: 1 }, away: { id: 'Y', wins: 2, losses: 1 } })
  assert.equal(model.build([m]).rounds[3].groups[0].matches[0].id, 'later')
  m.away.losses = 2
  assert.equal(model.build([m]).unplaced.length, 1)
})

test('page focuses a detail-linked match after cloud data arrives, shares the selected round, and stops hidden requests', async () => {
  const file = path.resolve(__dirname, '../pages/worlds-swiss/worlds-swiss.js'), actual = createRequire(file)
  let page, rows = [], reads = 0, liveReads = 0, clock = Date.now(), cleared = 0, destination
  class Clock extends Date { static now() { return clock } }
  const data = { meta: {}, generatedAt: () => new Date(clock).toISOString(), query: () => rows,
    refresh: async () => { reads++; rows = firstRound(true).concat(match('focus-r2', 'H0', 'H1', 25)) },
    loadWorldsArchive: async () => [], refreshLive: async () => { liveReads++ }, needsLivePoll: m => m.status === 'live' }
  vm.runInNewContext(fs.readFileSync(file, 'utf8'), { Page: p => { page = p }, console, Date: Clock,
    require: n => n.endsWith('/data') ? data : actual(n), setInterval: () => 1, clearInterval: () => { cleared++ },
    wx: { navigateTo: o => { destination = o.url }, stopPullDownRefresh() {}, getWindowInfo: () => ({ windowWidth: 375 }) } })
  page.setData = values => Object.assign(page.data, values)
  page.onLoad({ id: 'focus-r2' }); page.onShow(); await page.refreshing
  assert.equal(page.data.activeRound, 2)
  assert.equal(page.data.scrollTarget, 'swiss-round-2')
  assert.equal(reads, 1); assert.equal(liveReads, 1)
  page.tick(); assert.equal(liveReads, 1, 'future pairs must not cause minute requests')
  page.onRoundTap({ currentTarget: { dataset: { round: '4' } } })
  assert.match(page.onShareAppMessage().path, /round=4/)
  page.onBoardScroll({ detail: { scrollLeft: 287 * 4 } })
  assert.equal(page.data.activeRound, 5)
  assert.match(page.onShareAppMessage().path, /round=5/)
  page.goDetail({ currentTarget: { dataset: { id: 'focus-r2' } } })
  assert.match(destination, /detail\?id=focus-r2/)
  clock += 15 * 60000; page.tick(); await page.refreshing
  assert.equal(reads, 2)
  page.onHide(); page.tick(); assert.equal(reads, 2); assert.equal(cleared, 1)
})

test('both entries navigate to the same registered subpackage; detail preserves the focused match', () => {
  const app = require('../app.json')
  assert.ok(app.subPackages.some(p => p.root === 'pages/worlds-swiss' && p.pages.includes('worlds-swiss')))
  for (const name of ['worlds', 'detail']) {
    const file = path.resolve(__dirname, `../pages/${name}/${name}.js`), actual = createRequire(file)
    let page, destination
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), { Page: p => { page = p }, console, module: { exports: {} },
      require: actual, wx: { navigateTo: o => { destination = o.url } } })
    page.data.match = { id: 'worlds-focus' }; page.goSwiss()
    assert.ok(destination.startsWith('/pages/worlds-swiss/worlds-swiss'))
    if (name === 'detail') assert.match(destination, /id=worlds-focus/)
  }
})

test('draw-only revisions refresh clients without advancing the global snapshot timestamp or accepting older full snapshots', async () => {
  const file = path.resolve(__dirname, '../utils/data.js'), actual = createRequire(file)
  const base = Date.now() - 2 * 3600000, previous = Date.now() - 5 * 60000
  for (const [full, draw, expected] of [[base, previous + 60000, true], [base, previous - 60000, false], [base - 60000, previous + 60000, false]]) {
    const oldMeta = { generatedAt: new Date(base).toISOString(), worldsRefreshedAt: new Date(previous).toISOString(), categories: [], competitions: [] }
    const reply = { data: [match('draw-match', 'AL', 'KC')], meta: { ...oldMeta, generatedAt: new Date(full).toISOString(), worldsRefreshedAt: new Date(draw).toISOString() } }
    const cloud = { isReady: () => true, cloud: { database: { from: table => ({ select() { return this }, eq() { return this },
      async maybeSingle() { return table === 'schedule_cache' ? { data: reply } : { data: null } } }) } } }
    const box = { module: { exports: {} }, console, Date,
      require: n => n === './cloud' ? cloud : n === '../data/meta.js' ? oldMeta : n === '../data/matches.js' ? [match('draw-match', 'TBD', 'TBD')] : actual(n) }
    vm.runInNewContext(fs.readFileSync(file, 'utf8'), box, { filename: file })
    const data = box.module.exports, result = await data.refresh()
    assert.equal(result.updated, expected)
    assert.equal(data.generatedAt(), oldMeta.generatedAt)
    assert.equal(data.findMatch('draw-match').home.id, expected ? 'AL' : 'TBD')
  }
})
