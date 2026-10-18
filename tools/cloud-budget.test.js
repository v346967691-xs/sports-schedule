const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const os = require('node:os')
const vm = require('node:vm')
const { createMeter } = require('./cloud-usage')
const { summarize } = require('./cloud-usage-summary')
const { forecast } = require('./quota-budget')
const { probe } = require('./cloud-health')

test('meter observes real SDK reads, writes and RPCs without logging private bodies or URL filters', async () => {
  const { createWorkBuddyCloud } = require('@tencent-ai/workbuddy-cloud-sdk')
  const config = require('../utils/cloud-config')
  const meter = createMeter(config.endpoint, async () => new Response('[{"id":"private-user"}]', { headers: { 'Content-Type': 'application/json' } }))
  const cloud = createWorkBuddyCloud({ ...config, fetch: meter.fetch })
  const result = await cloud.database.from('favorites').select('id').eq('owner_id', 'private-user')
  assert.equal(result.data[0].id, 'private-user')
  await cloud.database.from('live_scores').upsert({ id: 'latest', secret: 'private-token' })
  await cloud.database.rpc('claim_due_match_notifications', { p_token: 'private-token' })
  const report = meter.snapshot()
  assert.equal(report.operations['GET:favorites'].calls, 1)
  assert.equal(report.operations['POST:live_scores'].calls, 1)
  assert.equal(report.operations['rpc:claim_due_match_notifications'].calls, 1)
  assert.ok(report.operations['POST:live_scores'].requestBodyBytes > 0)
  assert.ok(report.operations['GET:favorites'].responseBodyBytes > 0)
  assert.doesNotMatch(JSON.stringify(report), /private-user|private-token|owner_id/)
})

test('meter passes unrelated fetch through and preserves HTTP/network failures', async () => {
  const meter = createMeter('https://cloud.example', async url => {
    if (String(url).includes('network')) throw Error('offline')
    return new Response('{}', { status: 503 })
  })
  const direct = await meter.fetch('https://upstream.example/stats')
  assert.equal(direct.status, 503)
  assert.deepEqual(meter.snapshot().operations, {})
  const response = await meter.fetch('https://cloud.example/.cloud/database/rest/live_scores')
  assert.equal(response.status, 503); await response.json()
  await assert.rejects(meter.fetch('https://cloud.example/.cloud/database/rest/network'), /offline/)
  assert.equal(meter.snapshot().operations['GET:live_scores'].failures, 1)
  assert.equal(meter.snapshot().operations['GET:network'].failures, 1)
})

test('diagnostic windows are unioned across overlapping processes, never added as separate CPU bills', () => {
  const result = summarize([{ databaseRequestWindows: [1,2], operations: { 'GET:x': { calls: 2 } } },
    { databaseRequestWindows: [2,3], operations: { 'GET:x': { calls: 3 } } }])
  assert.equal(result.observedFiveMinuteWindows, 3)
  assert.equal(result.operations['GET:x'].calls, 5)
})

const cycle = { limit: 50000, start: '2026-10-05T00:00:00+08:00', end: '2026-11-05T00:00:00+08:00' }
test('forecast includes already consumed quota and uses actual remaining cycle days', () => {
  const result = forecast({ ...cycle, samples: [{ at: '2026-10-18T00:00:00+08:00', used: 25000 }, { at: '2026-10-25T00:00:00+08:00', used: 32000 }] })
  assert.equal(result.pointsPerDay, 1000)
  assert.equal(result.remaining, 18000)
  assert.equal(result.projectedCyclePoints, 43000)
  assert.equal(result.status, 'reserve-at-risk')
  assert.equal(result.representativeWeek, true)
})
test('forecast rejects mixed cycles, duplicate times, reset and nonnumeric usage', () => {
  for (const samples of [
    [{ at: cycle.start, used: 100 }, { at: cycle.end, used: 200 }],
    [{ at: cycle.start, used: 100 }, { at: cycle.start, used: 200 }],
    [{ at: cycle.start, used: 200 }, { at: '2026-10-06', used: 100 }],
    [{ at: cycle.start, used: 200 }, { at: '2026-10-06', used: 'unknown' }],
  ]) assert.throws(() => forecast({ ...cycle, samples }))
})
test('cloud health distinguishes isolation, network error and readable database', async () => {
  for (const [response, available, reason] of [
    [{ data: [] }, true, 'database-readable'],
    [{ error: { code: 'DATABASE_RESOURCE_ISOLATED' } }, false, 'environment-isolated'],
    [{ error: { message: 'offline' } }, false, 'database-read-failed'],
  ]) {
    const query = { select() { return this }, eq() { return this }, async limit() { return response } }
    assert.deepEqual(await probe({ database: { from: () => query } }), { available, reason })
  }
})

test('ordinary freshness check never marks isolated cloud as successful', async () => {
  const filename = path.join(__dirname, 'check-cloud.js')
  const query = { select() { return this }, async eq() { return { error: { code: 'DATABASE_RESOURCE_ISOLATED' } } } }
  const box = { process: { argv: [], exit(code) { throw Error(`unexpected exit ${code}`) } }, console: { log() {}, error() {} },
    require(name) {
      if (name === '@tencent-ai/workbuddy-cloud-sdk') return { createWorkBuddyCloud: () => ({ database: { from: () => query } }) }
      if (name === './cloud-outage') return require('./cloud-outage')
      return {}
    } }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), box)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(box.process.exitCode, 3)
})

test('empty notification cache expires within 45 seconds and errors never create negative state', async () => {
  const worker = require('./match-notification-push')
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sports-notification-'))
  const cache = path.join(dir, 'empty')
  const env = { NOTIFY_TOKEN: 'a'.repeat(64), WECHAT_APP_ID: 'stub', WECHAT_APP_SECRET: 'stub', NOTIFICATION_EMPTY_CACHE: cache }
  let calls = 0, fail = false
  const cloud = { database: { async rpc() { calls++; return fail ? { error: {} } : { data: [] } } } }
  try {
    await worker.main(cloud, env, 100000)
    assert.equal((await worker.main(cloud, env, 110000)).emptyCache, true)
    assert.equal(calls, 1)
    await worker.main(cloud, env, 145000)
    assert.equal(calls, 2)
    await worker.main(cloud, env, 146000, { force: true })
    assert.equal(calls, 3)
    fail = true
    await assert.rejects(worker.main(cloud, env, 200000), /Could not claim/)
    assert.equal(fs.existsSync(cache), false)
    fail = false
    await worker.main(cloud, env, 200001)
    assert.equal(calls, 5)
  } finally { fs.rmSync(cache, { force: true }); fs.rmdirSync(dir) }
})

function appFixture() {
  let app, reads = 0, signedIn = true
  const box = { App(value) { app=value }, require(name) {
    if (name === './utils/cloud') return { isReady: () => true, getSession: async () => ({ data: signedIn ? {} : null }) }
    if (name === './utils/favorites') return { favoritesByMatch: async () => { reads++; await Promise.resolve(); return { data: { match: {} } } } }
    return {}
  } }
  vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../app.js'), 'utf8'), box)
  return { app, reads: () => reads, logout: () => { signedIn=false } }
}
test('simultaneous page authentication merges one favorite read; later logout still clears favorites', async () => {
  const fixture=appFixture()
  await Promise.all([fixture.app.refreshAuth(), fixture.app.refreshAuth(), fixture.app.refreshAuth()])
  assert.equal(fixture.reads(),1)
  await fixture.app.refreshAuth()
  assert.equal(fixture.reads(),2)
  fixture.logout()
  await fixture.app.refreshAuth()
  assert.equal(fixture.app.globalData.authState,'signed-out')
  assert.equal(fixture.app.globalData.favIds.length,0)
})
