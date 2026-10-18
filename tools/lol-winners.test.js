const test=require('node:test'),assert=require('node:assert/strict')
const w=require('./lol-winners'),view=require('../utils/lol-view')
const m={id:'lck-one',comp:'lck',start:'2026-09-13T05:00:00Z',status:'finished',home:{id:'GEN',name:'Gen.G',score:1},away:{id:'HLE',name:'Hanwha Life Esports',score:1}}
const games=[{number:1,id:'g1',state:'completed'},{number:2,id:'g2',state:'completed'}]

test('OP.GG explicitly verifies latest Worlds maps by league/year/date/teams and final series score',async()=>{
  const rows=require('./fixtures/health-20261018/opgg-matches.json').data.matches
  const raw=require('./fixtures/health-20261018/opgg-games.json').data
  const match={id:'worlds-115660588583171798',comp:'worlds',start:'2026-10-17T18:00Z',status:'finished',home:{id:'MVK',name:'MVK Esports',score:3},away:{id:'FUR',name:'FURIA',score:1}}
  const played=Array.from({length:4},(_,i)=>({id:'g'+i,number:i+1,state:'completed'}))
  const found=w.opggMatch(rows,match)
  assert.equal(found.id,'32716')
  assert.deepEqual(w.opggRows(raw,found,match,played).map(r=>r.winner),['home','home','away','home'])
  assert.equal(w.opggMatch(rows,{...match,home:{...match.home,id:'MKOI',name:'Movistar KOI'}}),null)
  assert.equal(w.opggMatch(rows,{...match,start:'2026-10-15T18:00Z'}),null)
  assert.equal(w.opggMatch(rows,{...match,comp:'lpl'}),null)
  assert.equal(w.opggMatch([...rows,...rows],match),null)
  assert.deepEqual(w.opggRows({...raw,g3:{...raw.g3,winner:{id:'unknown'}}},found,match,played),[])
  assert.deepEqual(w.opggRows({...raw,g3:{...raw.g3,set:4}},found,match,played),[])
  const result=await w.fetchWinners(match,played,async(url,options)=>{
    assert.ok(url.includes('esports.op.gg'))
    return JSON.stringify(JSON.parse(options.body).query.includes('ListMatches')?{data:{matches:rows}}:{data:raw})
  })
  assert.equal(result.provider,'OP.GG Esports')
})
const list="<table class='table_list'><tr><td><a href='../game/stats/1/page-summary/'>GEN vs HLE</a></td><td>Gen.G</td><td>1 - 1</td><td>Hanwha Life Esports</td><td>ROUND1</td><td>16.16</td><td>2026-09-13</td></tr></table>"
const summary="<a href='../game/stats/1/page-game/' title='test'>Game 1</a><a href='../game/stats/2/page-game/' title='test'>Game 2</a><!-- game by game --><h1><a href='x'>Hanwha Life Esports</a></h1><h1><a href='x'>Gen.G</a></h1><div class='row pb-1'><h1 class='text_victory'>WIN</h1><h1 class='text_defeat'>LOSS</h1></div><div class='row pb-1'><h1 class='text_defeat'>LOSS</h1><h1 class='text_victory'>WIN</h1></div>"
test('explicit WIN/LOSS is mapped across reversed series order, never by score-box or economy',()=>{
  assert.deepEqual(w.parseSummary(summary,m,games),[{n:1,winner:'away'},{n:2,winner:'home'}])
  assert.equal(w.parseMatchList(list)[0].date,'2026-09-13')
  assert.deepEqual(w.parseSummary(summary.replaceAll('WIN','UNKNOWN'),m,games),[])
  assert.deepEqual(w.parseSummary(summary,{...m,home:{...m.home,score:2}},games),[])
  assert.deepEqual(w.parseSummary(summary,{...m,away:{...m.away,id:'T1',name:'T1'}},games),[])
})
test('Tencent winner IDs require matching teams, date, actual game numbers and complete series totals',()=>{
  const d={teamAName:'HLE',teamBName:'GEN',teamAId:1,teamBId:2,matchTime:m.start,matchInfos:games.map((g,i)=>({bo:g.number,matchWin:i?2:1,matchEndTime:'2026-09-13T07:00:00Z'}))}
  assert.deepEqual(w.tencentRows(d,m,games,Date.parse('2026-09-14')), [{n:1,winner:'away'},{n:2,winner:'home'}])
  assert.deepEqual(w.tencentRows({...d,matchTime:'2025-09-13'},m,games),[])
  assert.deepEqual(w.tencentRows({...d,matchInfos:d.matchInfos.map(r=>({...r,matchWin:999}))},m,games),[])
  assert.equal(w.validWinners([{n:1,winner:'home'},{n:1,winner:'away'}],m,games),false)
})
test('all six competitions use dated tournament evidence, while Asian Games never requests winner sources',async()=>{
  const names={worlds:'Worlds 2026',lpl:'LPL 2026 Split 3',lck:'LCK 2026 Season Playoffs',lec:'LEC 2026 Summer Playoffs',msi:'MSI 2026',demacia:'Demacia Cup Global Invitational 2026'}
  for(const comp of w.SUPPORTED){
    const result=await w.fetchWinners({...m,comp},games,async url=>{
      if(url.includes('lpl.qq.com'))return '{"msg":[]}'
      if(url.includes('ajax.trlist'))return JSON.stringify([{trname:names[comp],firstgame:'2026-09-01',lastgame:'2026-09-30'}])
      return url.includes('tournament-matchlist')?list:summary
    })
    assert.equal(result.winners[0].winner,'away',comp)
  }
  assert.equal(await w.fetchWinners({...m,comp:'agames'},games,()=>{throw Error('must not request')}),null)
  assert.equal(w.tournamentFor('LCK CL 2026','lck'),false)
  assert.equal(w.tournamentFor('LPLOL 2026','lpl'),false)
})
test('ambiguous or wrong-date series matches cannot produce winners',async()=>{
  for(const html of [list.replace('2026-09-13','2026-09-12'),list.replace('</table>',list.match(/<tr>[\s\S]*<\/tr>/)[0]+'</table>')]){
    const result=await w.fetchWinners(m,games,async url=>url.includes('ajax.trlist')?JSON.stringify([{trname:'LCK 2026',firstgame:'2026-09-01',lastgame:'2026-09-30'}]):html)
    assert.equal(result,null)
  }
})
test('view labels actual winning/losing team, tolerates missing stats, and keeps unknown results explicit',()=>{
  const build=(winner,comp='lck')=>view.buildLol({comp,lol:{rounds:[{id:'g1',n:1,winner,h:null,a:null}]}},'GEN','HLE')
  assert.deepEqual(build('away').rounds[0].teams.map(t=>t.result),['负','胜'])
  assert.equal(build(undefined).rounds[0].resultNote,'胜负待确认')
  assert.equal(build(undefined,'agames').showResult,false)
  const swapped=view.buildLol({comp:'lck',lol:{homeCode:'HLE',awayCode:'GEN',rounds:[{n:1,id:'g',winner:'home',h:{kills:20},a:{kills:10}}]}},'GEN','HLE',m)
  assert.deepEqual(swapped.rounds[0].teams.map(t=>t.result),['负','胜'])
  assert.equal(swapped.rounds[0].teams[0].kills,'10')
})
test('winner enrichment preserves terminal statistics and known winners during source outages, correcting swapped team order',async()=>{
  const {fetchLolDetail}=require('./lol-detail')
  const match={...m,id:'lck-m',home:{id:'GEN',score:1},away:{id:'HLE',score:0}}
  const event={data:{event:{id:'m',match:{teams:[{id:'rh',code:'GEN',name:'Gen.G'},{id:'ra',code:'HLE',name:'Hanwha Life Esports'}],
    games:[{id:'g1',number:1,state:'completed'}]}}}}
  const previous={lol:{winnerSource:'Verified source',rounds:[{id:'g1',n:1,complete:true,h:{id:'ra',kills:5},a:{id:'rh',kills:10},winner:'away'}]}}
  const result=await fetchLolDetail(match,async url=>{if(url.includes('getEventDetails'))return event;throw Error('feed unavailable')},Date.now(),async()=>{throw Error('winner unavailable')},previous)
  assert.equal(result.lol.complete,true);assert.equal(result.lol.rounds[0].h.kills,10)
  assert.equal(result.lol.rounds[0].winner,'home');assert.equal(result.lol.winnerComplete,true)
})
