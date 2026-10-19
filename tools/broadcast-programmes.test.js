const test=require('node:test'),assert=require('node:assert/strict')
const sources=require('./broadcast-sources')
function programme(title='WTA500宁波站 中心球场 第1日',start='2026-10-19 12:00:00') {
  return {matchInfo:{matchDesc:'WTA500宁波站',leftName:title,rightName:'',startTime:start},url:'https://m.sports.qq.com/sports-mp/index.html#/pages/game/game?mid=100002:30002991'}
}
function page(entries) { return JSON.stringify({type1500:{list:entries}}) }
function match(id='center',extra={}) {
  return {id,comp:'wta',stage:'BNB Ningbo Open · Round 1',start:'2026-10-19T11:35Z',venue:'Ningbo, China PR · Center Court',
    home:{name:'Diane Parry'},away:{name:'Alexandra Eala'},broadcast:[],...extra}
}
test('Tencent full-day tennis court streams survive the missing away-player field',()=>{
  const rows=sources.readTencentMatches(page([programme(),programme('WTA500宁波站 大看台球场 第1日'),
    {matchInfo:{leftName:'篮球资讯',rightName:'',startTime:'2026-10-19 12:00:00'}}]))
  assert.equal(rows.length,2)
  assert.equal(rows[0].event,'ningbo')
  assert.equal(rows[0].court,'center')
  assert.equal(rows[1].court,'grandstand')
})
test('court programmes match the same tournament, Beijing date and court without a 15-minute limit',()=>{
  const rows=sources.readTencentMatches(page([programme()]))
  const inputs=[match(),match('other-court',{venue:'Ningbo, China PR · Grandstand'}),
    match('next-day',{start:'2026-10-20T04:05Z'}),match('unknown-court',{venue:'Ningbo, China PR'}),
    match('other-tournament',{stage:'China Open · Round 1',venue:'Beijing, China PR · Center Court'})]
  const labeled=sources.mergeBroadcasts(inputs,rows)
  assert.deepEqual(labeled[0].broadcast,['腾讯'])
  assert.ok(labeled.slice(1).every(m=>!m.broadcast.includes('腾讯')))
  assert.equal(sources.mergeBroadcasts([match('grandstand',{venue:'Ningbo, China PR · Grandstand'})],sources.readTencentMatches(page([programme('WTA500宁波站 大看台球场 第1日')])))[0].broadcast[0],'腾讯')
})
test('normal head-to-head broadcasts retain exact team/time matching and no stream is invented for missing days',()=>{
  const entries=[{matchInfo:{leftName:'阿森纳',rightName:'切尔西',startTime:'2026-10-19 20:00:00'}}]
  const rows=sources.readTencentMatches(page(entries))
  const football={id:'epl',comp:'epl',start:'2026-10-19T12:00Z',home:{name:'阿森纳'},away:{name:'切尔西'},broadcast:[]}
  assert.deepEqual(sources.mergeBroadcasts([football],rows)[0].broadcast,['腾讯'])
  assert.deepEqual(sources.mergeBroadcasts([match()],[])[0].broadcast,[])
})
test('event archives roundtrip daily court broadcasts without spreading them to other dates or courts',()=>{
  const archive=require('../utils/tennis-event')
  const central={...match('wta-center'),eventId:'963-2026',eventStart:'2026-10-19T04:00Z',eventEnd:'2026-10-25T12:00Z',broadcast:['腾讯']}
  const other={...central,id:'wta-other',start:'2026-10-20T04:00Z',broadcast:[]}
  const packed=archive.buildArchive([central,other],null,Date.parse('2026-10-19T12:00Z'))
  assert.deepEqual(packed.events[0].broadcast,[])
  const restored=archive.archiveRows(packed)
  assert.deepEqual(restored.find(m=>m.id==='wta-center').broadcast,['腾讯'])
  assert.deepEqual(restored.find(m=>m.id==='wta-other').broadcast,[])
  const legacy=structuredClone(packed)
  legacy.events[0].broadcast=['咪咕']
  for(const row of legacy.matches.wta)row.length=Math.min(row.length,12)
  assert.ok(archive.archiveRows(legacy).every(m=>m.broadcast[0]==='咪咕'))
})
