/** A GitHub-local idle certificate. Gate mode performs zero WorkBuddy requests. */
const fs=require('node:fs'),path=require('node:path')
const MIN=60000,HOUR=60*MIN,DAY=24*HOUR,VERSION=1
const FILE=path.join(__dirname,'../.workbuddy/activity-plan.json')
const score=row=>JSON.stringify([row.hs??null,row.as??null])
const day=ms=>new Date(ms+8*HOUR).toISOString().slice(0,10).replaceAll('-','')
function reportWindow(now){
  return [now,now+15*MIN].some(t=>[6,7,9,10,14,15,21,22].includes(new Date(t+8*HOUR).getUTCHours()))
}
function matchActivity(matches,now){
  return matches.some(m=>['live','inprogress'].includes(m.status)||(m.status==='upcoming'
    &&(!Number.isFinite(Date.parse(m.start))||Date.parse(m.start)<=now+90*MIN)))
}
function decide(plan,{now=Date.now(),sha,force=false}={}){
  const run=reason=>({run:true,reason})
  if(force)return run('forced')
  if(reportWindow(now))return run('report-window')
  if(!plan||plan.version!==VERSION||plan.sha!==sha||plan.ready!==true)return run('no-trusted-idle-plan')
  const at=Date.parse(plan.createdAt),due=Date.parse(plan.maintenanceAt)
  if(!Number.isFinite(at)||at>now||now-at>=HOUR||!Number.isFinite(due)||due>at+HOUR||now>=due)return run('maintenance-due')
  if(!Array.isArray(plan.matches)||!plan.matches.length||!plan.finals||typeof plan.finals!=='object')return run('invalid-plan')
  if(plan.matches.some(m=>!m||typeof m.id!=='string'||typeof m.status!=='string'||!Number.isFinite(Date.parse(m.start))))return run('invalid-plan')
  if(matchActivity(plan.matches,now))return run('match-or-reminder-window')
  return {run:false,reason:'idle-candidate'}
}
async function gate(plan,options={}){
  const local=decide(plan,options)
  if(local.run)return local
  try{
    const result=await (options.discover||discover)()
    const after=decide(plan,{...options,now:options.now??Date.now()})
    if(after.run)return after
    if(!result?.healthy||!Array.isArray(result.rows))return {run:true,reason:'upstream-unknown'}
    if(result.active)return {run:true,reason:'upstream-active'}
    const changed=result.rows.some(r=>r.st==='finished'&&plan.finals[r.id]!==score(r))
    if(changed)return {run:true,reason:'new-or-corrected-final'}
    return {run:false,reason:'verified-idle',sources:result.sources,maintenanceAt:plan.maintenanceAt,workbuddyRequests:0}
  }catch(_){return {run:true,reason:'upstream-probe-failed'}}
}
async function discover(){
  // Isolate and bound all retries together. A hung source cannot delay the normal job indefinitely.
  const execute=require('node:util').promisify(require('node:child_process').execFile)
  const {stdout}=await execute(process.execPath,[__filename,'--discover'],{timeout:45000,maxBuffer:1024*1024})
  return JSON.parse(stdout.trim())
}
function makePlan({matches,snapshotAt,sources,details={},stats={},now=Date.now(),sha,expected=[],healthy=true}){
  const snapshotTime=Date.parse(snapshotAt)
  const base={version:VERSION,sha,createdAt:new Date(now).toISOString(),ready:false,
    maintenanceAt:new Date(Number.isFinite(snapshotTime)?Math.min(now+HOUR,snapshotTime+90*MIN):now).toISOString(),
    matches:matches.map(m=>({id:m.id,status:m.status,start:m.start})),
    finals:Object.fromEntries(matches.filter(m=>m.status==='finished').map(m=>[m.id,score({hs:m.home?.score,as:m.away?.score})]))}
  if(!healthy)return {...base,reason:'previous-job-failed'}
  if(!matches.length||!expected.length||expected.some(k=>!sources?.[k]?.ok||!Number.isFinite(Date.parse(sources[k].checkedAt))
    ||now-Date.parse(sources[k].checkedAt)>10*MIN||Date.parse(sources[k].checkedAt)>now))return {...base,reason:'unhealthy-or-missing-sources'}
  if(!Number.isFinite(Date.parse(snapshotAt))||Date.parse(snapshotAt)>now||now-Date.parse(snapshotAt)>=90*MIN)return {...base,reason:'snapshot-maintenance-due'}
  if(matchActivity(matches,now))return {...base,reason:'match-or-reminder-window'}
  const model=require('./match-detail'),tennis=require('./tennis-stats'),lol=require('./lol-detail')
  const recent=matches.filter(m=>m.status==='finished'&&Date.parse(m.start)>=now-2*DAY&&Date.parse(m.start)<=now)
  for(const m of recent){
    if(['atp','wta'].includes(m.comp)){
      // Same named-player eligibility as the tennis collector; placeholders have no statistics.
      if(!m.home?.name||!m.away?.name||/^(TBD|待定)$/i.test(m.home.name)||/^(TBD|待定)$/i.test(m.away.name))continue
      const p=stats[m.id],age=now-Date.parse(p?.ts||'')
      if(!p?.complete||!tennis.hasCore(p)||p.h!==String(m.home.id)||p.a!==String(m.away.id)
        ||!Number.isFinite(age)||age<0||age>=24*HOUR)return {...base,reason:'tennis-statistics-pending'}
    }else if((model.resolveSlug(m)||m.comp==='kpl'||lol.isLol(m.comp))&&model.needsFetch(m,details,now+15*MIN)){
      return {...base,reason:'post-match-detail-pending'}
    }
  }
  return {...base,ready:true,reason:'healthy-idle-certificate'}
}
async function record(cloud,{now=Date.now(),sha,healthy=true}={}){
  if(!healthy)return {version:VERSION,sha,createdAt:new Date(now).toISOString(),ready:false,reason:'previous-job-failed'}
  const read=async(table,fields,configure=q=>q.eq('id','latest').single())=>{
    const r=await configure(cloud.database.from(table).select(fields));if(r.error||!r.data)throw Error('Unable to read '+table);return r.data
  }
  const [snapshot,live]=await Promise.all([read('schedule_cache','data,meta,generated_at'),read('live_scores','data,generated_at')])
  let matches=require('../utils/snapshot').decodeSnapshot(snapshot.data).map(m=>({...m,home:{...m.home},away:{...m.away}}))
  const archive=require('../utils/tennis-event')
  if(snapshot.meta?.tennisEvents?.version===3)matches=archive.mergeRows(matches,archive.archiveRows(snapshot.meta.tennisEvents))
  const at=Date.parse(live.generated_at)
  if(!Number.isFinite(at)||at>now||now-at>10*MIN)throw Error('Stale live heartbeat')
  const patches=new Map((live.data?.rows||[]).map(r=>[r.id,r]))
  for(const m of matches){const p=patches.get(m.id);if(!p)continue
    const patchAt=Date.parse(p.at||live.generated_at)
    if(!Number.isFinite(patchAt)||patchAt<Date.parse(snapshot.generated_at)||patchAt>now)continue
    m.status=p.st||m.status
    if(p.hs!=null)m.home.score=p.hs;if(p.as!=null)m.away.score=p.as
  }
  const expected=require('./live-watch').expectedSources()
  const input={matches,snapshotAt:snapshot.generated_at,sources:live.data?.sources,now,sha,expected}
  // Busy runs only need an active marker. Read recent stats solely when idle is possible.
  if(matchActivity(matches,now))return makePlan(input)
  const recent=matches.filter(m=>m.status==='finished'&&Date.parse(m.start)>=now-2*DAY&&Date.parse(m.start)<=now)
  const days=[...new Set(recent.map(m=>day(Date.parse(m.start))))]
  const keys=[...new Set(recent.filter(m=>['atp','wta'].includes(m.comp)).map(m=>`${m.comp}:tennis-stats:${day(Date.parse(m.start))}`))]
  const [buckets,tennis]=await Promise.all([
    days.length?read('match_detail','payload',q=>q.in('day',days)):[],
    keys.length?read('team_roster','payload',q=>q.in('id',keys)):[]])
  const details=Object.assign({},...buckets.map(b=>b.payload)),stats=Object.assign({},...tennis.map(b=>b.payload?.matches))
  return makePlan({...input,details,stats})
}
async function cli(){
  if(process.argv.includes('--discover')){console.log(JSON.stringify(await require('./live-watch').probeActivity()));return}
  const sha=process.env.GITHUB_SHA||require('node:child_process').execFileSync('git',['rev-parse','HEAD'],{cwd:path.join(__dirname,'..'),encoding:'utf8'}).trim()
  if(process.argv.includes('--record')){
    let plan
    try{
      const healthy=process.env.ACTIVITY_HEALTHY==='true'
      const cloud=healthy?require('@tencent-ai/workbuddy-cloud-sdk').createWorkBuddyCloud(require('../utils/cloud-config')):null
      plan=await record(cloud,{sha,healthy})
    }catch(_){plan={version:VERSION,sha,ready:false,reason:'record-unavailable'}}
    fs.mkdirSync(path.dirname(FILE),{recursive:true});fs.writeFileSync(FILE,JSON.stringify(plan))
    console.log('[activity-plan]',JSON.stringify({ready:plan.ready,reason:plan.reason,maintenanceAt:plan.maintenanceAt}));return
  }
  let result
  try{
    let plan=null;try{plan=JSON.parse(fs.readFileSync(FILE,'utf8'))}catch(_){}
    result=await gate(plan,{sha,force:process.env.ACTIVITY_FORCE==='true'})
  }catch(_){result={run:true,reason:'gate-unavailable'}}
  console.log('[activity-gate]',JSON.stringify(result))
  if(process.env.GITHUB_OUTPUT)fs.appendFileSync(process.env.GITHUB_OUTPUT,`run=${result.run}\nreason=${result.reason}\n`)
  if(process.env.GITHUB_STEP_SUMMARY)fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY,
    `## 闲时整班判断\n\n${result.run?'正常执行云端任务':'确认空闲，本班跳过全部 WorkBuddy 请求'}；原因：${result.reason}。${result.run?'':'仅检查外部赛事源，没有探测云数据库；不代表云数据刚刚刷新。'}\n`)
}
if(require.main===module)cli().catch(error=>{console.error(error.message);process.exitCode=1})
module.exports={decide,gate,makePlan,record,reportWindow,matchActivity}
