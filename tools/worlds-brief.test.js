const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('node:fs')
const path = require('node:path')
const model = require('../utils/worlds-report')
const poster = require('../utils/worlds-poster')
const push = require('./worlds-brief-push')

function match(id, day, time, status, home, away, stage = 'Worlds 2026 · 瑞士轮') {
  return { id, comp: 'worlds', date: day, time, start: new Date(`${day}T${time}:00+08:00`).toISOString(), status, stage, bo: 3, home, away }
}
function team(id, score, wins, losses, zh = id) {
  return { id, name: id, zh, abbr: id, score, wins, losses }
}
function fixture() {
  return [
    match('worlds-1', '2026-10-23', '23:00', 'finished', team('AL', 2, 2, 1), team('G2', 1, 1, 2)),
    match('worlds-5', '2026-10-23', '22:00', 'finished', team('T1', 2), team('GEN', 0)),
    match('worlds-2', '2026-10-24', '01:00', 'live', team('BLG', 1), team('T1', 0)),
    match('worlds-3', '2026-10-24', '01:30', 'upcoming', team('TES', null), team('GEN', null)),
    match('worlds-4', '2026-10-25', '00:30', 'upcoming', team('IG', null), team('T1', null), 'Worlds 2026 · 淘汰赛'),
    match('old-worlds', '2025-10-23', '23:00', 'finished', team('AL', 3), team('G2', 0)),
    Object.assign(match('other-league', '2026-10-23', '23:00', 'finished', team('X', 1), team('Y', 0), 'LPL'), { comp: 'lpl' }),
  ]
}
const publishAt = Date.parse('2026-10-24T09:00:00+08:00')

test('morning edition separates final, live and overdue-unconfirmed games and uses official Swiss records', () => {
  const report = model.build(fixture(), '2026-10-24', publishAt)
  assert.equal(report.id, 'worlds-morning-2026-10-24')
  assert.equal(report.title, 'AL鏖战3局力克G2')
  assert.equal(report.finishedCount, 2)
  assert.equal(report.liveCount, 1)
  assert.deepEqual(report.finished.map(row => row.id), ['worlds-5', 'worlds-1'])
  assert.deepEqual(report.otherFinished.map(row => row.id), ['worlds-5'])
  assert.deepEqual(report.live.map(row => row.id), ['worlds-2'])
  assert.deepEqual(report.waiting.map(row => row.id), ['worlds-3'])
  assert.match(report.waiting[0].time, /^今天凌晨/)
  assert.equal(report.finished[0].homeWin, true)
  assert.equal(report.live[0].homeWin, false)
  assert.equal(report.live[0].awayWin, false)
  assert.equal(report.lpl[0].id, 'worlds-1')
  assert.equal(report.lpl.length + report.otherFinished.length, report.finished.length)
  assert.deepEqual(report.qualification.map(row => [row.record, row.text]), [['2-1', '再胜1场晋级'], ['1-2', '再负1场淘汰']])
  assert.equal(report.nextDay, '2026-10-25')
  assert.deepEqual(report.next.map(row => row.id), ['worlds-4'])
  assert.equal(report.isDraft, false)
  assert.equal(report.pubAt, '2026-10-24T01:00:00.000Z')
  const upcoming = model.build([fixture()[4]], '2026-10-24', publishAt)
  assert.doesNotMatch(upcoming.lead, /开赛时间统一按北京时间显示/)
})

test('series headline describes the decisive best-of-five result in one sentence', () => {
  const decisive = match('worlds-final', '2026-11-08', '06:00', 'finished', team('AL', 3), team('T1', 2), 'Worlds 2026 · 决赛')
  decisive.bo = 5
  const report = model.build([decisive], '2026-11-08', Date.parse('2026-11-08T09:00:00+08:00'))
  assert.equal(report.title, 'AL苦战5局力克T1')
})

test('morning report date validation rejects normalized dates and pre-09:00 editions stay previews', () => {
  assert.equal(model.validDate('2026-10-24'), true)
  assert.equal(model.validDate('2026-02-31'), false)
  assert.equal(model.validDate('2025-10-24'), false)
  const report = model.build(fixture(), '2026-10-24', Date.parse('2026-10-24T08:59:00+08:00'))
  assert.equal(report.isDraft, true)
  assert.equal(model.build(fixture(), '2026-10-24', publishAt).isDraft, false)
})

function fakeCloud(options = {}) {
  const writes = []
  const calls = []
  const values = {
    schedule_cache: { data: options.snapshot || fixture(), generated_at: '2026-10-24T07:50:00+08:00' },
    match_detail: { data: options.buckets || [] },
    live_scores: { data: options.live || { generatedAt: '2026-10-24T07:55:00+08:00', rows: [{ id: 'worlds-2', st: 'live', hs: 1, as: 0 }] } },
    daily_brief: options.previous ? { payload: options.previous } : null,
  }
  const database = { from(table) {
    calls.push(table)
    const query = {
      select() { return this }, eq() { return this }, gte() { return this }, lte() { return this },
      maybeSingle() { return Promise.resolve({ ...(options.readError && table === options.readError ? { error: { message: 'read denied' } } : {}), data: values[table] || null }) },
      upsert(row) { writes.push(row); this.write = row; return this },
      then(resolve, reject) {
        const result = this.write ? { data: options.writeError ? null : [{ id: this.write.id }], error: options.writeError ? { message: 'write denied' } : null }
          : options.readError && table === options.readError ? { error: { message: 'read denied' } }
            : table === 'match_detail' ? (values[table] || { data: null }) : { data: values[table] || null }
        return Promise.resolve(result).then(resolve, reject)
      },
    }
    return query
  } }
  return { cloud: { database }, writes, calls }
}

test('generator skips before its Beijing publish time without reading cloud data', async () => {
  const mock = fakeCloud()
  const result = await push.main(mock.cloud, Date.parse('2026-10-24T08:59:00+08:00'))
  assert.deepEqual(result, { skipped: 'not-due' })
  assert.equal(mock.calls.length, 0)
})

test('generator dry-run and publish use live status without treating its score as final', async () => {
  const preview = fakeCloud()
  const result = await push.main(preview.cloud, publishAt, true)
  assert.equal(result.dryRun, true)
  assert.equal(result.report.liveCount, 1)
  assert.equal(result.report.live[0].homeWin, false)
  assert.equal(preview.writes.length, 0)

  const production = fakeCloud()
  const published = await push.main(production.cloud, publishAt)
  assert.equal(published.published, 'worlds-morning-2026-10-24')
  assert.equal(production.writes.length, 1)
  assert.equal(production.writes[0].kind, 'morning')
  assert.equal(production.writes[0].payload.live[0].score, '1 : 0')
})

test('generator avoids duplicate writes for unchanged facts and fails closed on a missing data source', async () => {
  const report = model.build(fixture(), '2026-10-24', publishAt)
  const unchanged = fakeCloud({ previous: report })
  assert.deepEqual(await push.main(unchanged.cloud, publishAt + 1000), { skipped: 'unchanged' })
  assert.equal(unchanged.writes.length, 0)

  const failed = fakeCloud({ readError: 'live_scores' })
  await assert.rejects(push.main(failed.cloud, publishAt), /归档、实时比分或已发布期次读取失败/)
  assert.equal(failed.writes.length, 0)
})

test('long poster layout draws the mini-program code and allocates room for its full report', () => {
  const report = model.build(fixture(), '2026-10-24', publishAt)
  const calls = { images: 0, text: 0, values: [] }
  const ctx = {
    font: '', fillStyle: '', textAlign: '', textBaseline: '',
    measureText(value) { const size = Number((this.font.match(/(\d+)px/) || [0, 20])[1]); return { width: [...String(value)].length * size } },
    fillRect() {}, fillText(value) { calls.text += 1; calls.values.push(String(value)) }, drawImage() { calls.images += 1 },
  }
  const height = poster.measure(ctx, report)
  assert.ok(height > 1200)
  assert.equal(poster.draw(ctx, report, {}), height)
  assert.ok(calls.text > 20)
  assert.ok(calls.values.includes('LPL 昨夜表现'))
  assert.ok(!calls.values.some(value => value === '2 场已结束' || value === '1 场进行中'))
  assert.equal(calls.images, 1)
  const qrPath = path.join(__dirname, '..', 'images', 'worlds-miniprogram.jpg')
  assert.ok(fs.statSync(qrPath).size > 1000)
})

test('morning report keeps its share canvas offscreen and exposes two clear poster actions', () => {
  const page = path.join(__dirname, '..', 'pages', 'worlds-brief')
  const wxml = fs.readFileSync(path.join(page, 'worlds-brief.wxml'), 'utf8')
  const wxss = fs.readFileSync(path.join(page, 'worlds-brief.wxss'), 'utf8')
  const js = fs.readFileSync(path.join(page, 'worlds-brief.js'), 'utf8')
  assert.match(wxss, /\.share-canvas\s*\{[^}]*left:\s*-9999px/s)
  assert.equal((wxml.match(/<button\b/g) || []).length, 2)
  assert.match(wxml, /open-type="share">分享好友/)
  assert.match(wxml, /bindtap="generatePoster"[^>]*>生成长图/)
  assert.doesNotMatch(wxml, /report-footer|worlds-miniprogram|小程序码|分享晨报页面|预览分享长图|保存到相册/)
  assert.match(js, /wx\.previewImage\(\{ current: path, urls: \[path\] \}\)/)
  const timeIndex = wxml.indexOf('class="report-match-time"')
  const teamsIndex = wxml.indexOf('class="report-match-top"')
  assert.ok(timeIndex >= 0 && teamsIndex > timeIndex)
  assert.match(wxss, /\.report-match-top\s*\{[^}]*justify-content:\s*center/s)
  assert.match(wxss, /\.report-team\.away\s*\{[^}]*text-align:\s*left/s)
  assert.doesNotMatch(wxss, /\.report-footer/)
})
