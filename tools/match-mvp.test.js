const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')
const model = require('../utils/match-mvp-view')
const long = require('../utils/lol-mvp-poster')

const match = { id: 'nba-1', comp: 'nba', status: 'finished', start: '2026-10-14T01:00:00Z', home: { name: 'Home', score: 100 }, away: { name: 'Away', score: 99 } }
const candidate = (id, side) => ({ id, side, name: id, role: '后卫', roleKey: 'BG', stats: [{ label: '得分', value: '0' }] })
const raw = (kind = 'basketball') => ({ fin: true, mvp: { v: 1, kind, complete: true,
  candidates: [candidate(kind === 'kpl' ? 'kpl:1' : 'espn:1', 'home'), candidate(kind === 'kpl' ? 'kpl:2' : 'espn:2', 'away')], note: '本场数据' } })

function pageFixture(overrides = {}) {
  let page
  const calls = { votes: [], previews: [], toasts: [], shares: [] }
  const app = { globalData: { authState: 'signed-in' }, refreshAuth: async () => {} }
  const filename = path.join(__dirname, '../pages/detail/detail.js'), real = createRequire(filename)
  const votes = { summary: async () => ({ data: [], error: null }), vote: async (...args) => { calls.votes.push(args); return { error: null } } }
  const data = { compOf: () => ({ cat: 'basketball' }), matchDetail: async () => raw() }
  const images = { build: async () => 'image.jpg' }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), {
    Page: value => { page = value }, module: { exports: {} }, console,
    wx: { showToast: v => calls.toasts.push(v), previewImage: v => calls.previews.push(v) },
    require: name => {
      if (name.endsWith('/app-instance')) return { appInstance: () => app }
      if (name.endsWith('/match-mvp')) return votes
      if (name.endsWith('/data')) return data
      if (name.endsWith('/poster')) return images
      if (name.endsWith('/share')) return { message: v => { calls.shares.push(v); return v }, timeline: v => v }
      if (name.endsWith('/match-mvp-view') || name.endsWith('/view') || name.endsWith('/lol-view') || name.endsWith('/kpl-view')) return real(name)
      return {}
    }, ...overrides,
  }, { filename })
  page.data = { ...page.data, match, comp: { name: 'NBA' }, detail: { matchMvp: model.build(raw(), match) } }
  page.setData = (values, callback) => {
    for (const [key, value] of Object.entries(values)) {
      const parts = key.split('.'); let target = page.data
      while (parts.length > 1) target = target[parts.shift()]
      target[parts[0]] = value
    }
    if (callback) callback()
  }
  return { page, calls, app, votes, data, images }
}

test('finished match detail continues bounded polling until the later MVP roster arrives', async () => {
  const { page, data } = pageFixture()
  page.syncLivePoll = () => {}
  data.matchDetail = async () => ({ fin: true })
  await page.loadDetail(match)
  assert.equal(page.finalDetailReady, false)
  assert.equal(page.data.detail.matchMvp, null)
  page.detailReadAt = 0
  data.matchDetail = async () => raw()
  await page.loadDetail(match)
  assert.equal(page.finalDetailReady, true)
  assert.equal(page.data.detail.matchMvp.candidates.length, 2)
})

test('all new MVP kinds require final official candidates on both teams and keep real zero statistics', () => {
  for (const kind of ['football', 'basketball', 'kpl']) {
    const mvp = model.build(raw(kind), match)
    assert.equal(mvp.candidates.length, 2)
    assert.equal(mvp.positions[0].home.length, 1)
    assert.equal(mvp.positions[0].away.length, 1)
    assert.equal(mvp.candidates[0].stats[0].value, '0')
    assert.equal(mvp.enabled, false)
  }
  assert.equal(model.build(raw(), { ...match, status: 'live' }), null)
  assert.equal(model.build({ ...raw(), fin: false }, match), null)
  assert.equal(model.build({ ...raw(), mvp: { ...raw().mvp, complete: 'true' } }, match), null)
  assert.equal(model.build({ fin: true }, match), null)
  assert.equal(model.build({ ...raw(), mvp: { ...raw().mvp, candidates: [candidate('espn:1', 'home')] } }, match), null)
})

test('summary shows totals from all accounts, tied leaders, my immutable choice and friends selection separately', () => {
  const next = model.withSummary(model.build(raw(), match), [
    { player_id: 'espn:1', vote_count: 2, total_votes: 4, is_mine: false },
    { player_id: 'espn:2', vote_count: 2, total_votes: 4, is_mine: true },
  ], 'espn:1')
  assert.equal(next.myVote, 'espn:2')
  assert.equal(next.totalVotes, 4)
  assert.match(next.leaderSummary, /并列/)
  assert.equal(next.candidates[0].isShared, true)
  assert.equal(next.candidates[0].isMine, false)
  assert.equal(next.candidates[1].isMine, true)
})

test('vote counts failures do not become zero-vote success and retry restores eligibility', async () => {
  const { page, votes, calls } = pageFixture()
  votes.summary = async () => ({ error: { message: 'temporary failure' } })
  await page.refreshMatchMvpSummary(match.id)
  assert.equal(page.data.detail.matchMvp.enabled, false)
  assert.match(page.data.detail.matchMvp.leaderSummary, /重试/)
  await page.onMatchMvpVote({ currentTarget: { dataset: { key: 'espn:1' } } })
  assert.equal(calls.votes.length, 0)
  votes.summary = async () => ({ data: [], error: null })
  await page.refreshMatchMvpSummary(match.id)
  assert.equal(page.data.detail.matchMvp.enabled, true)
  assert.equal(page.data.detail.matchMvp.totalVotes, 0)
})

test('generic votes lock against repeat taps and cloud duplicates reload the original recorded choice', async () => {
  const { page, votes, calls } = pageFixture()
  await page.refreshMatchMvpSummary(match.id)
  votes.summary = async () => ({ data: [{ player_id: 'espn:1', vote_count: 1, total_votes: 1, is_mine: true }] })
  await page.onMatchMvpVote({ currentTarget: { dataset: { key: 'espn:1' } } })
  assert.equal(page.data.detail.matchMvp.myVote, 'espn:1')
  await page.onMatchMvpVote({ currentTarget: { dataset: { key: 'espn:2' } } })
  assert.equal(calls.votes.length, 1)
  assert.equal(page.data.matchMvpVoteBusy, false)
  page.data.detail.matchMvp.myVote = ''
  votes.vote = async () => ({ error: { code: 'DATABASE_23505' } })
  await page.onMatchMvpVote({ currentTarget: { dataset: { key: 'espn:2' } } })
  assert.equal(page.data.detail.matchMvp.myVote, 'espn:1')
})

test('a summary started before a successful vote cannot erase the recorded vote or share actions', async () => {
  const { page, votes } = pageFixture()
  await page.refreshMatchMvpSummary(match.id)
  let releaseOld
  let reads = 0
  votes.summary = async () => {
    if (reads++ === 0) return new Promise(resolve => { releaseOld = resolve })
    return { data: [{ player_id: 'espn:1', vote_count: 1, total_votes: 1, is_mine: true }] }
  }
  const beforeVote = page.refreshMatchMvpSummary(match.id)
  await page.onMatchMvpVote({ currentTarget: { dataset: { key: 'espn:1' } } })
  assert.equal(page.data.detail.matchMvp.myVote, 'espn:1')
  releaseOld({ data: [] })
  await beforeVote
  assert.equal(page.data.detail.matchMvp.myVote, 'espn:1')
  assert.equal(page.data.detail.matchMvp.totalVotes, 1)
  assert.equal(page.matchMvpShareCandidate.key, 'espn:1')
  assert.equal(reads, 2)
})

test('generic MVP share carries the recorded candidate and current match instead of casting a friends vote', async () => {
  const { page, votes, calls } = pageFixture()
  page.sharedMvpKey = 'espn:2'
  votes.summary = async () => ({ data: [{ player_id: 'espn:1', vote_count: 1, total_votes: 1, is_mine: true }] })
  await page.refreshMatchMvpSummary(match.id)
  assert.equal(calls.votes.length, 0)
  const message = page.onShareAppMessage({ target: { dataset: { kind: 'match-mvp' } } })
  assert.match(message.path, /id=nba-1&mvp=espn%3A1/)
  assert.match(message.title, /espn:1/)
  await page.generateMatchMvpPoster()
  assert.equal(calls.previews.length, 1)
  assert.equal(page.data.matchMvpPosterBusy, false)
})

test('an account change during image generation rebuilds the new selection and clears former choices on sign-out', async () => {
  const { page, images, votes } = pageFixture()
  let finishFirst
  let builds = 0
  images.build = async () => ++builds === 1 ? new Promise(resolve => { finishFirst = resolve }) : 'new-pick.jpg'
  const [first, second] = page.data.detail.matchMvp.candidates
  page.matchMvpShareCandidate = first
  const drawing = page.buildMatchMvpShareImage(first)
  page.matchMvpShareCandidate = second
  await page.buildMatchMvpShareImage(second)
  finishFirst('old-pick.jpg')
  await drawing
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(builds, 2)
  assert.equal(page.data.matchMvpShareImage, 'new-pick.jpg')
  votes.summary = async () => ({ data: [] })
  await page.refreshMatchMvpSummary(match.id)
  assert.equal(page.matchMvpShareCandidate, null)
  assert.equal(page.data.matchMvpShareImage, '')
})

test('football and basketball posters say 我的MVP and display their own statistics without LOL placeholders', () => {
  const text = [], ctx = { font: '', measureText: s => ({ width: String(s).length * 20 }),
    fillRect() {}, fillText: s => text.push(String(s)), drawImage() {} }
  const height = long.draw(ctx, { kind: 'basketball', comp: 'NBA', name: 'Player', team: 'Home', role: '后卫',
    home: 'Home', away: 'Away', homeScore: 100, awayScore: 99, dateText: '2026-10-14', timeText: '09:00',
    stats: [{ label: '得分', value: '30' }, { label: '助攻', value: '0' }], qr: {}, votes: 4, totalVotes: 8 })
  assert.ok(height > 750)
  assert.ok(text.includes('闪现 · 我的MVP'))
  assert.ok(text.includes('得分') && text.includes('30') && text.includes('0'))
  assert.ok(!text.some(s => /\d+\s*票|票数/.test(s)))
  assert.ok(!text.some(s => /undefined|击杀|补刀|暂无英雄|MVP 之选/.test(s)))
})
