const test=require('node:test'),assert=require('node:assert/strict')
const match={id:'wta-fixture',comp:'wta',status:'finished',home:{id:'h'},away:{id:'a'}}
test('detail loads and switches match/set statistics independently of the generic details and ignores stale responses',async()=>{
  const fs=require('fs'),path=require('path'),vm=require('vm'),{createRequire}=require('module')
  const filename=path.resolve(__dirname,'../pages/detail/detail.js'),actual=createRequire(filename)
  let page,calls=0,finish
  const p={complete:true,sections:[{key:0,rows:[{label:'ACE',home:'2',away:'0'}]},{key:1,rows:[{label:'ACE',home:'1',away:'0'}]}]}
  const data={compOf:()=>({cat:'tennis'}),tennisMatchStats:async()=>{calls++;return p}}
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module:{exports:{}},console,Date,Page:spec=>page=spec,require:n=>n.endsWith('/data')?data:n.endsWith('/favorites')?{}:actual(n)},{filename})
  page.data={...page.data,match};page.setData=function(v){Object.assign(this.data,v)};page.syncLivePoll=()=>{}
  await page.loadDetail(match);assert.equal(calls,1);assert.equal(page.data.tennisStatsRows[0].home,'2')
  page.onTennisStatsTab({currentTarget:{dataset:{key:1}}});assert.equal(page.data.tennisStatsKey,1)
  await page.loadDetail(match);assert.equal(calls,1)
  page.tennisStatsReadAt=0;data.tennisMatchStats=()=>new Promise(resolve=>finish=resolve)
  const loading=page.loadDetail(match);page.data.match={...match,id:'wta-other'};finish(p);await loading
  assert.equal(page.data.match.id,'wta-other');assert.equal(page.data.tennisStatsKey,1)
})

test('finishing bypasses the live read throttle, retains statistics on an empty response, then accepts final data',async()=>{
  const fs=require('fs'),path=require('path'),vm=require('vm'),{createRequire}=require('module')
  const filename=path.resolve(__dirname,'../pages/detail/detail.js'),actual=createRequire(filename)
  let page;const options=[]
  const live={...match,status:'live'},final={...match,status:'finished'}
  const before={complete:false,sections:[{key:0,rows:[{label:'ACE',home:'2',away:'0'}]}]}
  let result=before
  const data={compOf:()=>({cat:'tennis'}),tennisMatchStats:async(m,opt)=>{options.push(opt);return result}}
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module:{exports:{}},console,Date,Page:spec=>page=spec,require:n=>n.endsWith('/data')?data:n.endsWith('/favorites')?{}:actual(n)},{filename})
  page.data={...page.data,match:live};page.setData=function(v){Object.assign(this.data,v)};page.syncLivePoll=()=>{}
  await page.loadDetail(live)
  result=null;page.data.match=final
  await page.loadDetail(final)
  assert.equal(options.length,2)
  assert.equal(options[1].force,true)
  assert.equal(page.data.tennisStats,before)
  assert.equal(page.finalDetailReady,false)
  page.tennisStatsReadAt=0;result={...before,complete:true}
  await page.loadDetail(final)
  assert.equal(page.data.tennisStats.complete,true)
  assert.equal(page.finalDetailReady,true)
  page.tennisStatsReadAt=0;result=null
  await page.loadDetail(final)
  assert.equal(page.finalDetailReady,true)
})

test('a final statistics read can bypass a cached live bucket without changing ordinary roster caching',async()=>{
  const fs=require('fs'),path=require('path'),vm=require('vm'),{createRequire}=require('module')
  const filename=path.resolve(__dirname,'../utils/data.js'),actual=createRequire(filename)
  let reads=0,complete=false,unavailable=false
  const entry=()=>({v:1,h:'h',a:'a',complete,ts:new Date().toISOString(),sections:[{n:0,rows:[['ACE',2,0]]}]})
  const cloud={isReady:()=>true,cloud:{database:{from:()=>({select(){return this},eq(){return this},maybeSingle:async()=>{reads++;return unavailable ? {error:{message:'offline'}} : {data:{payload:{matches:{[match.id]:entry()}}}}}})}}}
  const box={module:{exports:{}},Date,console,require:n=>n==='./cloud'?cloud:actual(n)}
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),box,{filename})
  const data=box.module.exports,m={...match,status:'live',start:'2026-10-17T08:00Z'}
  assert.equal((await data.tennisMatchStats(m)).complete,false)
  complete=true
  assert.equal((await data.tennisMatchStats({...m,status:'finished'})).complete,false)
  assert.equal((await data.tennisMatchStats({...m,status:'finished'},{force:true})).complete,true)
  assert.equal(reads,2)
  assert.equal((await data.tennisMatchStats({...m,status:'finished'})).complete,true)
  assert.equal(reads,2)
  unavailable=true
  assert.equal((await data.tennisMatchStats({...m,status:'finished'},{force:true})).complete,true)
  assert.equal(reads,3)
})

test('ATP uses the same statistics loader and switches whole-match/set duration with its rows',async()=>{
 const fs=require('fs'),path=require('path'),vm=require('vm'),{createRequire}=require('module')
 const filename=path.resolve(__dirname,'../pages/detail/detail.js'),actual=createRequire(filename)
 let page,calls=0
 const atp={...match,id:'atp-fixture',comp:'atp'}
 const data={compOf:()=>({cat:'tennis'}),tennisMatchStats:async m=>{calls++;assert.equal(m.comp,'atp');return {complete:true,sections:[{key:0,duration:'02:02:30',rows:[{label:'ACE',home:'18',away:'5'}]},{key:1,duration:'00:42:32',rows:[{label:'ACE',home:'9',away:'2'}]}]}}}
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{module:{exports:{}},console,Date,Page:spec=>page=spec,require:n=>n.endsWith('/data')?data:n.endsWith('/favorites')?{}:actual(n)},{filename})
 page.data={...page.data,match:atp};page.setData=function(v){Object.assign(this.data,v)};page.syncLivePoll=()=>{}
 await page.loadDetail(atp)
 assert.equal(calls,1);assert.equal(page.data.tennisStatsRows[0].home,'18');assert.equal(page.data.tennisStatsDuration,'02:02:30')
 page.onTennisStatsTab({currentTarget:{dataset:{key:1}}})
 assert.equal(page.data.tennisStatsRows[0].home,'9');assert.equal(page.data.tennisStatsDuration,'00:42:32')
 assert.equal(page.finalDetailReady,true)
})
