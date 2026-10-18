const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const vm = require('node:vm')
const { createRequire } = require('node:module')
const watch = require('./live-watch')
const now = Date.parse('2026-10-18T14:45:00Z')
const final = { id: 'csl-401861482', st: 'finished', stt: '已结束', hs: 3, as: 0 }

test('converged leagues retain verified finals without refreshing their observation time', () => {
  const previous = { generatedAt: new Date(now - 60000).toISOString(), rows: [final] }
  const rows = watch.retainFinalRows([], previous, now)
  assert.equal(rows.length, 1)
  assert.equal(rows[0].at, previous.generatedAt)
  assert.equal(rows[0].hs, 3)
  const repeated = watch.retainFinalRows([], { generatedAt: new Date(now).toISOString(), rows }, now + 60000)
  assert.equal(repeated[0].at, previous.generatedAt)
  assert.equal(previous.rows[0].at, undefined)
})

test('new official rows override retained finals, including corrections and reopened games', () => {
  for (const st of ['live', 'finished', 'upcoming']) {
    const current = { ...final, st, hs: 4 }
    const rows = watch.retainFinalRows([current], { generatedAt: new Date(now).toISOString(), rows: [final] }, now)
    assert.equal(rows.length, 1)
    assert.equal(rows[0].hs, 4)
    assert.equal(rows[0].st, st)
  }
})

test('retention drops expired, invalid and future evidence and never carries missing live matches', () => {
  for (const age of [16 * 60000, -120000, NaN]) {
    const generatedAt = Number.isFinite(age) ? new Date(now - age).toISOString() : 'invalid'
    assert.equal(watch.retainFinalRows([], { generatedAt, rows: [final] }, now).length, 0)
  }
  for (const row of [{ ...final, st: 'live' }, { ...final, hs: null }, { ...final, as: -1 }]) {
    assert.equal(watch.retainFinalRows([], { generatedAt: new Date(now).toISOString(), rows: [row] }, now).length, 0)
  }
})

test('real loop keeps the CSL final while scanning only the active league, without extra writes or sources', async () => {
  for (const failFirst of [false, true]) {
  const filename = path.join(__dirname, 'live-watch.js'), actual = createRequire(filename)
  let time = now, scans = 0, lastRows
  const writes = [], scanned = []
  class Clock extends Date { static now() { return time } }
  const query = { select() { return this }, eq() { return this }, async maybeSingle() { return { data: null } } }
  const box = { module: { exports: {} }, __dirname, __filename: filename, Date: Clock,
    process: { argv: ['node', filename, '--only=csl,epl', '--minutes=3', '--every=60'], env: {} },
    console: { log() {}, warn() {}, error() {} }, AbortSignal, AbortController,
    setTimeout: fn => { time += 60000; fn() }, clearTimeout,
    require: n => n === '@tencent-ai/workbuddy-cloud-sdk' ? { createWorkBuddyCloud: () => ({ database: { from: () => query } }) } : actual(n),
    scanStub: async comps => {
      scanned.push(Array.from(comps, c => c.key)); scans++
      lastRows = [{ id: 'epl-active', st: 'live', hs: 0, as: 0 }, ...(scans === 1 ? [final] : [])]
      return { rows: lastRows, liveComps: ['epl'] }
    }, cbaStub: async () => ({ rows: [], near: false }),
    pushStub: async (_, rows) => { writes.push(JSON.parse(JSON.stringify(rows))); return !failFirst || writes.length > 1 },
  }
  vm.createContext(box)
  vm.runInContext(fs.readFileSync(filename, 'utf8'), box, { filename })
  vm.runInContext('scan = scanStub; scanCba = cbaStub; push = pushStub', box)
  await box.module.exports.main()
  assert.ok(scans > 1)
  assert.ok(scanned[0].includes('csl'))
  assert.ok(scanned.slice(1).every(keys => !keys.includes('csl')))
  assert.equal(writes.length, failFirst ? 2 : 1, 'only retry a failed write; timestamps must not defeat deduplication')
  assert.equal(lastRows.find(r => r.id === final.id).hs, 3)
  const dataFile = path.resolve(__dirname, '../utils/data.js'), dataRequire = createRequire(dataFile)
  const livePayload = { data: { rows: lastRows }, generated_at: new Date(time).toISOString() }
  const cloud = { isReady: () => true, cloud: { database: { from: () => ({ select() { return this }, eq() { return this }, maybeSingle: async () => ({ data: livePayload }) }) } } }
  const client = { module: { exports: {} }, console, Date: Clock,
    require: n => n === './cloud' ? cloud : n === '../data/meta.js' ? { generatedAt: new Date(now - 80 * 60000).toISOString(), competitions: [], categories: [] }
      : n === '../data/matches.js' ? [{ id: final.id, comp: 'csl', status: 'live', statusText: "63'", home: { score: 1 }, away: { score: 0 } }] : dataRequire(n) }
  vm.runInNewContext(fs.readFileSync(dataFile, 'utf8'), client, { filename: dataFile })
  await client.module.exports.refreshLive()
  const match = client.module.exports.findMatch(final.id)
  assert.equal(match.status, 'finished')
  assert.equal(match.statusText, '已结束')
  assert.equal(match.home.score, 3)
  }
})
