const test=require('node:test'),assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path')
const activity=require('./activity-gate'),MIN=60000,HOUR=60*MIN,now=Date.parse('2026-10-19T03:00:00+08:00'),sha='same-code'
const match={id:'epl-next',comp:'epl',status:'upcoming',start:new Date(now+5*HOUR).toISOString(),home:{id:'h',name:'Home'},away:{id:'a',name:'Away'}}
const make=(more={})=>activity.makePlan({matches:[match],snapshotAt:new Date(now).toISOString(),sources:{source:{ok:true,checkedAt:new Date(now).toISOString()}},expected:['source'],now,sha,...more})
const idle=async()=>({healthy:true,active:false,rows:[],sources:45})

test('verified idle gates do not access WorkBuddy, even for a cloud SDK that would throw',async()=>{
  const old=global.fetch;let calls=0
  global.fetch=async()=>{calls++;throw Error('No cloud traffic allowed')}
  try{
    assert.equal((await activity.gate(make(),{now:now+15*MIN,sha,discover:idle})).run,false)
    assert.equal(calls,0)
  }finally{global.fetch=old}
})
test('missing, old, different-code, malformed and future plans always run without needing the upstream probe',async()=>{
  for(const plan of [null,{}, {...make(),sha:'old'}, {...make(),ready:false}, {...make(),createdAt:'invalid'},
    {...make(),createdAt:new Date(now+MIN).toISOString()}, {...make(),maintenanceAt:new Date(now+2*HOUR).toISOString()}]){
    assert.equal((await activity.gate(plan,{now,sha,discover:()=>{throw Error('must not discover')}})).run,true)
  }
  assert.equal(activity.decide(make(),{now:now+HOUR,sha}).reason,'maintenance-due')
  assert.equal(activity.decide(make(),{now,sha,force:true}).reason,'forced')
})
test('90-minute reminder guard, long live games and overdue starts all force normal work',()=>{
  for(const m of [{...match,start:new Date(now+90*MIN).toISOString()}, {...match,start:new Date(now-MIN).toISOString()},
    {...match,start:new Date(now-12*HOUR).toISOString()},
    {...match,status:'live',start:new Date(now-10*HOUR).toISOString()}]){
    assert.equal(make({matches:[m]}).ready,false)
    assert.equal(activity.decide({...make(),matches:[m]},{now,sha}).run,true)
  }
})
test('daily and Worlds report windows, their retries and the preceding trigger stay active',()=>{
  for(const time of ['05:50','06:00','07:59','08:50','09:00','10:59','13:50','14:00','15:59','20:50','21:00','22:59']){
    assert.equal(activity.decide(make(),{now:Date.parse('2026-10-19T'+time+':00+08:00'),sha}).reason,'report-window',time)
  }
})
test('upstream failure, active games, new finals and corrected scores wake cloud work',async()=>{
  const plan={...make(),finals:{'epl-done':'[1,0]'}}
  for(const result of [{healthy:false,rows:[]}, {healthy:true,active:true,rows:[]},
    {healthy:true,rows:[{id:'epl-new',st:'finished',hs:1,as:0}]}, {healthy:true,rows:[{id:'epl-done',st:'finished',hs:2,as:0}]}]){
    assert.equal((await activity.gate(plan,{now,sha,discover:async()=>result})).run,true)
  }
  assert.equal((await activity.gate(plan,{now,sha,discover:async()=>{throw Error('offline')}})).run,true)
  assert.equal((await activity.gate(plan,{now,sha,discover:async()=>({healthy:true,rows:[{id:'epl-done',st:'finished',hs:1,as:0}]})})).run,false)
})
test('the bounded discovery child timing out fails open instead of hanging the normal job',async()=>{
  const child=require('node:child_process'),original=child.execFile
  child.execFile=(binary,args,options,callback)=>{
    assert.deepEqual(args,[path.join(__dirname,'activity-gate.js'),'--discover'])
    assert.equal(options.timeout,45000)
    callback(Object.assign(Error('Timed out'),{killed:true}), '', '')
  }
  try{assert.equal((await activity.gate(make(),{now,sha})).reason,'upstream-probe-failed')}
  finally{child.execFile=original}
})
test('bad sources, stale snapshots and failed runs cannot produce trusted idle certificates',async()=>{
  assert.equal(make({sources:{source:{ok:false}}}).ready,false)
  assert.equal(make({snapshotAt:'invalid'}).ready,false)
  assert.equal(make({snapshotAt:new Date(now-90*MIN).toISOString()}).ready,false)
  assert.equal((await activity.record({database:{from(){throw Error('must not query')}}},{now,sha,healthy:false})).ready,false)
})
test('unsettled football, KPL and LOL details continue their existing fast retry path',()=>{
  for(const comp of ['epl','kpl','worlds']){
    const m={...match,id:comp+'-done',comp,status:'finished',start:new Date(now-3*HOUR).toISOString(),home:{...match.home,score:3},away:{...match.away,score:1}}
    assert.equal(make({matches:[m],details:{[m.id]:{v:6,fin:false,ts:now-20*MIN}}}).reason,'post-match-detail-pending',comp)
  }
})
test('completed tennis stats can sleep; missing, mismapped, partial or correction-due stats cannot',()=>{
  const m={...match,id:'atp-done',comp:'atp',status:'finished',start:new Date(now-25*HOUR).toISOString()}
  const stats={complete:true,h:'h',a:'a',ts:new Date(now-HOUR).toISOString(),sections:[{n:0,rows:[['ACE',1,2],['双误',1,2],['总得分',40,50]]}]}
  assert.equal(make({matches:[m],stats:{[m.id]:stats}}).ready,true)
  for(const p of [undefined,{...stats,complete:false},{...stats,h:'wrong'},{...stats,sections:[]},
    {...stats,sections:[{n:0,rows:[['ACE'],['双误'],['总得分']]}]},{...stats,ts:new Date(now-24*HOUR).toISOString()}]){
    assert.equal(make({matches:[m],stats:{[m.id]:p}}).reason,'tennis-statistics-pending')
  }
})
test('upstream-only probe checks all real collector paths without touching a cloud endpoint',async()=>{
  const old=global.fetch,urls=[]
  global.fetch=async url=>{
    url=String(url);urls.push(url)
    assert.ok(!url.includes('/.cloud/'),'WorkBuddy must not be contacted')
    let data=url.includes('getScheduleList')?{data:{list:[]}}:url.includes('home_schedules')?{data:{}}:
      url.includes('getSchedule?')?{data:{schedule:{events:[],pages:{}}}}:{events:[]}
    return {ok:true,json:async()=>data}
  }
  try{
    const live=require('./live-watch'),result=await live.probeActivity()
    assert.equal(result.healthy,true);assert.equal(result.active,false)
    assert.equal(result.sources,live.expectedSources().length)
    assert.ok(urls.some(u=>u.includes('getScheduleList'))&&urls.some(u=>u.includes('tennis/wta'))&&urls.some(u=>u.includes('home_schedules')))
    // An unexpected football fixture 60 minutes away must wake pre-60 notifications.
    global.fetch=async url=>String(url).includes('/soccer/eng.1/')?{ok:true,json:async()=>({events:[{date:new Date(Date.now()+HOUR).toISOString(),status:{type:{state:'pre'}},competitions:[{date:new Date(Date.now()+HOUR).toISOString()}]}]})}:oldMock(url)
    const oldMock=async url=>{url=String(url);return {ok:true,json:async()=>url.includes('getScheduleList')?{data:{list:[]}}:url.includes('home_schedules')?{data:{}}:url.includes('getSchedule?')?{data:{schedule:{events:[],pages:{}}}}:{events:[]}}}
    assert.equal((await live.probeActivity()).active,true)
  }finally{global.fetch=old}
})
test('workflow guards the first WB probe and all downstream cloud operations on intentional skips',()=>{
  const workflow=fs.readFileSync(path.join(__dirname,'../.github/workflows/sync-schedule.yml'),'utf8')
  assert.ok(workflow.indexOf('id: activity')<workflow.indexOf('id: cloudhealth'))
  assert.match(workflow,/id: cloudhealth\s+#.*\s+if: steps.activity.outputs.run != 'false'/)
  assert.match(workflow,/if: always\(\) && steps.activity.outputs.run != 'false' && \(steps.cloudhealth/)
  assert.match(workflow,/SYNC_IDLE_SKIP_ENABLED/)
  assert.match(workflow,/uses: actions\/cache\/save@v4/)
})
