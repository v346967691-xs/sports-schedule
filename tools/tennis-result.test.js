const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm'),{createRequire}=require('module')
const result=require('../utils/tennis-result'),view=require('../utils/view'),tree=require('../utils/tournament-bracket')
const retired={id:'atp-retired',comp:'atp',date:'2026-10-16',time:'12:00',start:'2026-10-16T04:00:00Z',status:'finished',statusText:'退赛',stage:'Shanghai · Quarterfinal',winnerId:'away',
  home:{id:'home',name:'Retiring Player',score:1},away:{id:'away',name:'Winning Player',score:0},sets:{h:[6,1],a:[4,4]}}
test('retirement display keeps the actual score and uses the confirmed winner for retirement labels and preserves the raw scores and actual sets',()=>{
  const before=JSON.stringify(retired),shown=result.display(retired)
  assert.equal(shown.home.score,1);assert.equal(shown.away.score,0)
  assert.equal(shown.home.retired,true);assert.equal(shown.away.retired,false)
  assert.equal(shown.sets,retired.sets);assert.equal(JSON.stringify(retired),before)
  const card=view.decorate(retired)
  assert.equal(card._awayWin,true);assert.equal(card._homeWin,false)
  assert.equal(tree.tennisEntries([retired])[0].sides[0].retired,true)
  assert.equal(tree.tennisEntries([retired])[0].sides[1].score,0)
})
test('missing winners, ordinary finished matches and matches still playing cannot become guessed retirement wins',()=>{
  const unknown=result.display({...retired,winnerId:''})
  assert.equal(unknown.home.score,1);assert.equal(unknown.away.score,0);assert.equal(unknown._retirementPending,true)
  assert.equal(unknown.home.retired,undefined)
  const card=view.decorate({...retired,winnerId:''})
  assert.equal(card._homeWin,false);assert.equal(card._awayWin,false)
  const live={...retired,status:'live'};assert.equal(result.display(live),live)
  const normal={...retired,statusText:'已结束'};assert.equal(result.display(normal),normal)
  const other={...retired,comp:'nba'};assert.equal(result.display(other),other)
})
test('the screenshot match shows Gea as the retiree while its actual 1:4 first set remains untouched',()=>{
  const match={...retired,id:'atp-184955',winnerId:'3212',home:{id:'10427',name:'Arthur Gea',score:0},away:{id:'3212',name:'Alejandro Davidovich Fokina',score:0},sets:{h:[1],a:[4]}}
  const snapshot=require('../utils/snapshot');const card=view.decorate(snapshot.decodeSnapshot(snapshot.encodeSnapshot([match]))[0])
  assert.equal(card.home.retired,true);assert.equal(card.home.score,0);assert.equal(card.away.score,0)
  assert.deepEqual(card.sets,{h:[1],a:[4]})
})
test('live overlays apply confirmed winners and legacy finished patches cannot erase a known retirement',async()=>{
  const filename=path.resolve(__dirname,'../utils/data.js'),actual=createRequire(filename),now=Date.now()
  let patch={id:retired.id,st:'finished',stt:'退赛',hs:1,as:0,wi:'away'}
  const cloud={isReady:()=>true,cloud:{database:{from:()=>({select(){return this},eq(){return this},maybeSingle:async()=>({data:{generated_at:new Date(now).toISOString(),data:{rows:[patch]}}})})}}}
  const box={module:{exports:{}},console,Date,__dirname:path.dirname(filename),require:name=>name==='./cloud'?cloud
    :name==='../data/matches.js'?[{...retired,status:'live',statusText:'第2盘进行中',winnerId:''}]
    :name==='../data/meta.js'?{generatedAt:new Date(now-60000).toISOString(),competitions:[{key:'atp',cat:'tennis'}],categories:[]}:actual(name)}
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),box,{filename});const data=box.module.exports
  await data.refreshLive(true)
  assert.equal(data.findMatch(retired.id).winnerId,'away')
  assert.equal(view.decorate(data.findMatch(retired.id)).away.score,0)
  patch={...patch,stt:'已结束',wi:undefined};await data.refreshLive(true)
  assert.equal(data.findMatch(retired.id).statusText,'退赛')
})

test('seed numbers survive snapshots and station archives without leaking across events',()=>{
  const snapshot=require('../utils/snapshot'),archive=require('../utils/tennis-event')
  const match={...retired,home:{...retired.home,seed:5},away:{...retired.away,seed:1},eventId:'fixture-2026',eventStart:retired.start,eventEnd:retired.start}
  const restored=snapshot.decodeSnapshot(snapshot.encodeSnapshot([match]))[0]
  assert.equal(restored.home.seed,5);assert.equal(restored.away.seed,1)
  const packed=archive.buildArchive([match],null,Date.parse(retired.start));const row=archive.archiveRows(packed)[0]
  assert.equal(row.home.seed,5);assert.equal(row.away.seed,1)
  assert.equal(tree.tennisEntries([row])[0].sides[0].seed,5)
  const another={...match,id:'atp-another',home:{...match.home,seed:2}}
  const rows=snapshot.decodeSnapshot(snapshot.encodeSnapshot([match,another]))
  assert.equal(rows.find(r=>r.id===match.id).home.seed,5);assert.equal(rows.find(r=>r.id===another.id).home.seed,2)
})
