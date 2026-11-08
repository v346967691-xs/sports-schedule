const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')

test('retired 15-minute reminders cannot be requested, become due, or be sent by an old queue row', async () => {
  const config = require('../utils/match-notification-config')
  const core = require('../utils/match-notification-core')
  const worker = require('./match-notification-push')
  const now = Date.parse('2026-11-18T10:00:00Z')
  const match = { comp: 'nba', status: 'upcoming', start: new Date(now + 10 * 60000).toISOString() }
  assert.deepEqual(config.kindsFor(match, now), ['result'])
  assert.equal(config.templateId('pre15'), '')
  assert.equal(core.isDue(match, now, 'pre15'), false)
  assert.equal(core.isDue({ ...match, start: new Date(now + 40 * 60000).toISOString() }, now, 'pre60'), true)
  assert.equal(worker.expired(match, 'pre15', now), true)
  const calls = []
  const result = await worker.processRow({ database: { rpc: async (name, args) => {
    calls.push({ name, args }); return { data: 1 }
  } } }, 'token', { kind: 'pre15', match_data: match }, {}, 'unused', 'formal', now)
  assert.equal(result, 'expired')
  assert.equal(calls.length, 1)
  assert.equal(calls[0].args.p_status, 'expired')
})

test('30-minute cadence accepts newer last-known scores through 45 minutes without accepting rollback or future data', async () => {
  const filename = path.resolve(__dirname, '../utils/data.js'), req = createRequire(filename)
  const now = Date.parse('2026-11-18T10:00:00Z')
  class Clock extends Date {
    constructor(...args) { super(...(args.length ? args : [now])) }
    static now() { return now }
  }
  for (const [age, expected] of [[14, 1], [22, 1], [44, 1], [46, 0], [81, 0], [-2, 0]]) {
    const match = { id: 'nba-1', comp: 'nba', status: 'live', start: new Date(now - 90 * 60000).toISOString(),
      home: { id: '7', score: 50 }, away: { id: '16', score: 40 } }
    let patchAt = now - age * 60000
    const cloud = { isReady: () => true, cloud: { database: { from: () => ({
      select() { return this }, eq() { return this }, maybeSingle: async () => ({ data: {
        generated_at: new Date(patchAt).toISOString(), data: { rows: [{ id: match.id, st: 'live', hs: 80, as: 77 }] },
      } }),
    }) } } }
    const box = { module: { exports: {} }, Date: Clock, console, require: id => id === './cloud' ? cloud
      : id === '../data/meta.js' ? { generatedAt: new Date(now - 80 * 60000).toISOString(), categories: [], competitions: [] }
      : id === '../data/matches.js' ? [match] : req(id) }
    vm.runInNewContext(fs.readFileSync(filename, 'utf8'), box, { filename })
    const data = box.module.exports
    assert.equal((await data.refreshLive(true)).patched, expected, `age=${age}`)
    assert.equal(data.matches()[0].home.score, expected ? 80 : 50)
    if (expected) {
      patchAt -= 60000
      assert.equal((await data.refreshLive(true)).patched, 0, 'older live revision must not roll back an accepted score')
    }
  }
})

test('a gap in collection is labelled as last-known data instead of presenting a stale match clock as live', () => {
  const view = require('../utils/view')
  const match = { comp: 'nba', status: 'live', statusText: '第三节 08:30', start: new Date().toISOString(),
    date: '2026-11-18', home: { id: '7', score: 80 }, away: { id: '16', score: 77 }, _liveAt: Date.now() - 22 * 60000 }
  const decorated = view.decorate(match)
  assert.equal(decorated._statusLabel, '比分待更新')
  assert.match(decorated._statusHint, /比分更新于/)
  assert.equal(decorated.home.score, 80)
  assert.equal(view.decorate({ ...match, _liveAt: Date.now() })._statusLabel, '第三节 08:30')
  assert.equal(view.decorate({ ...match, status: 'finished', statusText: '已结束' })._statusLabel, '已结束')
})
