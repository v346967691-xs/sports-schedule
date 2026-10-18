const test=require('node:test'),assert=require('node:assert/strict'),fs=require('fs'),path=require('path')
const adapter=require('./live-tennis-stats'),collector=require('./tennis-stats'),view=require('../utils/tennis-stats')
const fixture=name=>fs.readFileSync(path.join(__dirname,'fixtures/live-tennis',name),'utf8')
const schedule=fixture('schedule-20261017.html'),atpHtml=fixture('atp-finished.html'),wtaHtml=fixture('wta-finished.html')
const now=Date.parse('2026-10-17T19:30:00+08:00')
const atp={id:'atp-184945',comp:'atp',date:'2026-10-17',start:'2026-10-17T08:40Z',status:'finished',stage:'Rolex Shanghai Masters · Semifinal',venue:'Shanghai, China PR',home:{id:'2375',name:'Alexander Zverev'},away:{id:'3212',name:'Alejandro Davidovich Fokina'}}
const wta={id:'wta-185374',comp:'wta',date:'2026-10-17',start:'2026-10-17T09:05Z',status:'finished',stage:'Dongfeng Voyah Wuhan Open · Semifinal',venue:'Wuhan, China PR',home:{id:'7209',name:'Sonay Kartal'},away:{id:'2195',name:'Jelena Ostapenko'}}
const entries=adapter.parseSchedule(schedule,'2026-10-17')
const raw=JSON.parse(fixture('wta-official.json'))
const official={EventID:'1075',EventYear:2026,MatchID:'LS003',MatchState:'F',DrawMatchType:'S',DrawLevelType:'M',MatchTimeStamp:wta.start,PlayerNameFirstA:'Sonay',PlayerNameLastA:'Kartal',PlayerNameFirstB:'Jelena',PlayerNameLastB:'Ostapenko'}
const event={year:2026,startDate:'2026-10-12',endDate:'2026-10-18',level:'WTA 1000',city:'Wuhan',title:'Dongfeng Voyah Wuhan Open',tournamentGroup:{id:1075,name:'Wuhan'}}
const row=(p,label,n=0)=>p.sections.find(s=>s.n===n).rows.find(r=>r[0]===label)

test('real ATP page yields full and three set statistics, corrected serve metric and metric-only speeds',()=>{
 const found=adapter.findMatch(atp,entries);assert.ok(found)
 const p=adapter.normalize(atpHtml,atp,found,now)
 assert.equal(p.complete,true);assert.equal(p.sections.length,4)
 assert.equal(p.sections[0].duration,'02:02:30')
 assert.equal(p.sections[1].duration,'00:42:32')
 assert.deepEqual(row(p,'ACE'),['ACE',18,5])
 assert.deepEqual(row(p,'总得分'),['总得分',82,96])
 assert.deepEqual(row(p,'发球得分率'),['发球得分率','66%\n63/95','77%\n64/83'])
 assert.deepEqual(row(p,'最快一发速度'),['最快一发速度','224 km/h','216 km/h'])
 assert.equal(row(p,'保发率'),undefined)
 assert.ok(view.build(p,atp).sections[0].rows.some(r=>r.label==='制胜分'))
 const flipped={...atp,home:atp.away,away:atp.home}
 const reverse=adapter.normalize(atpHtml,flipped,adapter.findMatch(flipped,entries),now)
 assert.deepEqual(row(reverse,'ACE'),['ACE',5,18])
})

test('identity matching rejects surname-only matches, wrong station/date/round, ambiguous pairs and wrong stats identities',()=>{
 assert.equal(adapter.findMatch({...atp,home:{...atp.home,name:'Zverev'}},entries),null)
 assert.equal(adapter.findMatch({...atp,date:'2026-10-14',start:'2026-10-14T08:40Z'},entries),null)
 assert.equal(adapter.findMatch({...atp,stage:'China Open · Semifinal'},entries),null)
 assert.equal(adapter.findMatch({...atp,stage:'Rolex Shanghai Masters · Quarterfinal'},entries),null)
 const found=adapter.findMatch(atp,entries)
 assert.equal(adapter.findMatch(atp,[found.entry,{...found.entry,matchid:'MS999'}]),null)
 assert.equal(adapter.normalize(atpHtml.replace('/pic/hs/Z355','/pic/hs/OTHER'),atp,found,now),null)
 assert.equal(adapter.normalize('<div>No statistics</div>',atp,found,now),null)
})

test('live placeholder negatives and zero-denominator rates remain unknown while genuine zeroes are retained',()=>{
 const m={...atp,home:{id:'h',name:'Rafael Jodar'},away:{id:'a',name:'Daniil Medvedev'},status:'live'}
 const found=adapter.findMatch(m,entries);found.entry={...found.entry,status:1}
 const p=adapter.normalize(fixture('atp-live.html'),m,found,now)
 assert.equal(p.complete,false)
 assert.equal(row(p,'制胜分',1)[2],null)
 assert.equal(row(p,'双误')[2],0)
 assert.equal(row(p,'破发点兑现率'),undefined)
})

test('WTA official and relay agree on sampled counts; official is richer and adds correctly derived return/hold rates',()=>{
 const found=adapter.findMatch(wta,entries);assert.ok(found)
 const secondary=adapter.normalize(wtaHtml,wta,found,now)
 const primary=collector.normalize(raw,wta,official,false,now)
 for(const label of ['ACE','双误','总得分','一发成功率','一发得分率','二发得分率','保发率'])assert.deepEqual(row(secondary,label),row(primary,label))
 assert.ok(primary.sections[0].rows.length>secondary.sections[0].rows.length)
 assert.deepEqual(row(primary,'保发率'),['保发率','67%\n8/12','67%\n8/12'])
 assert.deepEqual(row(primary,'接一发得分率'),['接一发得分率','31%\n16/51','38%\n20/53'])
})
function cloud(initial=[]){
 const stored=new Map(initial.map(r=>[r.id,structuredClone(r)])),writes=[]
 return {stored,writes,database:{from:()=>({select(){return this},in:async(_,ids)=>({data:ids.map(id=>stored.get(id)).filter(Boolean)}),upsert:async row=>{writes.push(row);stored.set(row.id,structuredClone(row));return {}}})}}
}
const bucket=(m,p)=>({id:m.comp+':tennis-stats:20261017',payload:{v:1,matches:{[m.id]:p}}})

test('collector saves ATP in its own bucket, reuses one date page, skips repeats and preserves data on source failure',async()=>{
 const c=cloud();let calls=0
 const readHtml=async url=>{calls++;return url.includes('/stat/query')?atpHtml:schedule}
 const out=await collector.main(c,{matches:[atp],now,readHtml})
 assert.equal(out.fetched,1);assert.equal(calls,2)
 const cached=structuredClone(c.stored.get('atp:tennis-stats:20261017').payload.matches[atp.id])
 assert.equal(cached.complete,true);assert.equal(c.writes[0].comp,'atp')
 await collector.main(c,{matches:[atp],now:now+60000,readHtml});assert.equal(calls,2)
 const fail=await collector.main(c,{matches:[atp],now:now+25*3600000,readHtml:async()=>{throw Error('offline')}})
 assert.equal(fail.fetched,0)
 assert.deepEqual(c.stored.get('atp:tennis-stats:20261017').payload.matches[atp.id],cached)
})

test('completed ATP statistics stop frequent refetches but allow a daily correction',async()=>{
 const c=cloud(),readHtml=async url=>url.includes('/stat/query')?atpHtml:schedule
 await collector.main(c,{matches:[atp],now,readHtml})
 let requests=0
 const counted=async url=>{requests++;return readHtml(url)}
 await collector.main(c,{matches:[atp],now:now+7*3600000,readHtml:counted})
 assert.equal(requests,0)
 await collector.main(c,{matches:[atp],now:now+25*3600000,readHtml:counted})
 assert.equal(requests,2)
})

test('WTA keeps fresh official statistics without relay requests, falls back on an outage and returns to official after recovery',async()=>{
 const primary=collector.normalize(raw,wta,official,false,now)
 const c=cloud([bucket(wta,primary)]);let relayCalls=0
 const readHtml=async url=>{relayCalls++;return url.includes('/stat/query')?wtaHtml:schedule}
 await collector.main(c,{matches:[wta],now,read:async()=>{throw Error('unexpected official read')},readHtml})
 assert.equal(relayCalls,0)
 const empty=cloud()
 await collector.main(empty,{matches:[wta],now,read:async()=>{throw Error('official offline')},readHtml})
 assert.equal(empty.stored.get('wta:tennis-stats:20261017').payload.matches[wta.id].provider,'live-tennis')
 const read=async url=>url.includes('/stats')?raw:url.includes('/matches')?{matches:[official]}:{content:[event]}
 await collector.main(empty,{matches:[wta],now:now+15*60000,read,readHtml})
 assert.equal(empty.stored.get('wta:tennis-stats:20261017').payload.matches[wta.id].provider,'wta')
 assert.equal(empty.stored.get('wta:tennis-stats:20261017').payload.matches[wta.id].complete,true)
})

test('failed or empty historical matches are negatively cached and a batch is bounded',async()=>{
 const c=cloud();let calls=0
 const readHtml=async()=>{calls++;return ''}
 await collector.main(c,{matches:[atp],now,readHtml})
 await collector.main(c,{matches:[atp],now:now+60000,readHtml})
 assert.equal(calls,1)
 const rows=Array.from({length:12},(_,i)=>({...atp,id:'atp-'+i}))
 const other=cloud();await collector.main(other,{matches:rows,now,readHtml,maxRelayMatches:2})
 assert.equal(Object.keys(other.stored.get('atp:tennis-stats:20261017').payload.relayAttempts).length,2)
})

test('all 20 recent Shanghai/Wuhan matches map by date, station, round and complete player identities',()=>{
 const matches=JSON.parse(fixture('recent-matches.json'))
 assert.equal(matches.length,20)
 for(const m of matches){const day=m.date.replaceAll('-',''),es=adapter.parseSchedule(fixture('schedule-'+day+'.html'),m.date);assert.ok(adapter.findMatch(m,es),m.id+' '+m.home.name+' / '+m.away.name)}
})

test('retired matches retain their partial set and actual technical statistics as a completed record',()=>{
 const m={...atp,id:'atp-184955',date:'2026-10-15',start:'2026-10-15T06:40Z',stage:'Rolex Shanghai Masters · Quarterfinal',home:{id:'10427',name:'Arthur Gea'},away:atp.away}
 const es=adapter.parseSchedule(fixture('schedule-20261015.html'),'2026-10-15'),found=adapter.findMatch(m,es)
 assert.ok(found)
 const p=adapter.normalize(fixture('atp-retired.html'),m,found,now)
 assert.ok(p)
 assert.equal(p.complete,true)
 assert.equal(p.sections.length,2)
 assert.ok(p.sections[0].rows.some(r=>r[0]==='总得分'))
})

test('relay fills a missing official value without replacing an official value or dropping official-only statistics',async()=>{
 const primary=collector.normalize(raw,wta,official,false,now)
 primary.sections[0].rows.find(r=>r[0]==='双误')[1]=null
 const c=cloud([bucket(wta,primary)])
 await collector.main(c,{matches:[wta],now,readHtml:async url=>url.includes('/stat/query')?wtaHtml:schedule})
 const p=c.stored.get('wta:tennis-stats:20261017').payload.matches[wta.id]
 assert.deepEqual(row(p,'双误'),['双误',2,7])
 assert.deepEqual(row(p,'ACE'),row(primary,'ACE'))
 assert.deepEqual(row(p,'破发点挽救率'),row(primary,'破发点挽救率'))
 assert.equal(p.source,'WTA 官方 + Live-tennis')
 assert.equal(p.complete,true)
})
