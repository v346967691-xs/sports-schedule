const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm')
const format=require('../utils/competition-format'),source=require('./competition-format-source'),snapshot=require('../utils/snapshot')
function match(id,h='A',a='B',extra={}) {return {id:String(id),comp:'msi',start:`2026-07-01T${String(id).padStart(2,'0')}:00:00Z`,date:'2026-07-01',time:'12:00',stage:'淘汰赛',status:'finished',bo:5,home:{id:h,name:h,score:3},away:{id:a,name:a,score:1},...extra}}
function double(){return [['A','B'],['C','D'],['E','F'],['G','H'],['A','C'],['E','G'],['B','D'],['F','H'],['A','E'],['C','B'],['G','F'],['C','G'],['E','C'],['E','A']].map(([h,a],i)=>match(i+1,h,a))}
test('complete verified double elimination is split into three tabs; clipped or contradictory histories are rejected',()=>{
 const games=double(),before=JSON.stringify(games),model=format.build(games,{comp:'msi'})
 assert.deepEqual(model.tabs.map(t=>t.label),['胜者组','败者组','总决赛'])
 assert.deepEqual(model.tabs.map(t=>t.cards.length),[7,6,1])
 assert.ok(model.tabs[1].cards.some(c=>c.route.includes('由胜者组落入')))
 assert.equal(format.completeDouble(games.slice(1)),null)
 assert.equal(format.completeDouble(games.map((m,i)=>i===3?{...m,home:{...m.home,id:'A'}}:m)),null)
 assert.equal(JSON.stringify(games),before)
 assert.equal(format.branchOf(match(1,'A','B',{stage:'全球总决赛 · 入围赛'})),'')
 assert.equal(format.build(double(),{comp:'lpl'}).tabs.length,0,'generic playoff label alone is not proof of double elimination')
})
test('explicit double stages render empty tabs and unknown matches without guessing; placements stay separate',()=>{
 const games=[match(1,'A','B',{stage:'胜者组 · Round 1'}),match(2,'C','D',{stage:'败者组 · Round 1'}),match(3,'A','D',{stage:'季军赛'})]
 // Branch name may precede a round segment, so explicit metadata is the canonical form.
 games[0].format={branch:'upper',roundOrder:1};games[1].format={branch:'lower',roundOrder:1}
 const model=format.build(games,{comp:'lpl',stage:'败者组'})
 assert.equal(model.initial,'double:lower');assert.ok(model.tabs.some(t=>t.key==='placement'))
 assert.equal(model.tabs.find(t=>t.key==='double:final').tree.nodes.length,0)
})
test('official group rows, ties and qualification zones are preserved; no score accumulation and both teams must belong',()=>{
 const table={groups:[{name:'A组',rows:[{id:'A',pos:1,wins:4,losses:0,played:4,pts:12,zone:{label:'出线区',color:'#123'}},{id:'B',pos:1,wins:4,pts:12}]}],season:'小组赛'}
 const model=format.build([match(1,'A','B',{stage:'小组赛'}),match(2,'A','Z',{stage:'小组赛'})],{comp:'x',cat:'football',table})
 const group=model.tabs[0].groups[0]
 assert.equal(group.rows[0].wins,4);assert.equal(group.rows[1].pos,1);assert.equal(group.rows[0].zoneBreak,true)
 assert.equal(group.games.length,1)
 assert.equal(format.standingsTab({groups:[{name:'东部',rows:table.groups[0].rows},{name:'西部',rows:[]}]},[],'basketball','nba'),null)
})
test('two-leg ties align reversed home/away; incomplete legs do not fabricate totals; penalties stay separate',()=>{
 const f={type:'two-leg',event:'lib:2026',tie:'A:B',phase:'半决赛',roundOrder:6,roundLabel:'半决赛'}
 const first=match(1,'A','B',{bo:null,format:{...f,leg:1},home:{id:'A',name:'A',score:2},away:{id:'B',name:'B',score:1}})
 const second=match(2,'B','A',{bo:null,format:{...f,leg:2,winnerId:'B',penalties:[5,4]},home:{id:'B',name:'B',score:1},away:{id:'A',name:'A',score:0}})
 const tie=format.seriesCards([first,second])[0]
 assert.equal(tie.headline,'2 – 2');assert.equal(tie.penalties,'点球 4 – 5');assert.equal(tie.entry.winnerId,'B')
 assert.equal(format.seriesCards([second])[0].headline,'待汇总')
 assert.equal(format.seriesCards([first,{...second,format:{...second.format,event:'lib:2027'}}]).length,2)
})
test('basketball series uses source series wins, not game points; future blank summaries cannot override a completed series',()=>{
 const f={event:'nba:2026',phase:'东部 · 首轮',tie:'A:B',type:'series',total:7,completed:true,wins:{A:4,B:2},winnerId:'A'}
 const first=match(1,'A','B',{bo:null,home:{id:'A',name:'A',score:120},away:{id:'B',name:'B',score:100},format:f})
 const future=match(2,'B','A',{status:'upcoming',format:{...f,completed:false,wins:{},winnerId:''}})
 const tie=format.seriesCards([first,future])[0]
 assert.equal(tie.headline,'4 – 2');assert.equal(tie.entry.winnerId,'A');assert.equal(tie.games.length,2)
})
test('ESPN extraction reuses scoreboard fields for round, leg, series and play-in routes, with snapshot backward compatibility',()=>{
 const comp={key:'lib',sport:'soccer',espn:'lib'},sides=[{id:'A'},{id:'B'}]
 const f=source.espn({season:{year:2026,slug:'semifinals'}},{leg:{value:1},notes:[{headline:'1st Leg'}],series:{title:'Semifinals',totalCompetitions:2},competitors:sides},comp)
 assert.equal(f.type,'two-leg');assert.equal(f.leg,1);assert.equal(f.roundLabel,'半决赛')
 const m=match(1,'A','B',{format:f}),raw=snapshot.encodeSnapshot([m]),decoded=snapshot.decodeSnapshot(raw)[0]
 assert.deepEqual(decoded.format,f);assert.equal(snapshot.decodeSnapshot(snapshot.encodeSnapshot([{...m,format:undefined}]))[0].format,undefined)
 const p=source.espn({season:{year:2026,slug:'play-in-season'}},{notes:[{headline:'NBA Play-In - East - 7th Place vs 8th Place'}]}, {key:'nba',sport:'basketball'})
 assert.match(p.route,/第7种子/)
 assert.equal(source.espn({season:{slug:'regular-season'}},{},{key:'nba',sport:'basketball'}),null)
})
test('conference series winners connect to the championship series using confirmed identity and explicit progression',()=>{
 const games=[match(1,'A','B',{format:{type:'series',event:'nba:2026',phase:'东部决赛',roundLabel:'东部分区决赛',roundOrder:7,tie:'A:B',completed:true,total:7,wins:{A:4,B:1},winnerId:'A'}}),
   match(2,'A','C',{format:{type:'series',event:'nba:2026',phase:'总决赛',roundLabel:'决赛',roundOrder:8,tie:'A:C',total:7,wins:{A:0,C:0}}})]
 const t=format.seriesTree(format.seriesCards(games));assert.equal(t.edges.length,1)
 assert.equal(t.edges[0].from,format.seriesCards(games)[0].key)
})
test('format component supports stage/group/series switching and detail navigation without any cloud requests',()=>{
 let definition;const filename=path.resolve(__dirname,'../components/competition-format/competition-format.js')
 vm.runInNewContext(fs.readFileSync(filename,'utf8'),{Component:d=>definition=d,require:()=>({controller:require('../utils/elimination-board').controller})})
 const events=[],page={...definition.methods,data:{...definition.data},setData(p){Object.assign(this.data,p)},triggerEvent:(...args)=>events.push(args)}
 const model=format.build(double(),{comp:'msi'});page.updateModel(model);page.onToggle();assert.equal(page.data.open,true)
 page.onPhase({currentTarget:{dataset:{key:'double:lower'}}});assert.equal(page.data.activeKey,'double:lower')
 page.onBoardMatch({detail:{id:'7'}});assert.equal(events[0][0],'matchtap');assert.equal(events[0][1].id,'7')
 page.onSeries({currentTarget:{dataset:{key:'x'}}});assert.equal(page.data.selectedSeries,'x')
 page.onSeries({currentTarget:{dataset:{key:'x'}}});assert.equal(page.data.selectedSeries,'')
 assert.ok(!fs.readFileSync(filename,'utf8').includes('request('))
})
