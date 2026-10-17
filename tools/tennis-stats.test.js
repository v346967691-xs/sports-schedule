const test=require('node:test'),assert=require('node:assert/strict')
const source=require('./tennis-stats'),view=require('../utils/tennis-stats')
const now=Date.parse('2026-10-16T08:00Z')
const match={id:'wta-fixture',comp:'wta',status:'finished',start:'2026-10-12T11:20Z',stage:'Dongfeng Voyah Wuhan Open · Round 1',venue:'Wuhan, China PR',home:{id:'home',name:'Xinyu Wang'},away:{id:'away',name:'Xiyu Wang'}}
const official={EventID:'1075',EventYear:2026,MatchID:'LS045',MatchState:'F',DrawMatchType:'S',DrawLevelType:'M',MatchTimeStamp:'2026-10-12T11:21Z',LastUpdated:'2026-10-12T12:47Z',PlayerNameFirstA:'Xiyu',PlayerNameLastA:'Wang',PlayerNameFirstB:'Xinyu',PlayerNameLastB:'Wang'}
const event={year:2026,startDate:'2026-10-12',endDate:'2026-10-18',level:'WTA 1000',city:'WUHAN',title:'Dongfeng · Voyah Wuhan Open - Wuhan, CHN',tournamentGroup:{id:1075,name:'WUHAN'}}
const stat={eventyear:2026,eventid:'1075',matchid:'LS045',setnum:0,acesa:2,acesb:0,dblflta:0,dblfltb:3,ptswon1stserva:22,ptswon1stservb:13,ptsplayed1stserva:31,ptsplayed1stservb:29,ptstotwonserva:32,ptstotwonservb:19,totservplayeda:44,totservplayedb:46,breakptsconva:5,breakptsconvb:0,breakptsplayeda:9,breakptsplayedb:4,servgamesplayeda:7,servgamesplayedb:7,totptswona:59,totptswonb:31}
test('matches a station and both full names, preserving the distinction between two Wangs and reversing stats sides',()=>{
  assert.equal(source.findEvent(match,[event]),event)
  const found=source.findMatch(match,[official]);assert.equal(found.flip,true)
  assert.equal(source.findMatch({...match,home:{id:'other',name:'Wang'}},[official]),null)
  assert.equal(source.findMatch(match,[official,{...official,MatchID:'LS001',MatchTimeStamp:official.MatchTimeStamp}]),null)
  const p=source.normalize([stat,{...stat,setnum:1}],match,official,found.flip,now)
  const rows=p.sections[0].rows
  assert.deepEqual(rows.find(r=>r[0]==='ACE'),['ACE',0,2])
  assert.deepEqual(rows.find(r=>r[0]==='双误'),['双误',3,0])
  assert.deepEqual(rows.find(r=>r[0]==='一发得分率'),['一发得分率','45%\n13/29','71%\n22/31'])
  assert.deepEqual(rows.find(r=>r[0]==='二发得分率'),['二发得分率','35%\n6/17','77%\n10/13'])
  assert.deepEqual(rows.find(r=>r[0]==='破发点挽救率'),['破发点挽救率','44%\n4/9','100%\n4/4'])
  const built=view.build(p,match);assert.equal(built.sections.length,2);assert.equal(built.sections[0].rows[0].home,'0')
  assert.match(built.updated,/北京时间/)
})
test('missing counts and inapplicable denominators are unknown, never fabricated zeroes',()=>{
  const p=source.normalize([{...stat,dblflta:undefined,breakptsplayeda:0,breakptsconva:0}],match,official,false,now)
  const rows=view.build(p,match).sections[0].rows
  assert.equal(rows.find(r=>r.label==='双误').home,'—')
  assert.equal(rows.find(r=>r.label==='双误').away,'3')
  assert.equal(rows.find(r=>r.label==='破发点兑现率').home,'—')
  assert.equal(source.normalize([{eventyear:2026,eventid:'1075',matchid:'LS045',setnum:0,acesa:0,acesb:0}],match,official,false,now),null)
  assert.equal(source.normalize([{...stat,eventid:'1020'}],match,official,false,now),null)
  assert.equal(view.build(p,{...match,home:{id:'someone-else'}}),null)
  assert.equal(source.findEvent({...match,stage:'Unclear',venue:'Wuhan'},[event,{...event,tournamentGroup:{id:99}}]),null)
})
function mockCloud(initial=[]) {
  const stored=new Map(initial.map(r=>[r.id,r])),writes=[]
  return {writes,stored,database:{from:()=>({select(){return this},in:async(_,ids)=>({data:ids.map(id=>stored.get(id)).filter(Boolean)}),upsert:async row=>{writes.push(row);stored.set(row.id,structuredClone(row));return {}}})}}
}
test('collector writes only the tennis statistics day bucket, skips completed cached data and retains it on empty/error responses',async()=>{
  const cloud=mockCloud(),urls=[]
  const read=async url=>{urls.push(url);return url.includes('/stats')?[stat]:url.includes('/matches')?{matches:[official]}:{content:[event]}}
  const result=await source.main(cloud,{now,relay:false,matches:[match],read})
  assert.equal(result.fetched,1);assert.equal(cloud.writes.length,1);assert.equal(cloud.writes[0].id,'wta:tennis-stats:20261012')
  const p=cloud.stored.get(cloud.writes[0].id).payload.matches[match.id]
  urls.length=0;assert.equal((await source.main(cloud,{relay:false,now:now+60000,matches:[match],read})).writes,0);assert.equal(urls.length,0)
  const live={...match,status:'live',start:'2026-10-16T06:00Z'}
  const latest={...official,MatchState:'P',MatchTimeStamp:live.start}
  await source.main(cloud,{now,relay:false,matches:[live],read:async url=>url.includes('/stats')?[stat]:url.includes('/matches')?{matches:[latest]}:{content:[event]}})
  const liveKey='wta:tennis-stats:20261016',before=structuredClone(cloud.stored.get(liveKey).payload.matches[live.id])
  const empty=async url=>url.includes('/stats')?[]:url.includes('/matches')?{matches:[latest]}:{content:[event]}
  await source.main(cloud,{relay:false,now:now+15*60000,matches:[live],read:empty})
  assert.deepEqual(cloud.stored.get(liveKey).payload.matches[live.id],before)
  await assert.rejects(source.main(cloud,{relay:false,now:now+30*60000,matches:[live],read:async()=>{throw Error('offline')}}),/offline/)
  assert.deepEqual(cloud.stored.get(liveKey).payload.matches[live.id],before)
  assert.equal(p.sections[0].rows.find(r=>r[0]==='ACE')[1],0)
})
test('unmatched or unavailable old statistics are negatively cached instead of fetched every cycle',async()=>{
  const cloud=mockCloud();let requests=0
  const read=async()=>{requests++;return {content:[]}}
  await source.main(cloud,{now,relay:false,matches:[match],read})
  await source.main(cloud,{relay:false,now:now+15*60000,matches:[match],read})
  assert.equal(requests,1);assert.equal(cloud.writes.length,1)
})
test('scheduled collectors use the current cloud WTA archive even when checkout snapshots contain no matches',async()=>{
  const fs=require('fs'),path=require('path'),vm=require('vm'),{createRequire}=require('module')
  const filename=path.resolve(__dirname,'tennis-stats.js'),actual=createRequire(filename)
  const packed=require('../utils/tennis-event').buildArchive([{...match,eventId:'970-2026',eventStart:event.startDate,eventEnd:event.endDate}],null,now)
  const cloud=mockCloud(),from=cloud.database.from
  cloud.database.from=table=>table==='schedule_cache'?{select(fields){assert.ok(fields.includes('matches->wta'));return this},eq(){return this},maybeSingle:async()=>({data:{...packed,wta:packed.matches.wta}})}:from(table)
  const box={module:{exports:{}},console,Date,require:n=>n==='../data/matches'?[]:n==='../data/tennis-events'?null:actual(n)}
  vm.runInNewContext(fs.readFileSync(filename,'utf8'),box,{filename})
  const read=async url=>url.includes('/stats')?[stat]:url.includes('/matches')?{matches:[official]}:{content:[event]}
  assert.equal((await box.module.exports.main(cloud,{now,relay:false,read})).fetched,1)
})

test('live statistics survive sparse final responses and a completed record never regresses to live',()=>{
  const p=source.normalize([stat,{...stat,setnum:1}],match,{...official,MatchState:'P'},false,now)
  const sparse=source.normalize([{...stat,dblflta:undefined}],match,official,false,now+60000)
  const merged=source.mergeStats(p,sparse)
  assert.equal(merged.sections.length,2)
  assert.deepEqual(merged.sections[0].rows.find(r=>r[0]==='双误'),['双误',0,3])
  assert.equal(merged.complete,false)
  const final=source.normalize([stat,{...stat,setnum:1}],match,official,false,now+120000)
  assert.equal(source.mergeStats(merged,final).complete,true)
  assert.equal(source.mergeStats(final,p),final)
  assert.equal(source.mergeStats(final,sparse),final)
  const different={...sparse,h:'different'}
  assert.equal(source.mergeStats(p,different),different)
})
