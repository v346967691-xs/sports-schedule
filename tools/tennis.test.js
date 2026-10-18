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
    require: name => name === './data' ? data : name === './tennis-names' ? require('../utils/tennis-names') : { isReady: () => false },
  }).module.exports
  follows.toggle(player)
  assert.equal(data.matchHasTeam(match, follows.asFilter()[0]), true)
  assert.equal(data.matchHasTeam({ ...match, comp: 'wta' }, follows.asFilter()[0]), false)
  let page
  let destination
  const app = { globalData: {} }
  load('../pages/mine/mine.js', { Page: value => { page = value }, wx: { switchTab() {}, navigateTo:opt=>{destination=opt.url} },
    require: name => name.endsWith('/app-instance') ? { appInstance: () => app } : name.endsWith('/tennis-insights') ? require('../utils/tennis-insights') : {} })
  page.data.teams = [player]
  page.onTeamTap({ currentTarget: { dataset: { index: 0 } } })
  assert.match(destination,/pages\/tennis-player\/tennis-player/); assert.equal(new URLSearchParams(destination.split('?')[1]).get('name'),player.name)
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

test('tennis detail displays and refreshes set scores without a generic detail payload; basketball keeps its own columns', async () => {
  let page
  const realRequire = createRequire(path.join(__dirname, '../pages/detail/detail.js'))
  const comp = { name: 'ATP', full: 'ATP 男子职业网球巡回赛', cat: 'tennis', accent: '#1C6B45' }
  const data = { compOf: () => comp, standingsOf: () => null, matchDetail: async () => null }
  const app = { globalData: {}, isFav: () => false }
  let destination
  load('../pages/detail/detail.js', { Page: value => { page = value }, wx: { switchTab: value => { destination = value.url }, navigateTo:value=>{destination=value.url} }, require: name => {
    if (name.endsWith('/data')) return data
    if (name.endsWith('/app-instance')) return { appInstance: () => app }
    return realRequire(name)
  } })
  page.data = { ...page.data }
  page.setData = (values, done) => { Object.assign(page.data, values); if (done) done() }
  page.buildShareImage = page.loadNotificationStates = page.syncLivePoll = () => {}
  const match = { id: 'atp-view', comp: 'atp', start: '2026-10-15T12:00:00Z', date: '2026-10-15', time: '20:00', status: 'live',
    home: { id: '1', name: 'Player A', score: 1 }, away: { id: '2', name: 'Player B', score: 0 }, sets: { h: [6, 3], a: [4, 2] } }
  page.applyMatch(match)
  await Promise.resolve()
  assert.equal(page.data.detail, null)
  assert.deepEqual(Array.from(page.data.tennisSets.rows[0].scores), ['6', '3'])
  page.applyMatch({ ...match, sets: { h: [6, 4], a: [4, 2] } })
  assert.deepEqual(Array.from(page.data.tennisSets.rows[0].scores), ['6', '4'])
  page.onTeamTap({ currentTarget: { dataset: { side: 'home' } } })
  assert.match(destination,/tennis-player/);assert.equal(new URLSearchParams(destination.split('?')[1]).get('name'),'Player A')
  page.applyMatch({ ...match, status: 'finished' })
  assert.equal(page.detailPollUntil, undefined)
  assert.equal(page.finalDetailReady, true)
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/detail/detail.wxml'), 'utf8')
  assert.match(wxml, /wx:if="\{\{tennisSets\}\}"/)
  const quarters = wxml.slice(wxml.indexOf('wx:if="{{detail.hasQuarters}}"'), wxml.indexOf('wx:if="{{tennisSets}}"'))
  assert.match(quarters, /wx:for="\{\{detail.quarters.cols\}\}"[^>]*>\{\{r.scores\[index\]\}\}/)
  assert.doesNotMatch(quarters, /tennisSets\.cols/)
})

test('tennis cards retain the station and round, and ATP/WTA events with the same name remain distinct', () => {
  const tennis = require('../utils/tennis')
  const view = require('../utils/view')
  const a = { comp: 'atp', stage: 'China Open · Semifinals', status: 'upcoming', date: '2026-10-15',
    home: { name: 'Player A' }, away: { name: 'Player B' } }
  assert.equal(tennis.roundOf(a), '半决赛')
  assert.equal(view.decorate.call({ compOf: () => ({ name: 'ATP' }) }, a)._stageLabel, '中国网球公开赛 · 半决赛')
  assert.notEqual(tennis.tournamentOf(a).key, tennis.tournamentOf({ ...a, comp: 'wta' }).key)
  assert.equal(tennis.tournamentOf({ ...a, stage: 'New Event · Round of 16' }).name, 'New Event')
  assert.equal(tennis.roundOf({ ...a, stage: 'New Event · Round of 16' }), '16强赛')
})

function tennisSchedulePage() {
  const day = '2026-10-16'
  const game = (id, comp, stage, status = 'upcoming') => ({ id, comp, stage, status, date: day, time: '12:00', start: day + 'T04:00:00Z',
    home: { id: id + '-h', name: 'Player A', score: null }, away: { id: id + '-a', name: 'Player B', score: null } })
  const matches = [game('a1', 'atp', 'China Open · Semifinals'), game('a2', 'atp', 'China Open · Final'),
    game('b1', 'atp', 'Almaty Open · Semifinals'), game('w1', 'wta', 'China Open · Semifinals'),
    game('live', 'atp', 'Almaty Open · Quarterfinals', 'live')]
  const compMap = { atp: { key: 'atp', cat: 'tennis', name: 'ATP' }, wta: { key: 'wta', cat: 'tennis', name: 'WTA' } }
  const query = (opt = {}) => matches.filter(m => (!opt.comps || !opt.comps.length || opt.comps.includes(m.comp))
    && (!opt.status || (Array.isArray(opt.status) ? opt.status : [opt.status]).includes(m.status)))
  const data = { matches: () => matches, compOf: k => compMap[k], compMap: () => compMap,
    categories: () => [{ key: 'tennis', competitions: ['atp', 'wta'] }], query,
    upcoming: opt => query({ ...opt, status: 'upcoming' }), finished: opt => query({ ...opt, status: 'finished' }),
    teamForm: () => [], standingsOf: () => null, generatedAt: () => '', source: () => 'local', staleInfo: () => ({ stale: false }) }
  const filename = path.join(__dirname, '../pages/schedule/schedule.js')
  const realRequire = createRequire(filename)
  let page
  load('../pages/schedule/schedule.js', { Page: value => { page = value }, require: name => name.endsWith('/data') ? data : realRequire(name) })
  page.data = { ...page.data, activeCat: 'tennis', activeComp: 'atp' }
  page.setData = (value, done) => { Object.assign(page.data, value); if (done) done() }
  page.buildShareImage = page.cloudRefresh = () => {}
  return page
}

test('tennis schedule selects station before round and never combines different stations into one knockout tree', () => {
  const page = tennisSchedulePage()
  page.doReload()
  assert.equal(page.data.tournamentChips.length, 2)
  assert.equal(page.data.stageChips.length, 0)
  assert.equal(page.data.totalMatches, 3)
  page.onTournamentTap({ currentTarget: { dataset: { key: 'atp|China Open' } } })
  assert.equal(page.data.totalMatches, 2)
  assert.deepEqual(Array.from(page.data.stageChips, c => c.key), ['半决赛', '决赛'])
  page.onStageTap({ currentTarget: { dataset: { key: '半决赛' } } })
  assert.equal(page.data.totalMatches, 1)
  assert.equal(page.data.rows.find(r => r.type === 'match').match.id, 'a1')
  assert.equal(page.data.bracket, null)
  assert.match(page.shareHeadline().head, /ATP · 中国网球公开赛 · 半决赛/)
  page.onTournamentTap({ currentTarget: { dataset: { key: 'atp|Almaty Open' } } })
  assert.equal(page.data.stageFilter, '')
  assert.equal(page.data.totalMatches, 1)
  assert.equal(page.data.rows.find(r => r.type === 'match').match.id, 'b1')
  page.onCompTap({ currentTarget: { dataset: { key: 'wta' } } })
  assert.equal(page.data.tournamentFilter, '')
  assert.equal(page.data.tournamentChips[0].key, 'wta|China Open')
})

test('tennis schedule shares and restores the selected station, round and status', () => {
  const page = tennisSchedulePage()
  page.onLoad({ comp: 'atp', tournament: 'atp|China Open', round: '半决赛', mode: 'upcoming' })
  assert.equal(page.data.totalMatches, 1)
  const query = Object.fromEntries(new URLSearchParams(page.shareQuery()))
  assert.equal(query.tournament, 'atp|China Open')
  assert.equal(query.round, '半决赛')
  const other = tennisSchedulePage()
  other.onLoad(query)
  assert.equal(other.data.rows.find(r => r.type === 'match').match.id, 'a1')
  page.onModeTap({ currentTarget: { dataset: { mode: 'live' } } })
  assert.equal(page.data.totalMatches, 1)
  assert.equal(page.data.tournamentFilter, '')
  assert.equal(page.data.rows.find(r => r.type === 'match').match.id, 'live')
  const all = tennisSchedulePage()
  all.onLoad({ cat: 'tennis' })
  assert.equal(all.data.tournamentChips.length, 3)
  assert.ok(all.data.tournamentChips.every(c => /^(ATP|WTA) · /.test(c.label)))
  all.onTournamentTap({ currentTarget: { dataset: { key: 'wta|China Open' } } })
  assert.match(all.shareHeadline().head, /WTA · 中国网球公开赛/)
  const wxml = fs.readFileSync(path.join(__dirname, '../pages/schedule/schedule.wxml'), 'utf8')
  assert.match(wxml, /item\.match\._stageLabel/)
})

test('tennis Chinese names use full identity, tolerate accents and name order, and keep unknown names untouched', () => {
  const { nameZh, localizeMatch } = require('../utils/tennis-names')
  assert.equal(nameZh('Zhizhen Zhang'), '张之臻')
  assert.equal(nameZh('Zhang Zhizhen'), '张之臻')
  assert.equal(nameZh('Félix Auger-Aliassime'), nameZh('Felix Auger Aliassime'))
  assert.equal(nameZh('Hanyi Liu'), '刘汉屹')
  assert.equal(nameZh('Tianhui Zhang'), '张天汇')
  assert.equal(nameZh('Qu Yihan'), '渠依含')
  assert.equal(nameZh('Wang Xinyu'), '王欣瑜')
  assert.equal(nameZh('Wang Xiyu'), '王曦雨')
  assert.equal(nameZh('Wang'), '')
  assert.equal(nameZh('Unknown Player'), '')
  assert.equal(nameZh('constructor'), '')
  const original = { comp: 'atp', home: { id: '3623', name: 'Jannik Sinner', score: 2 }, away: { name: 'Unknown Player', zh: '已核实姓名', score: 0 } }
  const localized = localizeMatch(original)
  assert.equal(localized.home.zh, '扬尼克·辛纳')
  assert.equal(localized.home.name, original.home.name)
  assert.equal(localized.home.id, original.home.id)
  assert.equal(localized.home.score, 2)
  assert.equal(original.home.zh, undefined)
  assert.equal(localized.away.zh, '已核实姓名')
  const football = { ...original, comp: 'ucl' }
  assert.equal(localizeMatch(football), football)
})

test('all currently followable tennis players have Chinese display names and retain English search fields', () => {
  const data = require('../utils/data')
  const rankings = require('../data/tennis-rankings')
  for (const tour of ['atp', 'wta']) {
    const players = data.tennisPlayers(tour)
    assert.equal(players.length, rankings.tours[tour].length)
    for (const player of players) {
      assert.match(player.display, /[\u3400-\u9fff]/, player.name)
      assert.equal(player.display, player.zh)
      assert.equal(player.abbr, player.name)
      assert.ok(rankings.tours[tour].some(p => String(p.id) === player.id && p.name === player.name))
    }
  }
})

test('old English local and cloud tennis snapshots receive the same Chinese display overlay', () => {
  const filename = path.join(__dirname, '../utils/data.js')
  const actual = createRequire(filename)
  const match = { id: 'atp-old', comp: 'atp', home: { id: '3623', name: 'Jannik Sinner' }, away: { id: 'zhang', name: 'Zhizhen Zhang' } }
  const box = load('../utils/data.js', { require: name => name === '../data/matches.js' ? [match] : actual(name) })
  assert.equal(box.module.exports.matches()[0].away.zh, '张之臻')
  box.applyCloudSnapshot([match], { generatedAt: new Date().toISOString(), tennisRankings: { tours: { atp: [{ id: '3623', name: 'Jannik Sinner', rank: 1 }] } } })
  assert.equal(box.module.exports.matches()[0].home.zh, '扬尼克·辛纳')
  assert.equal(box.module.exports.tennisPlayers('atp')[0].display, '扬尼克·辛纳')
  assert.equal(match.home.zh, undefined)
})

test('old English player follows show Chinese without changing follow identity or schedule filtering', () => {
  const data = require('../utils/data')
  const names = require('../utils/tennis-names')
  const original = { comp: 'atp', id: 'cn-atp-zhang-zhizhen', name: 'Zhizhen Zhang', abbr: 'Zhizhen Zhang', display: 'Zhizhen Zhang' }
  const follows = load('../utils/team-follows.js', {
    wx: { getStorageSync: () => [original] },
    require: name => name === './data' ? data : name === './tennis-names' ? names : { isReady: () => false },
  }).module.exports
  assert.equal(follows.all()[0].display, '张之臻')
  assert.equal(follows.has(original.comp, original.id), true)
  assert.equal(follows.all()[0].name, original.name)
  assert.equal(data.matchHasTeam({ comp: 'atp', home: { id: 'espn-id', name: 'Zhang Zhizhen' }, away: {} }, follows.asFilter()[0]), true)
})

test('tennis notification names and result summary are Chinese even with an older English cloud row', () => {
  const { createMessage } = require('./match-notification-push')
  const m = { id: 'wta-old', comp: 'wta', start: '2026-10-15T10:00:00Z', status: 'finished',
    home: { name: 'Zheng Qinwen', score: 2 }, away: { name: 'Wang Xinyu', score: 0 } }
  const message = createMessage({ owner_id: 'wx:fixture', kind: 'result' }, m,
    { priTmplId: 'fixture', content: '参赛人员：{{thing9.DATA}}\n备注：{{thing11.DATA}}' }, 'trial')
  assert.equal(message.data.thing9.value, '郑钦文 vs 王欣瑜')
  assert.equal(message.data.thing11.value, '郑钦文以2-0战胜王欣瑜')
})

function weeklyRankingFeed(now) {
  return { asof_calc: new Date(now).toISOString(), snap_by: { atp: '2026-10-05', wta: '2026-10-12' },
    s: Array.from({ length: 110 }, (_, i) => ({ n: i === 0 ? 'Jannik Sinner' : i === 104 ? 'Zhizhen Zhang' : 'Player ' + i,
      c: i === 104 ? 'CHN' : 'USA', r: 110 - i, p: 90000 + i,
      or: i + 1, op: 10000 - i })) }
}

test('tennis weekly boards use only published rank and points, never the feeds live estimates', () => {
  const tool = require('./tennis-rankings')
  const now = Date.now(), feed = weeklyRankingFeed(now)
  const table = tool.normalize(feed, 'atp', now)
  assert.equal(table.rows.length, 101)
  assert.equal(table.rows[0].name, 'Jannik Sinner')
  assert.equal(table.rows[0].rank, 1)
  assert.equal(table.rows[0].points, 10000)
  assert.equal(table.rows.find(r => r.name === 'Zhizhen Zhang').rank, 105)
  assert.equal(table.rankingDate, '2026-10-05')
  assert.throws(() => tool.normalize({ ...feed, s: feed.s.slice(0, 99) }, 'atp', now), /前百/)
  assert.throws(() => tool.normalize({ ...feed, snap_by: { atp: 'invalid' } }, 'atp', now), /日期/)
  const broken = JSON.parse(JSON.stringify(feed)); broken.s[1].or = 1
  assert.throws(() => tool.normalize(broken, 'atp', now), /不完整/)
})

test('weekly ranking refresh retains each tours successful board on failure or a regressed ranking date', async () => {
  const tool = require('./tennis-rankings')
  const now = Date.now(), fakeFetch = async () => ({ ok: true, json: async () => weeklyRankingFeed(now) })
  const first = await tool.refresh({}, { now, fetch: fakeFetch })
  const errors = []
  const second = await tool.refresh(first, { now: now + 86400000,
    fetch: async url => { if (url.includes('atp')) throw Error('offline'); return { ok: true, json: async () => ({ ...weeklyRankingFeed(now), snap_by: { wta: '2026-10-05' } }) } },
    onError: tour => errors.push(tour) })
  assert.equal(errors.length, 2)
  assert.equal(second.atp.fetchedAt, first.atp.fetchedAt)
  assert.equal(second.wta.rankingDate, first.wta.rankingDate)
  assert.equal(second.wta.fetchedAt, first.wta.fetchedAt)
})

test('weekly board shows Chinese names, preserves zero points, filters China and resists older cloud snapshots', () => {
  const tool = require('./tennis-rankings'), view = require('../utils/tennis-rankings')
  const now = Date.now(), weekly = { atp: tool.normalize(weeklyRankingFeed(now), 'atp', now) }
  weekly.atp.rows[0].points = 0
  const world = view.board(weekly, 'atp', false, now)
  assert.equal(world.rows.length, 100)
  assert.equal(world.rows[0].name, '辛纳')
  assert.equal(world.rows[0].value, 0)
  const china = view.board(weekly, 'atp', true, now)
  assert.equal(china.rows[0].name, '张之臻')
  assert.equal(china.rows[0].pos, 105)
  assert.equal(view.board(weekly, 'atp', false, now + 30 * 86400000).stale, true)
  assert.equal(view.merge(weekly, {}).atp, weekly.atp)
  assert.equal(view.merge(weekly, { atp: { ...weekly.atp, rankingDate: '2026-09-28' } }).atp, weekly.atp)
})

test('ranking weekly mode preserves China filtering, player profile links and restorable sharing', () => {
  let page
  const app = { globalData: {} }
  let destination
  const filename = path.join(__dirname, '../pages/rank/rank.js'), actual = createRequire(filename)
  load('../pages/rank/rank.js', { Page: p => { page = p }, wx: { switchTab: opt => { destination = opt.url }, navigateTo:opt=>{destination=opt.url} },
    require: name => name.endsWith('/app-instance') ? { appInstance: () => app } : actual(name) })
  page.setData = (value, done) => { Object.assign(page.data, value); if (done) done() }
  page.buildShareImage = () => {}
  page.onLoad({ comp: 'atp', scope: 'china', mode:'weekly' })
  assert.equal(page.data.activeComp, 'atp')
  assert.equal(page.data.tier, 'tennis-weekly')
  assert.equal(page.data.tierKind, 'tennis')
  assert.equal(page.data.tiers.length, 1)
  assert.equal(page.data.rankRows.length, 10)
  assert.ok(page.data.comps.some(c => c.key === 'wta'))
  assert.ok(page.data.rankRows.every(r => r.country === 'CHN'))
  assert.match(page.onShareAppMessage().path, /scope=china/)
  page.onTennisScopeTap({ currentTarget: { dataset: { scope: 'all' } } })
  assert.equal(page.data.rankRows.length, 100)
  assert.equal(page.shareRows()[0].name, '辛纳')
  const row = page.data.rankRows[0]
  page.onTennisRowTap({ currentTarget: { dataset: { id: row.id } } })
  assert.match(destination,/tennis-player/);const params=new URLSearchParams(destination.split('?')[1]);assert.equal(params.get('name'),row.en);assert.equal(params.get('comp'),'atp')
  page.onCompTap({ currentTarget: { dataset: { key: 'wta' } } })
  assert.equal(page.data.rankRows.length, 100)
  assert.equal(page.data.tier, 'tennis-weekly')
})
