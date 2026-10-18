const test=require('node:test'),assert=require('node:assert/strict')
const fs=require('fs'),path=require('path'),vm=require('vm'),{createRequire}=require('module')
const model=require('../utils/tennis-insights')
function load(relative,overrides={}){
  const filename=path.resolve(__dirname,relative)
  const box={require:createRequire(filename),module:{exports:{}},__dirname:path.dirname(filename),console,Date,
    setInterval,clearInterval,...overrides}
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),box,{filename});return box
}
test('live cache coalesces reads, decodes compact rows and retains last good values on old or broken responses',async()=>{
  const stamp=new Date().toISOString()
  let old=false,broken=false,reads=0
  const cloud={isReady:()=>true,cloud:{database:{from:()=>({select(){return this},eq(field,id){this.tour=id.split(':')[0];return this},
    async maybeSingle(){reads++;return broken?{error:{message:'offline'}}:{data:{payload:model.encode({v:1,tour:this.tour,asOf:old?'2020-01-01':stamp,
      checkedAt:stamp,players:[{key:'player one',name:'Player One',rank:1,points:100,officialPoints:90}],race:[]})}}}})}}}
  const filename=path.resolve(__dirname,'../utils/data.js'),actual=createRequire(filename)
  const data=load('../utils/data.js',{require:name=>name==='./cloud'?cloud:actual(name)}).module.exports
  await Promise.all([data.refreshTennisInsights(true),data.refreshTennisInsights(true)])
  assert.equal(reads,2);assert.equal(data.tennisLiveBoard('atp').rows[0].delta,10)
  old=true;await data.refreshTennisInsights(true)
  assert.equal(data.tennisInsightPayload('atp').asOf,stamp)
  broken=true;await data.refreshTennisInsights(true)
  assert.equal(data.tennisLiveBoard('wta').rows[0].value,100)
})
test('player profile renders points and schedule, removes an older follow identity, and stops visible polling',async()=>{
  let page,timer=0,cleared=0,selected=null
  const athlete={key:'bu yunchaokete',name:'Bu Yunchaokete',espnId:'11382',country:'CHN',rank:51,points:1000,officialPoints:980,gains:[],drops:[]}
  const payload={asOf:new Date().toISOString(),players:[athlete],calendar:[],race:[],profiles:{}}
  const oldFollow={comp:'atp',id:'cn-atp-bu-yunchaokete',name:'Yunchaokete Bu'}
  const match={id:'atp-one',comp:'atp',date:'2026-10-17',time:'12:00',start:'2026-10-17T04:00:00Z',status:'upcoming',stage:'Shanghai · Quarterfinal',home:{name:athlete.name},away:{name:'Other'}}
  const data={tennisInsightPayload:()=>payload,tennisMatches:()=>[match],matchHasTeam:()=>true,
    compOf:()=>({name:'ATP'}),refresh:async()=>{},refreshTennisInsights:async()=>{},refreshLive:async()=>{}}
  const filename=path.resolve(__dirname,'../pages/tennis-player/tennis-player.js'),actual=createRequire(filename)
  load('../pages/tennis-player/tennis-player.js',{Page:p=>page=p,wx:{setNavigationBarTitle(){}},
    setInterval:()=>++timer,clearInterval:()=>cleared++,require:name=>name.endsWith('/data')?data:
      name.endsWith('/team-follows')?{all:()=>[oldFollow],toggle:row=>selected=row}:actual(name)})
  page.setData=function(value){Object.assign(this.data,value)}
  page.onLoad({comp:'atp',name:athlete.name});page.onShow();await Promise.resolve()
  assert.equal(page.data.name,'布云朝克特');assert.equal(page.data.player.deltaLabel,'+20')
  assert.equal(page.data.upcoming.length,1);assert.equal(page.data.followed,true)
  page.onFollow();assert.equal(selected.id,oldFollow.id)
  page.onHide();assert.equal(cleared,1);assert.equal(page.timer,null)
})
test('ranking live/weekly switch preserves the chosen mode in shares and leads to player profiles',()=>{
  let page,destination
  const filename=path.resolve(__dirname,'../pages/rank/rank.js'),actual=createRequire(filename)
  const realData=load('../utils/data.js',{require:name=>name==='./cloud'?{isReady:()=>false}:createRequire(path.resolve(__dirname,'../utils/data.js'))(name)}).module.exports
  const payload={tour:'atp',asOf:new Date().toISOString(),players:[{key:'bu yunchaokete',name:'Bu Yunchaokete',country:'CHN',rank:1,points:1000,officialPoints:980}]}
  load('../pages/rank/rank.js',{Page:p=>page=p,wx:{navigateTo:opt=>destination=opt.url},
    require:name=>name.endsWith('/data')?{...realData,tennisLiveBoard:(tour,china)=>tour==='atp'?model.board(payload,china):null}:
      name.endsWith('/app-instance')?{appInstance:()=>({globalData:{}})}:actual(name)})
  page.setData=(value,done)=>{Object.assign(page.data,value);if(done)done()};page.buildShareImage=()=>{}
  page.onLoad({comp:'atp'});assert.equal(page.data.rankRows[0].value,1000)
  assert.equal(page.data.tennisDisplayMode,'live');assert.match(page.onShareAppMessage().path,/mode=live/)
  page.onTennisRowTap({currentTarget:{dataset:{id:'bu yunchaokete'}}});assert.match(destination,/tennis-player/)
  page.onTennisModeTap({currentTarget:{dataset:{mode:'weekly'}}});assert.equal(page.data.tennisDisplayMode,'weekly')
  assert.match(page.onShareAppMessage().path,/mode=weekly/)
})
