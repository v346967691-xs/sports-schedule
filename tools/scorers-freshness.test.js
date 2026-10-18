const test=require('node:test'),assert=require('node:assert/strict')
const collector=require('./scorers')
const {scorersDueKeys}=require('./cloud-sync')
const at=Date.parse('2026-10-18T09:00:00Z')
test('real EPL and LaLiga leaders preserve exact source totals for goals and assists',()=>{
  const epl=collector.buildTable(require('./fixtures/health-20261018/epl.json'))
  const liga=collector.buildTable(require('./fixtures/health-20261018/liga.json'))
  assert.equal(epl.players.find(p=>p.i==='253989').g,8)
  assert.equal(liga.players.find(p=>p.i==='362150').g,8)
  assert.equal(liga.players.find(p=>p.i==='362150').a,6)
})
test('a failed league retains its last successful timestamp and rows while another league updates',async()=>{
  const previous={generatedAt:'2026-10-17T00:00Z',tables:{epl:{season:'2026-27',players:[{i:'253989',g:6}],fetchedAt:'2026-10-17T00:00Z'},nba:{boards:[{rows:[1]}]}}}
  const before=structuredClone(previous)
  const result=await collector.collectFootball(previous,{now:at,only:['epl','liga'],read:async url=>url.includes('eng.1')?null:require('./fixtures/health-20261018/liga.json')})
  assert.deepEqual(previous,before)
  assert.equal(result.tables.epl.players[0].g,6)
  assert.equal(result.tables.epl.fetchedAt,previous.generatedAt)
  assert.equal(result.tables.epl.stale,true)
  assert.equal(result.tables.liga.fetchedAt,new Date(at).toISOString())
  assert.deepEqual(result.tables.nba,previous.tables.nba)
})
test('the authoritative assist leaderboard value overrides an older cross-stat in the goals list',()=>{
  const raw=structuredClone(require('./fixtures/health-20261018/liga.json'))
  raw.stats[0].leaders.find(l=>l.athlete.id==='362150').athlete.statistics.find(s=>s.name==='goalAssists').value=5
  assert.equal(collector.buildTable(raw).players.find(p=>p.i==='362150').a,6)
})

test('an explicit leaderboard total survives a missing athlete statistics array',()=>{
  const raw=structuredClone(require('./fixtures/health-20261018/epl.json'))
  delete raw.stats[0].leaders[0].athlete.statistics
  const player=collector.buildTable(raw).players.find(p=>p.i===raw.stats[0].leaders[0].athlete.id)
  assert.equal(player.g,Number(raw.stats[0].leaders[0].value))
  assert.equal(player.p,null)
})
test('post-match scorer refresh targets only leagues whose own source timestamp predates the final',()=>{
  const starts=new Map([['epl-1','2026-10-17T18:00Z'],['liga-2','2026-10-17T18:00Z'],['nba-3','2026-10-17T18:00Z']])
  assert.deepEqual(scorersDueKeys([{id:'epl-1',st:'finished'},{id:'liga-2',st:'finished'},{id:'nba-3',st:'finished'}],starts,
    {epl:{fetchedAt:'2026-10-17T19:00Z'},liga:{fetchedAt:'2026-10-17T21:00Z'}},'2026-10-18T00:00Z'),['epl'])
})

test('legacy NBA timestamps and six-hour expiry cannot be renewed by a football refresh',async()=>{
  const nba={boards:[{rows:[{i:'1',v:30}]}],fetchedAt:new Date(at-6*3600000).toISOString()}
  const fresh=await collector.collectFootball({generatedAt:new Date(at-3600000).toISOString(),tables:{nba}},
    {now:at,only:['epl'],read:async()=>require('./fixtures/health-20261018/epl.json')})
  assert.equal(collector.reusableBasket(fresh.tables.nba,at),false)
  assert.equal(collector.reusableBasket({boards:nba.boards},at),false)
  assert.equal(collector.reusableBasket({...nba,fetchedAt:new Date(at-3600000).toISOString()},at),true)
  assert.equal(collector.reusableBasket({...nba,fetchedAt:new Date(at+3600000).toISOString()},at),false)
})
