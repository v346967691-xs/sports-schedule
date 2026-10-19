const test=require('node:test'),assert=require('node:assert/strict')
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module')
const scope=require('../utils/tennis-scope'),archive=require('../utils/tennis-event')
const now=Date.parse('2026-10-19T12:00:00Z')
const low={id:'wta-excluded',comp:'wta',stage:'Kinoshita Group Japan Open · Round 1',start:'2026-10-19T11:00Z',date:'2026-10-19',status:'live',home:{id:'1',name:'A'},away:{id:'2',name:'B'}}
const high={...low,id:'wta-kept',stage:'BNB Ningbo Open · Round 1'}
const calendar={wta:{tournaments:[{tour:'wta',name:'Ningbo',city:'Ningbo',level:'WTA 500',start:'2026-10-16',end:'2026-10-25'}]}}
function load(file,overrides={}) {
  const filename=path.resolve(__dirname,'..',file),real=createRequire(filename)
  const box={module:{exports:{}},require:real,__dirname:path.dirname(filename),console,Date,process:{argv:[],env:{}},setTimeout,clearTimeout,AbortController,AbortSignal,...overrides}
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),box,{filename})
  return box.module.exports
}
test('scope rejects both tours 250, accepts 500/1000 and unrelated sports, and respects current dated classifications',()=>{
  for(const level of ['ATP 250','WTA 250','250',250])assert.equal(scope.allows({...low,level}),false)
  assert.equal(scope.allows(low),false)
  assert.equal(scope.allows(high,calendar),true)
  assert.equal(scope.allows({...low,comp:'atp',stage:'Almaty Open'}),false)
  for(const level of ['ATP 500','WTA 1000','Grand Slam','Finals'])assert.equal(scope.allows({...low,level}),true)
  assert.equal(scope.allows({...low,comp:'nba',level:250}),true)
  assert.equal(scope.allows({...low,date:'2027-10-19'}, {wta:{tournaments:[{name:'Kinoshita Group Japan Open',tour:'wta',level:'WTA 500',start:'2027-10-16',end:'2027-10-25'}]}}),true)
})
test('legacy snapshots and archive merges cannot reintroduce removed tournaments',()=>{
  const old={snapshot:require('../utils/snapshot').encodeSnapshot([low,high])}
  assert.deepEqual(archive.archiveRows(old).map(m=>m.id),[high.id])
  assert.deepEqual(archive.mergeRows([low],[high]).map(m=>m.id),[high.id])
})
test('front-end schedules, old deep links and stats requests reject excluded cached matches',async()=>{
  const real=createRequire(path.resolve(__dirname,'../utils/data.js'))
  const data=load('utils/data.js',{require:name=>name==='../data/matches.js'?[low,high]
    :name==='../data/tennis-events'?null:name==='../data/tennis-rankings.js'?{weekly:calendar}
      :name==='./cloud'?{isReady:()=>false}:real(name)})
  assert.deepEqual(Array.from(data.matches(),m=>m.id),[high.id])
  assert.equal(data.findMatch(low.id),null)
  assert.equal(await data.tennisMatchStats(low),null)
})
test('excluded statistics trigger no database or upstream calls even if marked live',async()=>{
  const source=require('./tennis-stats')
  const result=await source.main({database:{from(){throw Error('must not read cloud')}}},{now,matches:[low],read(){throw Error('must not read upstream')}})
  assert.equal(result.matches,0)
  assert.equal(result.writes,0)
})
test('public discovery omits 250 before tracking starts and live games',async()=>{
  const watch=load('tools/live-watch.js',{fetch:async url=>({ok:true,json:async()=>({events:[250,500].map(level=>({
    id:'970-2026',name:'Fixture '+level,level:'WTA '+level,date:new Date().toISOString(),groupings:[{
      grouping:{slug:url.includes('/wta/')?'womens-singles':'mens-singles'},competitions:[{
        id:String(level),date:new Date().toISOString(),status:{type:{state:'in'}},competitors:[{id:'1'},{id:'2'}],round:{displayName:'Round 1'},
      }],
    }],
  }))})})})
  const rows=await watch.scanTennis()
  assert.equal(rows.length,2)
  assert.ok(rows.every(row=>row.id.endsWith('-500')))
})
test('main schedule collector rejects 250 before building match rows',async()=>{
  const sync=load('tools/sync.js',{fetch:async()=>({ok:true,json:async()=>({events:[250,500].map(level=>({
    id:'963-2026',name:'Fixture '+level,level:'WTA '+level,date:'2026-10-19T04:00Z',groupings:[{
      grouping:{slug:'womens-singles'},competitions:[{id:String(level),date:'2026-10-19T04:00Z',
        status:{type:{state:'pre'}},competitors:[{id:'1',athlete:{displayName:'A'}},{id:'2',athlete:{displayName:'B'}}],
      }],
    }],
  }))})})})
  const rows=await sync.fetchTennis({key:'wta',tour:'wta',accent:'#000',name:'WTA'})
  assert.equal(rows.length,1)
  assert.equal(rows[0].id,'wta-500')
})
test('250 live matches and unfinished statistics cannot keep the idle plan awake',()=>{
  const plan=require('./activity-gate').makePlan({matches:[low,{id:'epl-future',comp:'epl',status:'upcoming',start:new Date(now+86400000).toISOString()}],
    now,snapshotAt:new Date(now).toISOString(),expected:['fixture'],sources:{fixture:{ok:true,checkedAt:new Date(now).toISOString()}},sha:'test'})
  assert.equal(plan.ready,true)
  assert.ok(!plan.matches.some(m=>m.id===low.id))
})
test('one-off cleanup preserves unrelated metadata and mixed statistics, and rejects concurrent writes',async()=>{
  const cleanup=require('./remove-tennis-250')
  const meta={generatedAt:'unchanged',worldsRefreshedAt:'draw-revision',tennisRankings:{weekly:calendar},
    tennisEvents:{generatedAt:new Date(now).toISOString(),snapshot:[low,high]}}
  const result=cleanup.prepare([low,high],meta)
  assert.deepEqual(result.rows,[high])
  assert.equal(result.meta.worldsRefreshedAt,'draw-revision')
  assert.equal(result.meta.generatedAt,'unchanged')
  assert.deepEqual(archive.archiveRows(result.meta.tennisEvents,true).map(m=>m.id),[high.id])
  const payload={v:1,matches:{[low.id]:{bad:true},[high.id]:{keep:true}},relayAttempts:{[low.id]:'x',[high.id]:'y'}}
  const pruned=cleanup.pruneStats(payload,new Set([low.id]))
  assert.deepEqual(pruned.matches,{[high.id]:{keep:true}})
  assert.ok(payload.matches[low.id], 'input and unrelated matches remain unchanged')
  const guards=[]
  const q={update(){return this},eq(k,v){guards.push([k,v]);return this},is(k,v){guards.push([k,v]);return this},select:async()=>({data:[]})}
  await assert.rejects(cleanup.update(q,{},[['generated_at','old'],['meta->>worldsRefreshedAt',null]]),/并发/)
  assert.deepEqual(guards,[['generated_at','old'],['meta->>worldsRefreshedAt',null]])
})
