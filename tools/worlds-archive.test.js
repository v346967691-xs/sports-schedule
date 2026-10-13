const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const archive = require('../utils/worlds-archive')
const at = Date.parse('2026-11-20T08:00:00+08:00')
const match = (id = 'worlds-123', start = '2026-10-15T08:00:00Z') => ({ id, comp: 'worlds', start, date: start.slice(0, 10), status: 'finished', home: { id: 'a', score: 1 }, away: { id: 'b', score: 0 } })
const detail = (m = match()) => ({ id: m.id, comp: m.comp, match: m, v: 6, fin: true, lol: { complete: true, playerVersion: 1, rounds: [] } })

function load(relative, replacements = {}, now = at) {
  const filename = path.join(__dirname, '..', relative)
  const real = createRequire(filename)
  class Clock extends Date { static now() { return now } }
  const clockArchive = { ...archive, archiveActive: (time = now) => archive.archiveActive(time), archivedEntry: (d, time = now) => archive.archivedEntry(d, time) }
  const custom = name => Object.hasOwn(replacements, name) ? replacements[name]
    : /(?:\.\/|\.\.\/utils\/)worlds-archive$/.test(name) ? clockArchive : real(name)
  custom.main = null
  const box = vm.createContext({ require: custom, module: { exports: {} }, __dirname: path.dirname(filename), __filename: filename,
    Date: Clock, console, process: { argv: [], env: {}, exit: () => {} }, setTimeout, clearTimeout, AbortController, Buffer, Set, Map })
  vm.runInContext(fs.readFileSync(filename, 'utf8'), box, { filename })
  return box
}

test('Worlds2026 date guard excludes historical Worlds and other leagues; expiry includes Beijing Dec15', () => {
  assert.equal(archive.isWorlds2026(match()), true)
  assert.equal(archive.isWorlds2026(match('worlds-old', '2025-10-20T08:00:00Z')), false)
  assert.equal(archive.isWorlds2026({ ...match(), comp: 'lpl' }), false)
  assert.equal(archive.isWorlds2026(match('worlds-1', '2026-11-15T16:00:00Z')), false)
  assert.equal(archive.archiveActive(Date.parse('2026-12-15T23:59:59+08:00')), true)
  assert.equal(archive.archiveActive(archive.ARCHIVE_UNTIL), false)
  assert.equal(archive.archiveDays(at).length, 32)
})

test('old mixed day bucket keeps only Worlds2026 with metadata; expiry prunes it', () => {
  const payload = { 'worlds-123': detail(), 'epl-9': { comp: 'epl' }, 'worlds-2025': detail(match('worlds-2025', '2025-10-15T00:00:00Z')) }
  assert.deepEqual(Object.keys(archive.prunePayload(payload, '20261015', at)), ['worlds-123'])
  assert.deepEqual(archive.prunePayload(payload, '20261015', archive.ARCHIVE_UNTIL), {})
  assert.equal(Object.keys(archive.prunePayload(payload, '20261120', at)).length, 3)
})

test('archive loader reads only bounded day buckets, coalesces requests and resolves old shares', async () => {
  let calls = 0
  const filters = []
  const cloud = { isReady: () => true, cloud: { database: { from: table => {
    assert.equal(table, 'match_detail')
    return { select() { return this }, gte(k, v) { filters.push([k, v]); return this }, lte(k, v) { filters.push([k, v]); return this },
      then(resolve) { calls++; return Promise.resolve({ data: [{ payload: { good: detail(), stale: detail(match('worlds-old', '2025-10-15T00:00:00Z')) } }] }).then(resolve) } }
  } } } }
  const box = load('utils/data.js', { './cloud': cloud })
  const data = box.module.exports
  const [a, b] = await Promise.all([data.loadWorldsArchive(), data.loadWorldsArchive()])
  assert.equal(a.length, 1)
  assert.equal(b.length, 1)
  assert.equal(calls, 1)
  assert.deepEqual(filters, [['day', '20261015'], ['day', '20261115']])
  assert.equal(data.findMatch('worlds-123').id, 'worlds-123')
  assert.equal((await data.findArchivedMatch('worlds-123')).id, 'worlds-123')
  assert.equal(await data.findArchivedMatch('epl-unknown'), null)
  assert.equal((await data.matchDetail(match())).lol.complete, true)
  assert.equal(calls, 1)
})

test('expired archive loader does not fetch or resolve an archived share', async () => {
  const box = load('utils/data.js', { './cloud': { isReady: () => { throw new Error('must not access cloud') } } }, archive.ARCHIVE_UNTIL)
  assert.equal((await box.module.exports.loadWorldsArchive()).length, 0)
  assert.equal(await box.module.exports.findArchivedMatch('worlds-123'), null)
})

test('sync metadata survives schedule eviction, prunes mixed history, excludes archives from bundle and avoids unchanged rewrites', async () => {
  const old = detail()
  const writes = {}
  const sdk = { createWorkBuddyCloud: () => ({ database: { from: () => ({ select: async () => ({ data: [
    { id: 'd-20261015', day: '20261015', payload: { 'worlds-123': old, 'epl-9': { comp: 'epl' } } },
    { id: 'd-20261016', day: '20261016', payload: { 'worlds-456': detail(match('worlds-456', '2026-10-16T08:00:00Z')) } },
  ] }) }) } }) }
  const fakeFs = { ...fs, writeFileSync: (file, contents) => { writes[file] = contents }, mkdirSync() {}, statSync: () => ({ size: 0 }) }
  const box = load('tools/match-detail.js', { fs: fakeFs, '@tencent-ai/workbuddy-cloud-sdk': sdk, '../data/matches.js': [], '../utils/snapshot': { decodeSnapshot: x => x } })
  await vm.runInContext('main()', box)
  const output = JSON.parse(writes[path.join(__dirname, '..', '.workbuddy', 'match-details-cloud.json')])
  assert.equal(output.archiveReadOk, true)
  assert.equal(output.buckets.length, 2)
  assert.deepEqual(Object.keys(output.buckets[0].payload), ['worlds-123'])
  assert.equal(output.buckets[0].changed, true)
  assert.equal(output.buckets[1].changed, false)
  const bundle = writes[path.join(__dirname, '..', 'data', 'match-details.js')]
  assert.ok(!bundle.includes('worlds-123'))
})

test('incomplete Worlds can be supplemented beyond 48h, while other LOL retain original retry window', () => {
  const box = load('tools/match-detail.js')
  const incomplete = { ...detail(), ts: 0, lol: { complete: false } }
  assert.equal(box.module.exports.needsFetch(match(), { 'worlds-123': incomplete }), true)
  const other = { ...match(), id: 'lpl-123', comp: 'lpl' }
  assert.equal(box.module.exports.needsFetch(other, { 'lpl-123': incomplete }), false)
})

test('cloud archive read failure never emits replacement buckets or a destructive cleanup artifact', async () => {
  let writes = 0
  const sdk = { createWorkBuddyCloud: () => ({ database: { from: () => ({ select: async () => ({ error: { message: 'read blocked' } }) }) } }) }
  const box = load('tools/match-detail.js', { fs: { ...fs, writeFileSync: () => { writes++ } }, '@tencent-ai/workbuddy-cloud-sdk': sdk,
    '../data/matches.js': [match()], '../utils/snapshot': { decodeSnapshot: x => x } })
  await vm.runInContext('main()', box)
  assert.equal(writes, 0)
})

test('cleanup excludes retained Worlds buckets, removes expiry exclusions and refuses incomplete reads', async () => {
  const cleanup = require('./cloud-sync').cleanupDetailBuckets
  const calls = []
  const cloud = { database: { from(table) { calls.push(['from', table]); return this }, delete() { calls.push(['delete']); return this },
    lt(k, v) { calls.push(['lt', k, v]); return this }, not(k, op, v) { calls.push(['not', k, op, v]); return this }, then(resolve) { return Promise.resolve({}).then(resolve) } } }
  const output = { archiveReadOk: true, buckets: [{ id: 'd-20261015', payload: { 'worlds-123': detail() } }] }
  await cleanup(cloud, output, at)
  assert.ok(calls.some(row => row[0] === 'not' && row[3] === '(d-20261015)'))
  calls.length = 0
  await cleanup(cloud, output, archive.ARCHIVE_UNTIL)
  assert.equal(calls.some(row => row[0] === 'not'), false)
  calls.length = 0
  await assert.rejects(cleanup(cloud, { archiveReadOk: false }, at), /未完整读回/)
  assert.equal(calls.length, 0)
})
