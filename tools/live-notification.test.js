const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const path = require('node:path')
const writer = require('./brief-write')

function match(comp, hs, as, options = {}) {
  return { comp, status: 'finished', bo: '5',
    home: { zh: 'AL', abbr: 'AL', score: hs }, away: { zh: 'T1', abbr: 'T1', score: as }, ...options }
}

test('notification summaries share the daily brief narrative with sport-correct wording', () => {
  const thriller = match('worlds', 3, 2)
  assert.equal(writer.narrative(thriller).key, 'thriller')
  assert.equal(writer.summary(thriller), 'AL打满五局力克T1')
  assert.equal(writer.summary(match('kpl', 4, 3, { bo: '7' })), 'AL打满七局力克T1')
  assert.equal(writer.summary(match('worlds', 3, 0)), 'AL3-0零封T1')
  assert.equal(writer.summary(match('worlds', 3, 1)), 'AL3-1击败T1')
  assert.equal(writer.summary(match('ucl', 0, 0)), 'AL与T1互交白卷')
  assert.equal(writer.summary(match('ucl', 1, 1)), 'AL1-1战平T1')
  assert.equal(writer.summary(match('nba', 112, 110)), 'AL112-110险胜T1')
  assert.equal(writer.summary(match('ucl', 1, 4, {
    home: { zh: '加拉塔萨雷', score: 1 }, away: { zh: '巴塞罗那', score: 4 },
  })), '巴塞罗那4-1大胜加拉塔萨雷')
  for (const comp of ['ucl', 'nba', 'worlds', 'kpl']) {
    assert.doesNotMatch(writer.summary(match(comp, 3, 1)), /逆转|绝杀|进球者|已结束/)
  }
})

test('summary shortens complete sentences without cutting names or guessing missing results', () => {
  const long = match('worlds', 3, 2, {
    home: { name: 'Team With An Extremely Long Name', abbr: 'ABC', score: 3 },
    away: { name: 'Another Team With An Extremely Long Name', abbr: 'DEF', score: 2 },
  })
  assert.equal(writer.summary(long), 'ABC打满五局力克DEF')
  delete long.home.abbr; delete long.away.abbr
  assert.equal(writer.summary(long), '打满五局，主队3-2取胜')
  assert.ok(Array.from(writer.summary(long)).length <= 20)
  assert.equal(writer.summary(match('ucl', null, 1)), '赛果数据待补齐')
  assert.equal(writer.summary(match('ucl', 1, 0, { status: 'live' })), '赛果数据待补齐')
  assert.equal(writer.summary(match('ucl', 0, 0, { statusText: '已延期' })), '比赛延期，等待新赛程')
  assert.equal(writer.summary(match('ucl', 3, 2, { statusText: '点球大战' })), 'AL点球战胜T1')
  assert.equal(writer.summary(match('ucl', 1, 1, { statusText: '点球大战' })), '双方经点球大战决出胜负')
})

async function liveLoop({ flags = ['--notify'], rounds = 1, pushFails = false, notifyFails = false } = {}) {
  const filename = path.join(__dirname, 'live-watch.js')
  const requireActual = createRequire(filename)
  const events = [], logs = []
  let time = Date.parse('2026-10-14T00:00Z'), scans = 0
  class Clock extends Date { static now() { return time } }
  const cloud = { database: { from() {
    const query = { select: () => query, eq: () => query, maybeSingle: async () => ({ data: null }) }
    return query
  } } }
  const box = {
    module: { exports: {} }, __dirname, __filename: filename,
    process: { argv: ['node', filename, '--only=ucl', '--every=60', '--minutes=1',
      ...(rounds === 1 ? ['--once'] : []), ...flags], env: {} },
    console: { log: (...args) => logs.push(args), warn: (...args) => logs.push(args), error: (...args) => logs.push(args) },
    Date: Clock, AbortSignal, AbortController,
    setTimeout: callback => { time += 60000; callback() }, clearTimeout,
    require: name => {
      if (name === '@tencent-ai/workbuddy-cloud-sdk') return { createWorkBuddyCloud: () => cloud }
      if (name === './match-notification-push') return { main: async () => {
        events.push('notify')
        if (notifyFails && events.filter(e => e === 'notify').length === 1) throw new Error('stub transient failure')
        return { processed: 0, sent: 0 }
      } }
      return requireActual(name)
    },
    scanStub: async () => { scans++; return { rows: [{ id: 'ucl-123', st: 'finished', hs: 1, as: 4 }], liveComps: ['ucl'] } },
    cbaStub: async () => ({ rows: [], near: false }),
    pushStub: async () => { events.push('publish'); return !pushFails },
  }
  vm.createContext(box)
  vm.runInContext(fs.readFileSync(filename, 'utf8'), box, { filename })
  vm.runInContext('scan = scanStub; scanCba = cbaStub; push = pushStub', box)
  await box.module.exports.main()
  return { events, logs, scans, exitCode: box.process.exitCode }
}

test('live loop publishes final scores before checking notifications, including unchanged rounds', async () => {
  const result = await liveLoop({ rounds: 2 })
  assert.equal(result.scans, 2)
  assert.deepEqual(result.events, ['publish', 'notify', 'notify'])
  assert.equal(result.exitCode, undefined)
})

test('notification failures are reported while score refresh and the next delivery check continue', async () => {
  const result = await liveLoop({ rounds: 2, notifyFails: true })
  assert.equal(result.scans, 2)
  assert.deepEqual(result.events, ['publish', 'notify', 'notify'])
  assert.equal(result.exitCode, 2)
})

test('dry/default scans never consume consent, and failed score publication prevents delivery', async () => {
  for (const flags of [[], ['--notify', '--dry']]) {
    assert.deepEqual((await liveLoop({ flags })).events, ['publish'])
  }
  const failed = await liveLoop({ pushFails: true })
  assert.deepEqual(failed.events, ['publish'])
  assert.equal(failed.exitCode, 2)
})
