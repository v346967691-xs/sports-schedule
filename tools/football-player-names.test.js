const test = require('node:test'), assert = require('node:assert/strict')

test('football client dictionary matches authoritative manual/seed names and excludes NBA identities',()=>{
  const emitted = require('../data/football-player-names').ZH
  assert.deepEqual(emitted,require('./build-football-player-names').source())
  assert.equal(emitted['157073'],'马奎尔')
  assert.equal(emitted['131634'],'什琴斯尼')
  assert.equal(emitted['240233'],'阿什拉夫·哈基米')
  assert.equal(emitted['239349'],'德利赫特')
  assert.equal(emitted['328238'],'巴尔科拉')
  assert.equal(emitted['251400'],'埃泽')
  assert.equal(emitted['1966'],undefined)
})

test('old lineup, roster, scorer and MVP data translate by ID while stats and full English identity remain intact',()=>{
  const names = require('../utils/football-players')
  const old = {lineups:{home:[{i:'157073',n:'H. Maguire',j:'5',st:1}],away:[{i:'131634',n:'W. Szczesny'}]},
    players:[{i:'240233',n:'Achraf Hakimi',s:'A. Hakimi',z:'',g:4}],
    mvp:{candidates:[{id:'espn:157073',name:'H. Maguire',stats:[{value:3}]}]}}
  for (const comp of ['ucl','liga','epl']) {
    const out = names.payload(old,comp)
    assert.equal(out.lineups.home[0].n,'马奎尔')
    assert.equal(out.lineups.home[0].j,'5')
    assert.equal(out.lineups.away[0].n,'什琴斯尼')
    assert.equal(out.players[0].n,'Achraf Hakimi')
    assert.equal(out.players[0].z,'阿什拉夫·哈基米')
    assert.equal(out.players[0].g,4)
    assert.equal(out.mvp.candidates[0].name,'马奎尔')
  }
  assert.equal(old.lineups.home[0].n,'H. Maguire')
  assert.equal(names.payload(old,'nba'),old)
  assert.equal(names.payload(old,'cba'),old)
  assert.equal(names.name('H. Maguire'),'')
  assert.notEqual(names.name('265869'),names.name('251100'),'费兰和保·托雷斯按ID区分')
  assert.equal(names.payload({lineups:{home:[{i:'unknown',n:'L. Martinez'}]}},'ucl').lineups.home[0].n,'L. Martinez')
})

test('football names flow through real data entry points for all three competitions without extra reads',async()=>{
  const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),{createRequire}=require('node:module')
  const filename=path.resolve(__dirname,'../utils/data.js'),native=createRequire(filename)
  const old={players:[{i:'157073',n:'Harry Maguire',s:'H. Maguire',z:'',g:4,a:2}],lineups:{home:[{i:'157073',n:'H. Maguire'}],away:[]}}
  let reads=0
  const cloud={isReady:()=>true,cloud:{database:{from:()=>({select(){return this},eq(){return this},maybeSingle:async()=>{reads++;return {data:{payload:{...old,fixture:old}}}}})}}}
  const box={module:{exports:{}},console,Date,require(id){
    if(id==='./cloud')return cloud
    if(id==='../data/scorers.js')return {tables:{ucl:old,epl:old,liga:old}}
    return native(id)
  }}
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),box,{filename})
  const data=box.module.exports
  for(const comp of ['ucl','epl','liga']) {
    assert.equal(data.scorersTop(comp,'goals')[0].name,'马奎尔')
    assert.equal(data.scorersTop(comp,'goals')[0].value,4)
    const detail=await data.matchDetail({id:'fixture',comp,start:'2026-10-21T02:00:00Z'})
    assert.equal(detail.lineups.home[0].n,'马奎尔')
    const roster=await data.teamRoster(comp,'team')
    assert.equal(roster.players[0].z,'马奎尔')
  }
  assert.equal(reads,6,'only the existing detail/roster queries are issued')
  assert.equal(old.players[0].z,'')
})
