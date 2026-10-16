const test = require('node:test')
const assert = require('node:assert/strict')
const source = require('./tennis-insights')
const view = require('../utils/tennis-insights')
const now = Date.parse('2026-10-16T04:00:00Z')
function feed() {
  return { asof_calc: new Date(now).toISOString(), snap: '2026-10-12', race_snap: { atp_race: '2026-10-16' },
    s: Array.from({length:101}, (_,i)=>({n:`Player ${i+1}`,c:i===100?'CHN':'USA',r:i+1,p:10000-i*10,or:i+2,op:10000-i*10-5,
      got:[['Shanghai','QF',200,'2026-10-16']],gone:[['Old event','R32',195,'2025-10-01']]})),
    r: Array.from({length:30}, (_,i)=>({n:`Player ${i+1}`,c:'USA',r:i+1,p:9000-i*100})), week:[] }
}
test('live points use the provided current total and show net changes without adding result points twice',()=>{
  const p=source.normalize(feed(),'atp',new Map(),now)
  const b=view.board(p,false,now)
  assert.equal(b.rows.length,100);assert.equal(b.rows[0].value,10000);assert.equal(b.rows[0].delta,5)
  assert.equal(view.pointsDetails(p.players[0]).gains[0].points,200)
  assert.equal(view.board(p,true,now).rows.length,1)
  const broken=feed();broken.s[0].p=null
  assert.throws(()=>source.normalize(broken,'atp',new Map(),now),/前百/)
})
test('live normalization rejects stale timestamps, incomplete race leaders and never substitutes live for official weekly values',()=>{
  const p=source.normalize(feed(),'atp',new Map(),now)
  assert.equal(p.players[0].officialPoints,9995)
  assert.throws(()=>source.normalize({...feed(),asof_calc:'2026-10-01T00:00:00Z'},'atp',new Map(),now),/过旧/)
  assert.throws(()=>source.normalize({...feed(),r:[]},'atp',new Map(),now),/年度积分/)
})
test('official entry parsers separate singles and qualifying and keep withdrawal status',()=>{
  const html='<div data-ui-tab="Singles"><article class="tournament-player-card" data-player-name="A Player" data-filter="withdrawn"></article></div>'
    +'<div data-ui-tab="Doubles"><article class="tournament-player-card" data-player-name="Doubles Only" data-filter="playing"></article></div>'
    +'<div data-ui-tab="Qualifying"><article class="tournament-player-card" data-player-name="B Player" data-filter="playing"></article></div>'
  const rows=source.parseWtaEntries(html)
  assert.equal(rows.length,2);assert.equal(rows[0].status,'withdrawn');assert.equal(rows[1].role,'qualifying')
  const finals='<div data-rankings-date="2026-10-12"><tr data-player-name="A Player"><span class="qualified-label--large">Qualified</span></tr></div>'
  assert.deepEqual(source.parseFinalists(finals,'wta',2026).names,['a player'])
  assert.throws(()=>source.parseFinalists(finals,'wta',2027),/届次/)
})
test('current world rank alone grants neither ordinary tournament entry nor locked Finals qualification',()=>{
  const p=source.normalize(feed(),'atp',new Map(),now),player=p.players[0]
  p.calendar=[{name:'Upcoming Open',start:'2026-10-20',end:'2026-10-25'}]
  assert.equal(view.participation(p,player,[],now)[0].tone,'pending')
  assert.equal(view.finalsStatus(p,player,now).title,'暂居直接资格区')
  assert.equal(view.finalsStatus(p,player,now).tone,'contending')
  p.finals={names:[player.key],kind:'official-qualified',checkedAt:new Date(now).toISOString()}
  assert.equal(view.finalsStatus(p,player,now).title,'官方已确认入围')
  assert.notEqual(view.finalsStatus(p,p.players[7],now).tone,'confirmed')
})
test('known draws and official entry lists provide distinct participation evidence; a withdrawal overrides a stale draw',()=>{
  const p=source.normalize(feed(),'wta',new Map(),now),player=p.players[0]
  p.calendar=[{name:'Guangzhou Open',start:'2026-10-19',end:'2026-10-25'}]
  p.entryLists=[{name:'Guangzhou Open',start:'2026-10-19',checkedAt:new Date(now).toISOString(),entries:[{key:player.key,role:'qualifying',status:'playing'}]}]
  assert.equal(view.participation(p,player,[],now)[0].title,'官方资格赛名单列名')
  p.entryLists[0].entries[0].status='withdrawn'
  assert.equal(view.participation(p,player,[{id:'wta-1',comp:'wta',stage:'Guangzhou Open · Round 1',date:'2026-10-19',status:'upcoming'}],now)[0].tone,'withdrawn')
})
test('profile matching rejects another athlete and a transient missing profile is not fabricated',()=>{
  assert.equal(source.profileOf({athlete:{displayName:'Another Player'}},'Player One',now),null)
  assert.equal(source.profileOf({},'Player One',now),null)
  assert.equal(source.profileOf({athlete:{displayName:'Player One',hand:{type:'LEFT'}}},'One Player',now).hand,'LEFT')
})

test('compact cloud storage roundtrips points, profile identity and recent result details',()=>{
  const payload=source.normalize(feed(),'atp',new Map(),now)
  payload.profiles={[payload.players[0].key]:{name:'Player 1',height:'6 ft',age:25}}
  const restored=view.decode(JSON.parse(JSON.stringify(view.encode(payload))))
  assert.equal(restored.players[0].officialPoints,9995)
  assert.equal(restored.profiles[payload.players[0].key].height,'6 ft')
  assert.equal(view.board(restored,false,now).rows[0].delta,5)
  assert.equal(view.pointsDetails(restored.players[0]).gains[0].points,200)
})

test('calendar city names join sponsored draw names once, preserve official list links and prefer live matches',()=>{
  const p=source.normalize(feed(),'wta',new Map(),now),player=p.players[0]
  p.calendar=[{name:'Ningbo',start:'2026-10-19',end:'2026-10-25'}]
  p.entryLists=[{name:'Ningbo',start:'2026-10-19',checkedAt:new Date(now).toISOString(),entries:[{key:player.key,status:'withdrawn'}]}]
  const matches=['live','upcoming'].map((status,i)=>({id:String(i),comp:'wta',stage:'Ningbo Open · Round 1',date:'2026-10-19',status}))
  const result=view.participation(p,player,matches,now)
  assert.equal(result.length,1);assert.equal(result[0].status,'live');assert.equal(result[0].tone,'withdrawn')
  assert.equal(result[0].station,'宁波公开赛')
})

test('publisher skips unchanged caches and preserves the last successful row when the feed regresses',async()=>{
  const fs=require('fs'),vm=require('vm'),path=require('path'),{createRequire}=require('module')
  const filename=path.join(__dirname,'tennis-insights.js')
  const previous=source.normalize(feed(),'atp',new Map(),now)
  previous.profiles={};previous.entryLists=[];previous.finals=null
  let writes=0,broken=false
  const cloud={database:{from:()=>({select(){return this},eq(field,id){this.tour=id.split(':')[0];return this},
    async maybeSingle(){const value={...previous,...source.normalize(feed(),this.tour,new Map(),now)};return {data:{payload:view.encode(value),generated_at:new Date(now).toISOString()}}},
    async upsert(){writes++;return {}}})}}
  const box={require:createRequire(filename),module:{exports:{}},__dirname,console,Date,URL,Buffer,
    process:{argv:[],env:{}},AbortSignal,
    fetch:async()=>({ok:true,json:async()=>broken?{...feed(),asof_calc:'2026-10-01'}:feed()})}
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),box,{filename})
  const result=await box.module.exports.main(cloud,{force:true,enrich:false,now})
  assert.ok(result.every(row=>row.skipped==='unchanged'));assert.equal(writes,0)
  broken=true
  const failed=await box.module.exports.main(cloud,{force:true,enrich:false,now})
  assert.ok(failed.every(row=>row.error));assert.equal(writes,0)
})
