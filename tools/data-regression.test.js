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
