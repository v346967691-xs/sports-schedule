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

function followedHomeFixture() {
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
    Page: value => { page = value },
    wx: { navigateTo: value => destinations.push(value.url) },
    require: name => {
      if (name.endsWith('/app-instance')) return { appInstance: () => app }
      if (name.endsWith('/data')) return {
        matches: () => matches,
        compOf: key => ({ name: key, accent: '#14235c' }),
      }
      if (name.endsWith('/view')) return require('../utils/view')
      return {}
    },
  })
  page.data = { ...page.data, activeCat: 'basketball', activeDate: '2099-01-01' }
  page.setData = values => Object.assign(page.data, values)
  page.liveVisible = true
  return { page, app, matches, destinations }
}

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
    const page={...definition,liveVisible:true,build:()=>{},reload:()=>{}}
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

test('schedule tabs separate all 31 competitions and keep overnight live games', () => {
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
      categories:['football','basketball','esports'].map(key=>({key,competitions:comps.filter(c=>c.cat===key).map(c=>c.key)}))}
    :n==='./cloud'?{isReady:()=>false}:real(n)}).module.exports
  const pageRequire = createRequire(path.join(__dirname,'../pages/schedule/schedule.js'))
  let definition
  load('../pages/schedule/schedule.js',{Page:p=>{definition=p},require:n=>n==='../../utils/data'?data
    :n==='../../utils/view'||n==='../../utils/format'?pageRequire(n):n==='../../utils/bracket'?{koIndexOf:()=>-1}: {}})
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
