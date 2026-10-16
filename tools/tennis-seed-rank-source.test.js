const test=require('node:test'),assert=require('node:assert/strict')
const ranking=require('./tennis-rankings'),snapshot=require('../utils/snapshot'),archive=require('../utils/tennis-event')
test('weekly normalization keeps prior weekly ranks separate from live positions',()=>{
 const raw={snap:'2026-10-12',s:Array.from({length:100},(_,i)=>({n:'Player '+i,or:i+1,op:1000-i,r:100-i,p:2000-i,pr:i+1}))}
 raw.s[0].pr=4;delete raw.s[1].pr
 const board=ranking.normalize(raw,'atp',Date.parse('2026-10-16'))
 assert.equal(board.rows[0].rank,1);assert.equal(board.rows[0].previousRank,4);assert.equal(board.rows[1].previousRank,null)
})
test('station-specific seeds survive the compact main and archive formats',()=>{
 const match={id:'atp-fixture',comp:'atp',start:'2026-10-16T04:00Z',status:'finished',statusText:'退赛',winnerId:'b',stage:'Fixture · Quarterfinal',eventId:'fixture-2026',eventStart:'2026-10-12T00:00Z',eventEnd:'2026-10-18T00:00Z',home:{id:'a',name:'A',score:1,seed:5},away:{id:'b',name:'B',score:0,seed:1},sets:{h:[6,1],a:[4,4]}}
 const second={...match,id:'atp-second',home:{...match.home,seed:2}}
 const rows=snapshot.decodeSnapshot(snapshot.encodeSnapshot([match,second]))
 assert.equal(rows.find(r=>r.id===match.id).home.seed,5);assert.equal(rows.find(r=>r.id===second.id).home.seed,2)
 const packed=archive.buildArchive([match],null,Date.parse('2026-10-16'))
 const row=archive.archiveRows(packed)[0];assert.equal(row.home.seed,5);assert.equal(row.away.seed,1)
 assert.equal(row.home.score,1);assert.equal(row.away.score,0);assert.deepEqual(row.sets,match.sets)
})
