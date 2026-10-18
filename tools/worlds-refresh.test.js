/**
 * Worlds 定向刷新的验收测试。
 *
 * 对应《交接-WB瑞士轮抽签后对阵刷新核查-20261018.md》§必要验收 6 条：
 *   · 同 ID 的 TBD–TBD 改真实双方能更新，首轮 8 场不重复创建
 *   · 新建 ID / 时间调整 / 队伍顺序变化正确，其他赛事与旧赛果保持
 *   · 内容不变不写，接口失败不清空，已确认队伍不被旧 TBD 回退
 *   · 局部更新不重置全站主闸（generated_at 原值返回）
 *   · 闲时入口不挡抽签，首轮确认后恢复正常减载
 */
const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const worlds = require('./worlds-refresh')

const now = Date.parse('2026-10-19T04:00:00Z')
const GENERATED_AT = '2026-10-19T02:30:00.000Z'
const hours = h => new Date(now + h * 3600000).toISOString()
const tbd = { id: 'TBD', name: '待定', zh: '待定', abbr: 'TBD', color: '#8A93A6' }
const team = (id, name) => ({ id, name, zh: name, abbr: name.slice(0, 3).toUpperCase(), color: '#123456' })

/** 首轮 8 场：官方时间为 10-23 17:00Z 起，每小时一场。 */
function firstRound(withTeams) {
  return Array.from({ length: 8 }, (_, i) => ({
    id: `worlds-${1000 + i}`,
    comp: 'worlds',
    start: hours(4 * 24 + i),
    date: '2026-10-23',
    time: `${17 + i}:00`,
    status: 'upcoming',
    statusText: '未开始',
    stage: '全球总决赛 · 瑞士轮',
    venue: '',
    broadcast: [],
    bo: 1,
    home: withTeams ? team(`t${i}a`, `Team${i}A`) : { ...tbd },
    away: withTeams ? team(`t${i}b`, `Team${i}B`) : { ...tbd },
    historical: false,
  }))
}

function row(id, start, home, away, extra = {}) {
  return {
    id,
    comp: 'worlds',
    start,
    date: '2026-10-23',
    time: '17:00',
    status: 'upcoming',
    statusText: '未开始',
    stage: '全球总决赛 · 瑞士轮',
    venue: '',
    broadcast: [],
    bo: 1,
    home,
    away,
    historical: false,
    ...extra,
  }
}

/** 一个只实现本模块用到的四种调用的云客户端替身，同时记账读/写次数。 */
function fakeCloud(data, meta = {}) {
  const calls = { reads: [], writes: [] }
  const state = { data: data.map(m => ({ ...m })), meta: { ...meta }, generated_at: GENERATED_AT }
  const database = {
    from(table) {
      assert.equal(table, 'schedule_cache')
      return {
        select(fields) {
          return {
            eq(column, value) {
              assert.equal(column, 'id')
              assert.equal(value, 'latest')
              const answer = () => ({ data: { ...state, data: state.data.map(m => ({ ...m })) } })
              return {
                single: async () => { calls.reads.push(fields); return answer() },
                maybeSingle: async () => { calls.reads.push(fields); return { data: { meta: state.meta } } },
              }
            },
          }
        },
        async upsert(payload) {
          calls.writes.push(payload)
          state.data = payload.data
          state.meta = payload.meta
          state.generated_at = payload.generated_at
          return { data: [{ id: payload.id, generated_at: payload.generated_at }] }
        },
      }
    },
  }
  return { cloud: { database }, calls, state }
}

const tmpCache = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'worlds-')), 'sig.json')

test('the drawn bracket replaces TBD on the same ids without duplicating the first round', async () => {
  const { cloud, calls, state } = fakeCloud(firstRound(false))
  const result = await worlds.refresh(cloud, { now, collect: async () => firstRound(true) })

  assert.equal(result.reason, 'worlds-fixtures-updated')
  assert.equal(result.changed, 8)
  assert.equal(result.wrote, true)
  assert.equal(state.data.length, 8, '八场必须原地更新，不能变成十六场')
  assert.deepEqual(new Set(state.data.map(m => m.id)).size, 8)
  for (const m of state.data) {
    assert.ok(!worlds.isTbd(m.home) && !worlds.isTbd(m.away), `${m.id} 双方都应落地`)
  }
  assert.equal(calls.writes.length, 1)
})

test('a new match id is added once, a time change and a swapped side both land', async () => {
  const cloudRows = [
    row('worlds-2001', hours(24), team('a', 'Alpha'), team('b', 'Beta')),
    row('worlds-2002', hours(25), team('c', 'Gamma'), team('d', 'Delta')),
  ]
  const { cloud, state } = fakeCloud(cloudRows)
  const official = [
    // 同一场，开赛时间改了
    row('worlds-2001', hours(26), team('a', 'Alpha'), team('b', 'Beta')),
    // 同一场，主客互换（抽签抽的是对阵，不保证顺序）
    row('worlds-2002', hours(25), team('d', 'Delta'), team('c', 'Gamma')),
    // 全新比赛
    row('worlds-2003', hours(48), team('e', 'Epsilon'), team('f', 'Zeta')),
  ]
  const result = await worlds.refresh(cloud, { now, collect: async () => official })

  assert.equal(result.changed, 3)
  assert.equal(state.data.length, 3)
  const byId = new Map(state.data.map(m => [m.id, m]))
  assert.equal(byId.get('worlds-2001').start, hours(26))
  assert.equal(byId.get('worlds-2002').home.id, 'd')
  assert.equal(byId.get('worlds-2003').away.id, 'f')
})

test('other competitions, old results and matches the feed dropped are carried through untouched', async () => {
  const epl = { id: 'epl-1', comp: 'epl', start: hours(-30), status: 'finished', stage: '英超 · 第 8 轮',
    home: { id: '359', name: '阿森纳', score: 2 }, away: { id: '360', name: '切尔西', score: 1 } }
  const oldWorlds = row('worlds-1900', hours(-24 * 3), team('x', 'OldX'), team('y', 'OldY'), { status: 'finished' })
  const dropped = row('worlds-1901', hours(30), team('m', 'M'), team('n', 'N'))
  const { cloud, state } = fakeCloud([epl, oldWorlds, dropped])

  const result = await worlds.refresh(cloud, { now, collect: async () => [
    row('worlds-1902', hours(40), team('p', 'P'), team('q', 'Q')),
  ] })

  const ids = state.data.map(m => m.id)
  assert.ok(ids.includes('epl-1'), '其他赛事必须原样保留')
  assert.ok(ids.includes('worlds-1900'), '官方没返回的旧赛果不能被删')
  assert.ok(ids.includes('worlds-1901'), '官方这次没返回 ≠ 比赛取消')
  assert.ok(ids.includes('worlds-1902'))
  assert.equal(state.data.find(m => m.id === 'epl-1').home.score, 2, '足球比分不得被动过')
  assert.equal(result.changed, 1, '只有新增那场算变化')
})

test('past matches the cloud pruned are not re-created by the fast lane', async () => {
  const { cloud, state } = fakeCloud([row('worlds-2001', hours(24), team('a', 'A'), team('b', 'B'))])
  await worlds.refresh(cloud, { now, collect: async () => [
    row('worlds-2001', hours(24), team('a', 'A'), team('b', 'B')),
    row('worlds-1500', hours(-24 * 40), team('c', 'C'), team('d', 'D'), { status: 'finished' }),
  ] })
  assert.equal(state.data.length, 1, '历史场次交给全量推送，快通道不补')
})

// 回归：云端快照走紧凑编码，秒为 0 时会写成 `...T17:00Z`，官方接口原样是 `...T17:00:00Z`。
// 曾经按字符串比较，导致 44 场每一场都被判成「变了」，等于每班重写一遍整表。
test('the same instant written with and without :00 seconds is not a change', async () => {
  const cloudRows = [row('worlds-5001', '2026-10-23T17:00Z', team('a', 'A'), team('b', 'B'))]
  const { cloud, calls } = fakeCloud(cloudRows)
  const result = await worlds.refresh(cloud, { now, collect: async () => [
    row('worlds-5001', '2026-10-23T17:00:00Z', team('a', 'A'), team('b', 'B')),
  ] })
  assert.equal(result.changed, 0)
  assert.equal(result.wrote, false)
  assert.equal(calls.writes.length, 0)
})

test('an unchanged bracket writes nothing, and a warm cache skips the cloud entirely', async () => {
  const rows = firstRound(true)
  const cacheFile = tmpCache()
  const { cloud, calls } = fakeCloud(rows)

  const first = await worlds.refresh(cloud, { now, cacheFile, collect: async () => rows })
  assert.equal(first.wrote, false)
  assert.equal(first.reason, 'signature-changed-no-match-diff')
  assert.equal(calls.writes.length, 0)

  const before = calls.reads.length
  const second = await worlds.refresh(cloud, { now, cacheFile, collect: async () => rows })
  assert.equal(second.reason, 'unchanged')
  assert.equal(second.via, 'cache')
  assert.equal(calls.reads.length, before, '缓存命中后一个云端请求都不该发')
})

test('a meta signature recorded by an earlier shift also blocks the write', async () => {
  const rows = firstRound(true)
  const sig = worlds.signature(rows)
  const { cloud, calls } = fakeCloud(rows, { worldsSig: sig })

  const result = await worlds.refresh(cloud, { now, collect: async () => rows })
  assert.equal(result.reason, 'unchanged')
  assert.equal(result.via, 'meta')
  assert.equal(calls.reads.length, 1, '只读 meta，不读整表')
  assert.equal(calls.writes.length, 0)
})

test('an empty or failing official feed never clears the stored bracket', async () => {
  const rows = firstRound(true)
  const { cloud, calls, state } = fakeCloud(rows)

  const empty = await worlds.refresh(cloud, { now, collect: async () => [] })
  assert.equal(empty.reason, 'no-official-rows')
  assert.equal(calls.writes.length, 0)
  assert.equal(calls.reads.length, 0, '官方没数据时连云端都不该读')

  await assert.rejects(
    worlds.refresh(cloud, { now, collect: async () => { throw Error('upstream 500') } }),
    /upstream 500/,
  )
  assert.equal(state.data.length, 8)
  assert.equal(calls.writes.length, 0)
})

test('a degraded feed cannot roll a confirmed side back to TBD', async () => {
  const confirmed = row('worlds-3001', hours(24), team('a', 'Alpha'), team('b', 'Beta'))
  const { cloud, state } = fakeCloud([confirmed])

  const result = await worlds.refresh(cloud, { now, collect: async () => [
    // 上游只回了半个对阵，而且时间还改了
    row('worlds-3001', hours(30), { ...tbd }, { ...tbd }),
  ] })

  const kept = state.data[0]
  assert.equal(kept.home.id, 'a', '已确认的主队不能被 TBD 覆盖')
  assert.equal(kept.away.id, 'b', '已确认的客队不能被 TBD 覆盖')
  assert.equal(kept.start, hours(30), '时间等其余字段仍要跟上官方')
  assert.equal(result.changed, 1)
})

test('the local update keeps generated_at so the 90-minute master gate is not pushed back', async () => {
  const { cloud, calls, state } = fakeCloud(firstRound(false))
  await worlds.refresh(cloud, { now, collect: async () => firstRound(true) })

  assert.equal(calls.writes.length, 1)
  assert.equal(calls.writes[0].generated_at, GENERATED_AT)
  assert.equal(state.generated_at, GENERATED_AT)
  assert.equal(typeof calls.writes[0].meta.worldsSig, 'string')
  assert.ok(calls.writes[0].meta.worldsRefreshedAt, '局部刷新时间单独记账，不冒充全站刷新')
})

test('dry run reports the diff without touching the cloud', async () => {
  const { cloud, calls, state } = fakeCloud(firstRound(false))
  const result = await worlds.refresh(cloud, { now, dryRun: true, collect: async () => firstRound(true) })
  assert.equal(result.reason, 'dry-run')
  assert.equal(result.changed, 8)
  assert.equal(calls.writes.length, 0)
  assert.equal(state.data.length, 8)
})

test('hasPending only reports future Worlds fixtures with an undecided side', () => {
  assert.equal(worlds.hasPending(firstRound(false), now), true)
  assert.equal(worlds.hasPending(firstRound(true), now), false)
  assert.equal(worlds.hasPending([
    row('worlds-4001', hours(-5), { ...tbd }, { ...tbd }, { status: 'finished' }),
  ], now), false, '已经打完的 TBD 不该让闲时入口一直醒着')
  assert.equal(worlds.hasPending([
    row('epl-1', hours(24), { ...tbd }, { ...tbd }),
  ], now), false, '只看 Worlds')
  assert.equal(worlds.hasPending([], now), false)
})

test('the idle gate wakes when the draw lands and sleeps again once the bracket is complete', async () => {
  const activity = require('./activity-gate')
  const snapshotAt = new Date(now).toISOString()
  const sources = { source: { ok: true, checkedAt: snapshotAt } }
  const pending = firstRound(false)

  const plan = activity.makePlan({
    matches: pending,
    snapshotAt,
    sources,
    expected: ['source'],
    now,
    sha: 'sha',
    worldsSig: 'OLD',
  })
  assert.equal(plan.worldsPending, true)
  assert.equal(plan.ready, true)
  assert.equal(plan.worldsSig, 'OLD')

  const idle = async () => ({ healthy: true, active: false, rows: [], sources: 45 })
  const probe = sig => activity.gate(plan, { now: now + 60000, sha: 'sha', discover: idle, worldsSignature: async () => sig })

  assert.equal((await probe('OLD')).run, false, '官方没变就该继续减载')
  assert.equal((await probe('NEW')).reason, 'worlds-fixtures-published')
  assert.equal((await probe('')).run, false, '官方源拿不到签名时不能据此判忙')

  // 首轮全部落地后 worldsPending 转 false：连官方赛程都不该再探。
  const done = activity.makePlan({ matches: firstRound(true), snapshotAt, sources, expected: ['source'], now, sha: 'sha', worldsSig: 'NEW' })
  assert.equal(done.worldsPending, false)
  assert.equal((await activity.gate(done, {
    now: now + 60000,
    sha: 'sha',
    discover: idle,
    worldsSignature: async () => { throw Error('must not probe') },
  })).run, false)
})

test('record stores the pending flag and the official signature the next shift compares against', async () => {
  const activity = require('./activity-gate')
  const live = require('./live-watch')
  const snapshotAt = new Date(now).toISOString()
  const sources = Object.fromEntries(live.expectedSources().map(k => [k, { ok: true, checkedAt: snapshotAt }]))
  const tables = {
    schedule_cache: () => ({ id: 'latest', data: firstRound(false), meta: {}, generated_at: snapshotAt }),
    live_scores: () => ({ id: 'latest', data: { rows: [], sources }, generated_at: snapshotAt }),
  }
  const cloud = {
    database: {
      from(table) {
        return {
          select() {
            return { eq: () => ({ single: async () => ({ data: tables[table]() }) }) }
          },
        }
      },
    },
  }

  const plan = await activity.record(cloud, { now, sha: 'sha', worldsSignature: async () => 'SIG-1' })
  assert.equal(plan.ready, true)
  assert.equal(plan.worldsPending, true)
  assert.equal(plan.worldsSig, 'SIG-1')

  // 官方源取不到签名时留空：下一班重试，而不是拿一个假签名把空闲锁死。
  const blank = await activity.record(cloud, { now, sha: 'sha', worldsSignature: async () => '' })
  assert.equal(blank.worldsPending, true)
  assert.equal(blank.worldsSig, '')
})
