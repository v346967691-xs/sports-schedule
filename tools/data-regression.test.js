const test = require('node:test')
const assert = require('node:assert/strict')
const fs = require('fs')
const path = require('path')
const vm = require('vm')
const { createRequire } = require('module')

function load(file, overrides = {}) {
  const filename = path.join(__dirname, file)
  const box = {
    __dirname: path.dirname(filename), __filename: filename,
    require: createRequire(filename), module: { exports: {} },
    process: { argv: [], env: {} }, console,
    Date, AbortController, AbortSignal, setTimeout, clearTimeout, ...overrides,
  }
  vm.runInNewContext(fs.readFileSync(filename, 'utf8'), box, { filename })
  return box
}

test('MVP long poster exports all cumulative statistics, wrapped names and the mini-program code', async () => {
  const long = require('../utils/lol-mvp-poster')
  const values = [], images = [], exports = [], selected = []
  const ctx = {
    font: '', measureText(text) { return { width: [...String(text)].length * Number((this.font.match(/(\d+)px/) || [0, 20])[1]) } },
    fillRect() {}, fillText: value => values.push(String(value)), drawImage: img => images.push(img),
    scale() {}, clearRect() {},
  }
  const options = {
    comp: 'LPL', home: 'WE', away: 'FLY', homeScore: 3, awayScore: 2,
    dateText: '2026-10-14', timeText: '17:00', name: 'PlayerWithALongName', team: 'WE', role: '辅助',
    k: 0, d: 0, a: 55, cs: 177, gold: 46730, games: 5,
    champions: [{ name: 'Renata' }, { name: 'Nautilus' }, { name: 'Alistar' }], votes: 7, totalVotes: 20,
  }
  const height = long.measure(ctx, options)
  assert.ok(height > long.WIDTH)
  assert.equal(long.draw(ctx, { ...options, qr: {} }), height)
  assert.ok(values.includes('0 / 0 / 55'))
  assert.ok(values.includes('46730'))
  assert.ok(values.join('').includes(options.name))
  assert.ok(values.join('').includes('Renata / Nautilus / Alistar'))
  assert.ok(!values.some(value => /\d+\s*票|票数/.test(value)))
  assert.equal(images.length, 1)
  const canvas = {
    getContext: () => ctx,
    createImage: () => ({ set src(value) { this.path = value; Promise.resolve().then(() => this.onload()) } }),
  }
  const poster = load('../utils/poster.js', {
    wx: {
      getWindowInfo: () => ({ pixelRatio: 3 }),
      createSelectorQuery: () => ({ in() { return this }, select(id) { selected.push(id); return this },
        fields() { return this }, exec(callback) { callback([{ node: canvas }]) } }),
      canvasToTempFilePath: options => { exports.push(options); options.success({ tempFilePath: 'mvp-long.jpg' }) },
    },
  }).module.exports
  assert.equal(await poster.build({}, 'mvp-long-canvas', 'lol-mvp-long', options), 'mvp-long.jpg')
  assert.deepEqual(selected, ['#mvp-long-canvas'])
  assert.equal(exports[0].width, 750)
  assert.equal(exports[0].height, height)
  assert.equal(exports[0].destWidth, 1500)
  assert.equal(exports[0].destHeight, height * 2)
  assert.equal(images[1].path, '/images/worlds-miniprogram.jpg')
  await poster.build({}, 'share-canvas', 'lol-mvp', options)
  assert.equal(exports[1].width, 500)
  assert.equal(exports[1].height, 400)
  assert.equal(exports[1].destWidth, 1500)
  canvas.createImage = () => ({ set src(value) { Promise.resolve().then(() => this.onerror()) } })
  assert.equal(await poster.build({}, 'mvp-long-canvas', 'lol-mvp-long', options), '')
  assert.equal(exports.length, 2)
})

test('MVP long poster requires the recorded vote, prevents duplicate generation and unlocks after failures', async () => {
  let page, resolveExport
  const previews = [], calls = [], toasts = []
  load('../pages/detail/detail.js', {
    Page: value => { page = value },
    wx: { previewImage: value => previews.push(value), showToast: value => toasts.push(value) },
    require: name => {
      if (name.endsWith('/view')) return require('../utils/view')
      if (name.endsWith('/poster')) return { build: (...args) => {
        calls.push(args); return new Promise(resolve => { resolveExport = resolve })
      } }
      return {}
    },
  })
  page.data = { ...page.data, match: { id: 'lpl-test', home: { name: 'WE', score: 3 }, away: { name: 'FLY', score: 2 } },
    detail: { lolMvp: { myVote: '', totalVotes: 9, candidates: [
      { key: 'other', name: 'Other' }, { key: 'mine', name: 'MyPick', k: 4, d: 22, a: 55, votes: 7 },
    ] } } }
  page.setData = values => Object.assign(page.data, values)
  await page.generateLolMvpPoster()
  assert.equal(calls.length, 0)
  assert.match(toasts[0].title, /请先投出/)
  page.data.detail.lolMvp.myVote = 'mine'
  const exporting = page.generateLolMvpPoster()
  await page.generateLolMvpPoster()
  assert.equal(calls.length, 1)
  assert.equal(calls[0][1], 'mvp-long-canvas')
  assert.equal(calls[0][3].name, 'MyPick')
  assert.equal(calls[0][3].totalVotes, undefined)
  assert.equal(page.data.detail.lolMvp.totalVotes, 9)
  resolveExport('long.jpg')
  await exporting
  assert.deepEqual(Array.from(previews[0].urls), ['long.jpg'])
  assert.equal(page.data.mvpPosterBusy, false)
  const failed = page.generateLolMvpPoster()
  resolveExport('')
  await failed
  assert.equal(page.data.mvpPosterBusy, false)
  assert.equal(previews.length, 1)
  assert.match(toasts.at(-1).title, /生成失败/)
})

function followedHomeFixture() {
  const clock = { now: Date.parse('2026-10-14T21:00:00Z') }
  class Clock extends Date { static now() { return clock.now } }
  let poll
  const matches = [
    ['up-lol-late', 'lpl', 'upcoming', '2026-10-15T10:00:00Z'],
    ['done-foot-old', 'ucl', 'finished', '2026-10-13T18:00:00Z'],
    ['live-foot', 'ucl', 'live', '2026-10-14T18:00:00Z'],
    ['up-nba-near', 'nba', 'upcoming', '2026-10-15T01:00:00Z'],
    ['done-lol-new', 'lpl', 'finished', '2026-10-14T10:00:00Z'],
    ['not-followed', 'nba', 'live', '2026-10-14T20:00:00Z'],
  ].map(([id, comp, status, start]) => ({
    id, comp, status, start, date: start.slice(0, 10), time: '02:00',
    home: { name: 'Home', abbr: 'H', score: status === 'upcoming' ? null : 0 },
    away: { name: 'Away', abbr: 'A', score: status === 'upcoming' ? null : 1 },
  }))
  const app = {
    globalData: { authState: 'signed-in', favIds: matches.slice(0, 5).map(m => m.id) },
    refreshAuth: async () => {},
  }
  const destinations = []
  let page
  load('../pages/index/index.js', {
    Date: Clock,
    setInterval: callback => { poll = callback; return 1 },
    clearInterval: () => { poll = null },
    Page: value => { page = value },
    wx: { navigateTo: value => destinations.push(value.url) },
    require: name => {
      if (name.endsWith('/app-instance')) return { appInstance: () => app }
      if (name.endsWith('/data')) return {
        matches: () => matches,
        needsLivePoll: () => false,
        compOf: key => ({ name: key, accent: '#14235c' }),
      }
      if (name.endsWith('/view')) return require('../utils/view')
      return {}
    },
  })
  page.data = { ...page.data, activeCat: 'basketball', activeDate: '2099-01-01' }
  page.setData = values => Object.assign(page.data, values)
  page.liveVisible = true
  return { page, app, matches, destinations, clock, tick: () => poll() }
}

test('homepage followed results expire only after 48 hours while live and upcoming matches remain', () => {
  const { page, app, matches, clock } = followedHomeFixture()
  const add = (id, status, age) => {
    const match = { ...matches[0], id, status, start: new Date(clock.now - age).toISOString() }
    matches.push(match)
    app.globalData.favIds.push(id)
  }
  const hours48 = 48 * 3600000
  add('done-at-limit', 'finished', hours48)
  add('done-too-old', 'finished', hours48 + 1)
  add('live-long-series', 'live', hours48 + 1)
  add('up-overdue', 'upcoming', hours48 + 1)
  add('done-invalid-time', 'finished', 0)
  matches.find(m => m.id === 'done-invalid-time').start = 'invalid'
  const favIds = app.globalData.favIds.slice()
  page.buildFollowedMatches()
  const shown = Array.from(page.data.followedMatches, m => m.id)
  assert.ok(shown.includes('done-at-limit'))
  assert.ok(!shown.includes('done-too-old'))
  assert.ok(shown.includes('live-long-series'))
  assert.ok(shown.includes('up-overdue'))
  assert.ok(!shown.includes('done-invalid-time'))
  assert.deepEqual(app.globalData.favIds, favIds)
})

test('homepage expires followed results while visible even when no live request is needed', () => {
  const { page, app, matches, clock, tick } = followedHomeFixture()
  app.globalData.favIds = ['done-lol-new']
  const match = matches.find(m => m.id === 'done-lol-new')
  match.start = new Date(clock.now - 48 * 3600000).toISOString()
  page.buildFollowedMatches()
  assert.equal(page.data.followedMatches.length, 1)
  page.startLivePoll()
  clock.now += 1
  tick()
  assert.equal(page.data.followedMatches.length, 0)
  page.stopLivePoll()
})

test('homepage followed matches span sports and all states in live, finished, upcoming order', () => {
  const { page, matches, destinations } = followedHomeFixture()
  const originalOrder = matches.map(m => m.id)
  page.buildFollowedMatches()
  assert.deepEqual(Array.from(page.data.followedMatches, m => m.id), [
    'live-foot', 'done-lol-new', 'done-foot-old', 'up-nba-near', 'up-lol-late',
  ])
  assert.deepEqual(matches.map(m => m.id), originalOrder)
  assert.equal(page.data.followedMatches[0]._hasScore, true)
  assert.equal(page.data.followedMatches[0].home.score, 0)
  assert.equal(page.data.followedMatches[3]._hasScore, false)
  page.goDetail({ currentTarget: { dataset: { id: page.data.followedMatches[1].id } } })
  assert.deepEqual(destinations, ['/pages/detail/detail?id=done-lol-new'])
})

test('homepage followed section disappears on unfollow or sign-out even with stale IDs', () => {
  const { page, app } = followedHomeFixture()
  page.buildFollowedMatches()
  assert.equal(page.data.followedMatches.length, 5)
  app.globalData.favIds = []
  page.buildFollowedMatches()
  assert.equal(page.data.followedMatches.length, 0)
  app.globalData.favIds = ['live-foot']
  app.globalData.authState = 'signed-out'
  page.buildFollowedMatches()
  assert.equal(page.data.followedMatches.length, 0)
})

test('homepage refreshes followed matches after cloud auth and displays subsequent live score changes', async () => {
  const { page, app, matches } = followedHomeFixture()
  app.globalData.authState = 'unknown'
  app.globalData.favIds = []
  page.buildFollowedMatches()
  assert.equal(page.data.followedMatches.length, 0)
  app.refreshAuth = async () => {
    app.globalData.authState = 'signed-in'
    app.globalData.favIds = ['up-nba-near']
  }
  await page.loadFollowedMatches()
  assert.equal(page.data.followedMatches[0].status, 'upcoming')
  const match = matches.find(m => m.id === 'up-nba-near')
  match.status = 'live'
  match.home.score = 105
  match.away.score = 103
  page.buildFollowedMatches()
  assert.equal(page.data.followedMatches[0].home.score, 105)
  assert.equal(page.data.followedMatches[0]._hasScore, true)
  match.status = 'finished'
  page.buildFollowedMatches()
  assert.equal(page.data.followedMatches[0]._homeWin, true)
  app.refreshAuth = async () => { app.globalData.favIds = [] }
  await page.loadFollowedMatches()
  assert.equal(page.data.followedMatches.length, 0)
  page.liveVisible = false
  app.refreshAuth = async () => { app.globalData.favIds = ['live-foot'] }
  await page.loadFollowedMatches()
  assert.equal(page.data.followedMatches.length, 0)
})

test('following a match never reports notification success when saving consent fails', async () => {
  const toasts = []
  let page
  let finish
  const settled = new Promise(resolve => { finish = resolve })
  const config = require('../utils/match-notification-config')
  const app = { globalData: { authState: 'signed-in' }, refreshFavorites: async () => {}, isFav: () => true }
  load('../pages/detail/detail.js', {
    Page: value => { page = value },
    require: name => {
      if (name.endsWith('/app-instance')) return { appInstance: () => app }
      if (name.endsWith('/favorites')) return { add: async () => ({ error: null }) }
      if (name.endsWith('/match-notification-config')) return config
      if (name.endsWith('/match-notifications')) return { subscribe: async () => ({ error: { message: 'network failure' } }) }
      return {}
    },
    wx: {
      showToast: value => toasts.push(value),
      requestSubscribeMessage: options => options.success(Object.fromEntries(options.tmplIds.map(id => [id, 'accept']))),
    },
  })
  page.data = { match: { id: 'epl-test', comp: 'epl', status: 'upcoming', start: new Date(Date.now() + 3600000).toISOString() }, isFav: false }
  page.setData = values => Object.assign(page.data, values)
  page.loadNotificationStates = () => finish()
  page.onFavTap()
  await settled
  assert.equal(page.data.isFav, true)
  assert.equal(toasts.length, 1)
  assert.match(toasts[0].title, /通知未保存/)
  assert.equal(toasts[0].icon, 'none')
})

test('LOL fast lane sends its authentication header for all leagues', async () => {
  const requests = []
  const box = load('live-watch.js', {
    fetch: async (url, options) => {
      requests.push(options.headers)
      return { ok: true, json: async () => ({ data: { schedule: { events: [] } } }) }
    },
  })
  await box.module.exports.scanLol()
  assert.equal(requests.length, 7)
  assert.ok(requests.every(h => h['x-api-key']))
})

test('LOL fast lane keeps recent last-good rows for a failed league only', () => {
  const { preserveLastGoodLolRows } = require('./live-watch')
  const now = Date.parse('2026-10-13T12:00:00Z')
  const previous = {
    rows: [
      { id: 'lpl-1', st: 'live', hs: 2, as: 1 },
      { id: 'lck-2', st: 'live', hs: 1, as: 0 },
      { id: 'kpl-3', st: 'live', hs: 4, as: 2 },
    ],
  }
  const sources = {
    'lol:lpl': { ok: false, lastSuccess: new Date(now - 4 * 60000).toISOString() },
    'lol:lck': { ok: false, lastSuccess: new Date(now - 16 * 60000).toISOString() },
  }
  const current = [{ id: 'nba-9', st: 'live', hs: 8, as: 7 }]
  const rows = preserveLastGoodLolRows(current, previous, ['lpl', 'lck'], sources, now)
  assert.deepEqual(rows.map(r => r.id).sort(), ['lpl-1', 'nba-9'])
  assert.equal(rows.find(r => r.id === 'lpl-1').hs, 2)
})

test('CBA uses official finished status even when quarter remains 4', async () => {
  const now = Date.parse('2026-10-11T12:30:00Z')
  class Clock extends Date { static now() { return now } }
  const box = load('live-watch.js', {
    Date: Clock,
    fetch: async () => ({ ok: true, json: async () => ({ data: [{
      ScheduleID: 100110436, Status: 4, Quarter: 4, Minutes: 0, Seconds: 0,
      HomeTeamScore: 83, VisitingTeamScore: 86, dates: '2026-10-11', time: '19:30',
    }] }) }),
  })
  const result = await vm.runInContext('scanCba()', vm.createContext(box))
  assert.equal(result.rows[0].st, 'finished')
  assert.equal(result.rows[0].stt, '已结束')
})

test('CBA continues collecting a live game after two hours', async () => {
  class Clock extends Date { static now() { return Date.parse('2026-10-11T14:00:00Z') } }
  const box = load('live-watch.js', {
    Date: Clock,
    fetch: async () => ({ ok: true, json: async () => ({ data: [{
      ScheduleID: 1, Status: 2, Quarter: 5, Minutes: 2, Seconds: 10,
      HomeTeamScore: 100, VisitingTeamScore: 100, dates: '2026-10-11', time: '19:30',
    }] }) }),
  })
  const result = await vm.runInContext('scanCba()', vm.createContext(box))
  assert.equal(result.rows.length, 1)
  assert.equal(result.rows[0].st, 'live')
})

test('a pre-final football detail is retried despite form/lineup content', () => {
  const box = load('cloud-sync.js')
  const result = vm.runInContext(`(() => {
    const source = ${JSON.stringify(fs.readFileSync(path.join(__dirname, 'cloud-sync.js'), 'utf8'))};
    const text = source.match(/const isShell = \\(d, id, o\\) => \\{[\\s\\S]*?\\n    \\}/)[0];
    const fn = eval('(' + text.replace('const isShell = ', '') + ')');
    return fn({fin:false, lineups:{home:[]}}, 'epl-1', {hs:3,as:1});
  })()`, vm.createContext(box))
  assert.equal(result, true)
})

test('the detail fast lane supplements missing MVP candidates even when the final score and timeline are complete', () => {
  const box = load('cloud-sync.js')
  const source = fs.readFileSync(path.join(__dirname, 'cloud-sync.js'), 'utf8')
  const functionText = source.match(/const isShell = \(d, id, o\) => \{[\s\S]*?\n    \}/)[0]
  box.mvpShellFunction = functionText.replace('const isShell = ', '')
  const result = vm.runInContext(`(() => {
    const check = eval('(' + mvpShellFunction + ')');
    const final = {fin:true, events:[{goal:true}]};
    return [check(final, 'nba-1', {}), check(final, 'epl-1', {}),
      check({...final,mvp:{v:1,complete:true}}, 'epl-1', {}),
      check({...final,lol:{complete:true}}, 'lpl-1', {})];
  })()`, vm.createContext(box))
  assert.deepEqual(Array.from(result), [true, true, false, false])
})

test('partial day-bucket updates do not reset the bulk detail clock', async () => {
  const box = load('cloud-sync.js')
  const rows = [
    { id:'d-old', updated_at:new Date(Date.now()-5*3600000).toISOString() },
    { id:'d-today', updated_at:new Date().toISOString() },
  ]
  box.auditCloud = { database: { from: () => ({ select: async () => ({data:rows}) }) } }
  const age = await vm.runInContext('detailAgeMin(auditCloud)', vm.createContext(box))
  assert.ok(age >= 299)
})

test('a failed detail job cannot upload a stripped bundle and erase cloud LOL data', () => {
  const filename=path.join(__dirname,'cloud-sync.js')
  const real=createRequire(filename)
  const box=load('cloud-sync.js',{require:n=>n==='fs'?{...fs,existsSync:()=>false}:real(n)})
  assert.equal(vm.runInContext('readDetails()',vm.createContext(box)),null)
})

function feedFixture(state = 'finished') {
  const team = (id, start) => ({ esportsTeamId:id, participantMetadata:Array.from({length:5}, (_,i) => ({
    participantId:start+i, summonerName:`Player${start+i}`, championId:'Ashe', role:['top','jungle','mid','bottom','support'][i],
  })) })
  const stats = start => ({ totalKills:5, totalGold:40000, towers:6, barons:1, dragons:['cloud'],
    participants:Array.from({length:5}, (_,i) => ({participantId:start+i,kills:i,deaths:1,assists:3,creepScore:200,totalGold:8000})),
  })
  return { esportsGameId:'g',esportsMatchId:'m', gameMetadata:{blueTeamMetadata:team('away',1),redTeamMetadata:team('home',6)},
    frames:[{rfc460Timestamp:new Date().toISOString(),gameState:state,blueTeam:stats(1),redTeam:stats(6)}] }
}

test('LOL aligns home/away by team ID after a side swap, preserving real zero stats', () => {
  const {pickRound}=require('./lol-detail')
  const r=pickRound({id:'g',number:1},feedFixture(),'home','away')
  assert.equal(r.h.side,'red')
  assert.equal(r.h.players[0].name,'Player6')
  assert.equal(r.a.players[0].k,0)
  assert.equal(r.complete,true)
  assert.equal(Object.hasOwn(r,'winner'),false)
})

test('LOL paused frames and missing player statistics cannot be final results', () => {
  const {pickRound}=require('./lol-detail')
  assert.equal(pickRound({id:'g',number:1},feedFixture('paused'),'home','away').complete,false)
  const f=feedFixture()
  f.frames[0].redTeam.participants.pop()
  const r=pickRound({id:'g',number:1},f,'home','away')
  assert.equal(r.complete,false)
  assert.equal(r.h.players[4].k,null)
  assert.equal(pickRound({id:'g',number:1},f,'unknown','away').h,null)
})

test('LOL validates match identity and does not turn a failed feed into zero stats', async () => {
  const {fetchLolDetail}=require('./lol-detail')
  const m={id:'lpl-m',comp:'lpl',home:{id:'H',score:1},away:{id:'A',score:0},status:'finished'}
  const event={data:{event:{id:'m',match:{teams:[{id:'home',code:'H'},{id:'away',code:'A'}],games:[{id:'g',number:1,state:'completed'}]}}}}
  const d=await fetchLolDetail(m,async u => u.includes('getEventDetails') ? event : feedFixture())
  assert.equal(d.lol.complete,true)
  await assert.rejects(()=>fetchLolDetail(m,async()=>({data:{event:{id:'wrong',match:{}}}})),/结构不完整/)
  const missing=await fetchLolDetail(m,async u => {if(u.includes('getEventDetails'))return event;throw new Error('HTTP 404')})
  assert.equal(missing.lol.complete,false)
  assert.equal(missing.lol.rounds[0].h,null)
})

function client(row, base = Date.now()-60000) {
  const filename=path.join(__dirname,'../utils/data.js')
  const real=createRequire(filename)
  const match={id:'epl-1',comp:'epl',status:'live',start:new Date().toISOString(),home:{score:2},away:{score:0}}
  const cloud={isReady:()=>true,cloud:{database:{from:()=>({select:()=>({eq:()=>({maybeSingle:async()=>({data:row})})})})}}}
  return load('../utils/data.js',{require:n=>n==='./cloud'?cloud:n==='../data/meta.js'?{generatedAt:new Date(base).toISOString(),competitions:[],categories:[]}
    :n==='../data/matches.js'?[match]:real(n)})
}

test('old or stale live patches do not overwrite a newer snapshot', async () => {
  for(const age of [5*60000,20*60000]) {
    const b=client({generated_at:new Date(Date.now()-age).toISOString(),data:{rows:[{id:'epl-1',st:'live',hs:1,as:0}]}})
    const r=await b.module.exports.refreshLive(true)
    assert.equal(r.patched,0)
    assert.equal(b.module.exports.matches()[0].home.score,2)
  }
  const b=client({generated_at:new Date().toISOString(),data:{rows:[{id:'epl-1',st:'finished',hs:3,as:0}]}})
  assert.equal((await b.module.exports.refreshLive(true)).patched,1)
  assert.equal(b.module.exports.matches()[0].home.score,3)
})

test('client discovers upcoming games in the opening window', () => {
  const b=client(null)
  const near=n=>({status:'upcoming',start:new Date(Date.now()+n*60000).toISOString()})
  assert.equal(b.module.exports.needsLivePoll(near(20)),true)
  assert.equal(b.module.exports.needsLivePoll(near(45)),false)
  assert.equal(b.module.exports.needsLivePoll(near(-20)),true)
})

for(const name of ['index','schedule']) {
  test(`${name} discovers starts without a live game and does not rearm after hiding`, async()=>{
    const filename=path.join(__dirname,`../pages/${name}/${name}.js`)
    const real=createRequire(filename)
    let definition, timer, requests=0, near=false, cleared=0
    const data={refreshLive:async()=>{requests++;return{patched:0}},needsLivePoll:()=>near}
    load(`../pages/${name}/${name}.js`,{Page:p=>{definition=p},require:n=>n==='../../utils/data'?data
      : n==='../../utils/format'?real(n):{},
      setInterval:fn=>{timer=fn;return 1},clearInterval:()=>{timer=null;cleared++}})
    const page={...definition,liveVisible:true,build:()=>{},reload:()=>{},buildFollowedMatches:()=>{}}
    page.syncLivePoll()
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal(typeof timer,'function')
    const initial=requests
    timer();assert.equal(requests,initial)
    near=true;timer();await new Promise(resolve=>setImmediate(resolve))
    assert.equal(requests,initial+1)
    page.onHide();assert.ok(cleared>0)
    page.liveVisible=true;page.syncLivePoll();page.onHide()
    await new Promise(resolve=>setImmediate(resolve))
    assert.equal(timer,null)
  })
}

test('detail waits for the final result but stops after completion or timeout', () => {
  const filename=path.join(__dirname,'../pages/detail/detail.js')
  const real=createRequire(filename)
  let definition, timer
  load('../pages/detail/detail.js',{Page:p=>{definition=p},require:()=>({}),
    setInterval:fn=>{timer=fn;return 1},clearInterval:()=>{timer=null}})
  const page={...definition,data:{match:{status:'finished'}},liveVisible:true,detailPollUntil:Date.now()+1200000}
  page.syncLivePoll();assert.equal(typeof timer,'function')
  page.finalDetailReady=true;page.syncLivePoll();assert.equal(timer,null)
  page.finalDetailReady=false;page.detailPollUntil=Date.now()-1;page.syncLivePoll();assert.equal(timer,null)
})

test('schedule tabs separate all competitions and keep overnight live games', () => {
  const comps = require('./sync').COMPETITIONS
  const fmt = require('../utils/format')
  const today = fmt.todayStr()
  const real = createRequire(path.join(__dirname, '../utils/data.js'))
  const fixtures = comps.flatMap(c => ['upcoming', 'live', 'finished'].map(status => ({
    id: `${c.key}-${status}`, comp: c.key, status,
    start: new Date(Date.now() + (status === 'upcoming' ? 3600000 : -10800000)).toISOString(),
    date: status === 'live' ? fmt.shiftDay(today, -1) : today, time:'12:00', stage:'',
    home: {id:`${c.key}-home`,name:'Home',score:status==='upcoming'?null:1},
    away: {id:`${c.key}-away`,name:'Away',score:status==='upcoming'?null:0},
  })))
  const data = load('../utils/data.js', {require:n=>n==='../data/matches.js'?fixtures
    :n==='../data/meta.js'?{generatedAt:new Date().toISOString(),competitions:comps,
      categories:['football','basketball','esports','tennis'].map(key=>({key,competitions:comps.filter(c=>c.cat===key).map(c=>c.key)}))}
    :n==='./cloud'?{isReady:()=>false}:real(n)}).module.exports
  const pageRequire = createRequire(path.join(__dirname,'../pages/schedule/schedule.js'))
  let definition
  load('../pages/schedule/schedule.js',{Page:p=>{definition=p},require:n=>n==='../../utils/data'?data
    :n==='../../utils/view'||n==='../../utils/format'||n==='../../utils/tennis'?pageRequire(n):n==='../../utils/bracket'?{koIndexOf:()=>-1}: {}})
  const page={...definition,data:{...definition.data},buildShareImage:()=>{},
    setData(p,cb){Object.assign(this.data,p);if(cb)cb()}}
  for(const c of comps) for(const mode of ['upcoming','live','finished']) {
    Object.assign(page.data,{activeCat:c.cat,activeComp:c.key,mode})
    page.doReload()
    assert.equal(page.data.totalMatches,1,`${c.key}/${mode}`)
    assert.ok(page.data.rows.filter(r=>r.type==='match').every(r=>r.match.status===mode),`${c.key}/${mode}`)
  }
})

test('a competition without upcoming games does not show finished games in the upcoming tab', () => {
  let definition
  const filename=path.join(__dirname,'../pages/schedule/schedule.js')
  const real=createRequire(filename)
  const game={id:'lpl-done',comp:'lpl',status:'finished',date:'2026-10-11',start:new Date().toISOString(),home:{name:'H'},away:{name:'A'}}
  const data={matches:()=>[game],upcoming:()=>[],finished:()=>[game],query:()=>[],compOf:()=>({name:'LPL'}),
    staleInfo:()=>({stale:false}),source:()=> 'bundle',generatedAt:()=>'',standingsOf:()=>null}
  load('../pages/schedule/schedule.js',{Page:p=>{definition=p},require:n=>n==='../../utils/data'?data
    :n==='../../utils/view'||n==='../../utils/format'?real(n):n==='../../utils/bracket'?{koIndexOf:()=>-1}:{}})
  const page={...definition,data:{...definition.data,activeCat:'esports',activeComp:'lpl'},buildShareImage:()=>{},
    setData(p,cb){Object.assign(this.data,p);if(cb)cb()}}
  page.doReload()
  assert.equal(page.data.totalMatches,0)
})

test('LOL champion portraits use the selected champion ID and retain a text fallback', () => {
  const {buildLol}=require('../utils/lol-view')
  const p={id:1,name:'Player',champion:'MonkeyKing',role:'top',k:0,d:1,a:2,cs:100,gold:5000}
  const view=buildLol({lol:{rounds:[{id:'g',n:1,complete:true,h:{players:[p]},a:null}]}},'H','A')
  assert.equal(view.rounds[0].teams[0].players[0].icon,'https://game.gtimg.cn/images/lol/act/img/champion/MonkeyKing.png')
  p.champion='../../invalid'
  const fallback=buildLol({lol:{rounds:[{id:'g',n:1,h:{players:[p]},a:null}]}},'H','A')
  assert.equal(fallback.rounds[0].teams[0].players[0].icon,'')
  assert.equal(fallback.rounds[0].teams[0].players[0].champion,'../../invalid')
})

test('an unavailable LOL portrait clears only that player image, keeping their name and stats', () => {
  let definition, patch
  load('../pages/detail/detail.js',{Page:p=>{definition=p},require:()=>({})})
  const player={name:'JDG Player',champion:'Ashe',icon:'https://example/icon.png',kda:'1 / 2 / 3'}
  const page={...definition,data:{detail:{lol:{rounds:[{rows:[{players:[player,null]}]}]}}},setData:p=>{patch=p}}
  page.onLolHeroError({currentTarget:{dataset:{round:0,row:0,side:0}}})
  assert.equal(patch['detail.lol.rounds[0].rows[0].players[0].icon'],'')
  assert.equal(player.champion,'Ashe')
  assert.equal(player.kda,'1 / 2 / 3')
  patch=null
  page.onLolHeroError({currentTarget:{dataset:{round:-1,row:0,side:0}}})
  assert.equal(patch,null)
})
