/** 一次性移除旧赛程/归档/统计。默认只核查；--bundle 改本地数据，--cloud 改云缓存。 */
const fs=require('node:fs'),path=require('node:path')
const scope=require('../utils/tennis-scope'),archive=require('../utils/tennis-event'),snapshot=require('../utils/snapshot')
function prepare(data,meta) {
  for(const tour of ['atp','wta'])scope.setCalendar(tour,meta?.tennisRankings?.weekly?.[tour]?.tournaments)
  const rows=snapshot.decodeSnapshot(data),old=archive.archiveRows(meta?.tennisEvents,true)
  const removed=new Map(rows.concat(old).filter(m=>!scope.allows(m)).map(m=>[m.id,m]))
  const kept=rows.filter(m=>scope.allows(m))
  const nextMeta={...meta}
  if(meta?.tennisEvents)nextMeta.tennisEvents=archive.buildArchive(old.filter(m=>scope.allows(m)),null,Date.parse(meta.tennisEvents.generatedAt)||Date.now())
  return {rows:kept,meta:nextMeta,removed,report:{mainRemoved:rows.length-kept.length,archiveRemoved:old.filter(m=>!scope.allows(m)).length,
    events:[...new Set([...removed.values()].map(m=>`${m.comp}: ${String(m.stage).split('·')[0].trim()}`))]}}
}
function pruneStats(payload,ids) {
  if(!payload||typeof payload!=='object')return payload
  const result={...payload}
  for(const key of ['matches','attempts','relayAttempts'])if(payload?.[key])result[key]=Object.fromEntries(Object.entries(payload[key]).filter(([id])=>!ids.has(id)))
  return result
}
function guard(query,column,value) { return value==null?query.is(column,null):query.eq(column,value) }
async function update(query,patch,guards) {
  let q=query.update(patch)
  for(const [column,value] of guards)q=guard(q,column,value)
  const result=await q.select('id')
  if(result.error)throw Error(result.error.message)
  if(!result.data?.length)throw Error('并发更新，已停止；重新核查后再运行')
}
function bundle(root=path.resolve(__dirname,'..')) {
  const read=file=>{const p=path.join(root,'data',file);delete require.cache[require.resolve(p)];return require(p)}
  const data=read('matches.js'),meta=read('meta.js'),rankings=read('tennis-rankings.js'),events=read('tennis-events.js')
  const result=prepare(data,{...meta,tennisRankings:rankings,tennisEvents:events})
  fs.writeFileSync(path.join(root,'data/matches.js'),`module.exports = ${JSON.stringify(snapshot.encodeSnapshot(result.rows,{generatedAt:data.generatedAt,range:data.range}))}\n`)
  fs.writeFileSync(path.join(root,'data/tennis-events.js'),`module.exports = ${JSON.stringify(result.meta.tennisEvents)}\n`)
  return result.report
}
async function cloudRun(cloud,write=false) {
  const read=await cloud.database.from('schedule_cache').select('data,meta,generated_at').eq('id','latest').maybeSingle()
  if(read.error||!read.data)throw Error(read.error?.message||'主快照不存在')
  const original=read.data,result=prepare(original.data,original.meta),ids=new Set(result.removed.keys())
  if(!write||!ids.size)return {...result.report,dryRun:!write}
  const live=await cloud.database.from('live_scores').select('data,generated_at').eq('id','latest').maybeSingle()
  if(live.error)throw Error(live.error.message)
  if(live.data?.data?.rows?.some(r=>ids.has(r.id)))await update(cloud.database.from('live_scores'),{
    data:{...live.data.data,rows:live.data.data.rows.filter(r=>!ids.has(r.id))},
  },[['id','latest'],['generated_at',live.data.generated_at]])
  const keys=[...new Set([...result.removed.values()].map(m=>`${m.comp}:tennis-stats:${String(m.date||'').replaceAll('-','')}`))]
  const buckets=keys.length?await cloud.database.from('team_roster').select('id,payload,generated_at,updated_at').in('id',keys):{data:[]}
  if(buckets.error)throw Error(buckets.error.message)
  let cleaned=0
  for(const row of buckets.data||[]) {
    const payload=pruneStats(row.payload,ids)
    if(JSON.stringify(payload)===JSON.stringify(row.payload))continue
    await update(cloud.database.from('team_roster'),{payload},[['id',row.id],['generated_at',row.generated_at],['updated_at',row.updated_at]])
    cleaned++
  }
  // 主快照最后写：发生并发冲突时仍可从旧主快照恢复完整待清理 ID，再次执行。
  await update(cloud.database.from('schedule_cache'),{data:result.rows,meta:result.meta},[
    ['id','latest'],['generated_at',original.generated_at],['meta->>worldsRefreshedAt',original.meta?.worldsRefreshedAt],
    ['meta->tennisEvents->>generatedAt',original.meta?.tennisEvents?.generatedAt],
  ])
  return {...result.report,dryRun:false,statisticsBucketsCleaned:cleaned}
}
if(require.main===module)(async()=>{
  if(process.argv.includes('--bundle'))console.log(JSON.stringify({bundle:bundle()}))
  else console.log(JSON.stringify(await cloudRun(require('@tencent-ai/workbuddy-cloud-sdk').createWorkBuddyCloud(require('../utils/cloud-config')),process.argv.includes('--cloud'))))
})().catch(error=>{console.error(error.message);process.exitCode=1})
module.exports={prepare,pruneStats,update,bundle,cloudRun}
