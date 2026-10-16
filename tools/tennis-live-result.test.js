const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm'),{createRequire}=require('module')
test('the live tennis feed preserves retirement status and the official winner even if that player trails in sets',async()=>{
  const filename=path.join(__dirname,'live-watch.js'),box={module:{exports:{}},require:createRequire(filename),__dirname,console,Date,
    process:{argv:[],env:{}},setTimeout,clearTimeout,AbortController,
    fetch:async url=>({ok:true,json:async()=>({events:[{id:url.includes('/wta/')?'970-2026':'501-2026',groupings:[{
      grouping:{slug:url.includes('/wta/')?'womens-singles':'mens-singles'},competitions:[{
        id:'retired',date:new Date(Date.now()-3600000).toISOString(),round:{displayName:'Quarterfinal'},
        status:{type:{state:'post',name:'STATUS_RETIRED',description:'Retired'}},
        competitors:[{id:'home',homeAway:'home',winner:false,score:'1'},{id:'away',homeAway:'away',winner:true,score:'0',curatedRank:{current:5}}]
      }]}]}]})})}
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),box,{filename})
  const rows=await box.module.exports.scanTennis()
  assert.equal(rows.length,2)
  for(const row of rows){assert.equal(row.stt,'退赛');assert.equal(row.wi,'away');assert.equal(row.hs,1);assert.equal(row.as,0);assert.equal(row.sd[1],5)}
})
