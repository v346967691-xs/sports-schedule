const test=require('node:test'),assert=require('node:assert/strict')
const status=require('../utils/match-status'),snapshot=require('../utils/snapshot'),names=require('../utils/tennis-names')
test('ESPN post cancellations, postponements and incomplete fixtures are never results',()=>{
  for(const completed of [false,undefined]){
    assert.deepEqual(status.fromEspn({state:'post',name:'STATUS_CANCELED',completed}),{status:'canceled',statusText:'已取消'})
    assert.deepEqual(status.fromEspn({state:'post',shortDetail:'Postponed',completed}),{status:'upcoming',statusText:'已延期'})
  }
  assert.equal(status.fromEspn({state:'post',completed:false,name:'STATUS_SCHEDULED'}).status,'upcoming')
  assert.equal(status.fromEspn({state:'post',completed:true,name:'STATUS_FINAL'}).status,'finished')
  assert.equal(status.fromEspn({state:'post',name:'STATUS_RETIRED'}).status,'finished')
  assert.equal(status.fromEspn({state:'post',name:'STATUS_WALKOVER'}).status,'finished')
  assert.equal(status.fromEspn({state:'in',name:'STATUS_SUSPENDED'}).status,'live')
})
test('old cached postponements are repaired before querying and canceled states survive snapshots',()=>{
  const m={id:'atp-paris',comp:'atp',start:'2026-11-07T05:00Z',status:'finished',statusText:'已延期',winnerId:'1',home:{id:'1',name:'TBD'},away:{id:'2',name:'TBD'}}
  const n=names.localizeMatch(m);assert.equal(n.status,'upcoming');assert.equal(n.winnerId,undefined)
  assert.equal(m.status,'finished')
  const canceled={...m,status:'canceled',statusText:'已取消'}
  assert.equal(snapshot.decodeSnapshot(snapshot.encodeSnapshot([canceled]))[0].status,'canceled')
})
test('live tennis patches preserve cancellation rather than announcing a false completed match',async()=>{
  const fs=require('fs'),path=require('path'),vm=require('vm'),{createRequire}=require('module'),file=path.resolve(__dirname,'live-watch.js')
  const box={module:{exports:{}},require:createRequire(file),__dirname,console,Date,process:{argv:[],env:{}},setTimeout,clearTimeout,AbortController,
    fetch:async url=>({ok:true,json:async()=>({events:[{id:url.includes('/wta/')?'970-2026':'13-2026',groupings:[{grouping:{slug:url.includes('/wta/')?'womens-singles':'mens-singles'},competitions:[{id:'canceled',date:new Date(Date.now()+DAY).toISOString(),status:{type:{state:'post',name:'STATUS_CANCELED',completed:false}},competitors:[{id:'a',homeAway:'home'},{id:'b',homeAway:'away'}]}]}]}]})})}
  const DAY=86400000
  vm.runInNewContext(fs.readFileSync(file,'utf8'),box,{filename:file})
  const rows=await box.module.exports.scanTennis();assert.equal(rows.length,2)
  for(const row of rows){assert.equal(row.st,'canceled');assert.equal(row.stt,'已取消');assert.equal(row.wi,undefined)}
})
