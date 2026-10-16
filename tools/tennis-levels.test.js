const test=require('node:test'),assert=require('node:assert/strict')
const levels=require('../utils/tennis-levels')
test('verified levels distinguish tours at the same station and never carry over to another year',()=>{
  assert.equal(levels.level('atp','China Open','2026-09-30'),'ATP 500')
  assert.equal(levels.level('wta','China Open','2026-10-01'),'WTA 1000')
  assert.equal(levels.level('wta','Kinoshita Group Japan Open','2026-10-19'),'WTA 250')
  assert.equal(levels.level('atp','Erste Bank Open','2026-10-26'),'ATP 500')
  assert.equal(levels.level('wta','China Open','2027-10-01'),'')
  assert.equal(levels.level('wta','Unknown','2026-10-01'),'')
})
test('calendar refresh retains older station levels when the rolling feed advances',async()=>{
  const source=require('./tennis-rankings'),old={tour:'wta',name:'China Open',level:'WTA 1000',start:'2026-09-30',end:'2026-10-11'}
  const previous={wta:{tournaments:[old]}}
  const raw={snap:'2026-10-12',s:Array.from({length:100},(_,i)=>({n:'Player '+i,or:i+1,op:1000-i})),week:[{tour:'wta',name:'Wuhan',lvl:'WTA 1000',d0:'2026-10-12',d1:'2026-10-18'}]}
  const result=await source.refresh(previous,{now:Date.parse('2026-10-16'),fetch:async()=>({ok:true,json:async()=>raw})})
  assert.ok(result.wta.tournaments.some(r=>r.name==='China Open'))
  assert.ok(result.wta.tournaments.some(r=>r.name==='Wuhan'))
  assert.equal(levels.mergeCalendar([old],[{...old,level:'updated'}]).length,1)
  assert.equal(levels.mergeCalendar([old],[{...old,level:'updated'}])[0].level,'updated')
})
