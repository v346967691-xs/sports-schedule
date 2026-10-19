/** ATP/WTA 单场统计：WTA 官方优先，Live-tennis 提供 ATP 与 WTA 补缺。 */
const { nameKey } = require('../utils/tennis-names')
const { decodeSnapshot } = require('../utils/snapshot')
const archive = require('../utils/tennis-event')
const relay = require('./live-tennis-stats')
const cadence = require('../utils/tennis-refresh')
const DAY = 86400000
const API = 'https://api.wtatennis.com/tennis'
const textKey = s => nameKey(String(s || '')).replace(/[^a-z0-9]/g, '')
const dayKey = iso => new Date(Date.parse(iso) + 8 * 3600000).toISOString().slice(0,10).replace(/-/g,'')
async function read(url) {
  const r = await fetch(url, { signal: AbortSignal.timeout(12000), headers:{'User-Agent':'sports-schedule/1.0 (public tennis statistics)'} })
  if (!r.ok) throw Error(`HTTP ${r.status}`)
  return r.json()
}
function findEvent(match, events) {
  const title = textKey(String(match.stage || '').split('·').slice(0,1).join(''))
  const city = textKey(String(match.venue || '').split(',')[0])
  const day = String(match.start || '').slice(0,10)
  const candidates = events.filter(e => e.year === Number(day.slice(0,4)) && e.startDate && e.endDate
    && day >= e.startDate && day <= e.endDate && /WTA|Grand Slam|Finals/i.test(e.level || e.tournamentGroup?.level || ''))
  const named = candidates.filter(e => [e.title?.split(' - ')[0],e.tournamentGroup?.name].some(n => n && textKey(n) === title))
  if (named.length === 1) return named[0]
  const cities = candidates.filter(e => city && textKey(e.city) === city)
  return cities.length === 1 ? cities[0] : null
}
function findMatch(match, rows) {
  const home = textKey(match.home.name), away = textKey(match.away.name)
  if (!home || !away || home === away) return null
  const candidates = rows.filter(r => r.DrawMatchType === 'S' && r.DrawLevelType === 'M').map(row => {
    const a = textKey(`${row.PlayerNameFirstA || ''} ${row.PlayerNameLastA || ''}`)
    const b = textKey(`${row.PlayerNameFirstB || ''} ${row.PlayerNameLastB || ''}`)
    return { row, flip: home === b && away === a, exact: home === a && away === b || home === b && away === a }
  }).filter(r => r.exact)
  if (candidates.length === 1) return candidates[0]
  const dated = candidates.filter(r => Math.abs(Date.parse(r.row.MatchTimeStamp) - Date.parse(match.start)) < DAY)
  return dated.length === 1 ? dated[0] : null
}
const count = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null
function normalize(raw, match, official, flip, now = Date.now()) {
  const sub = (a,b) => a !== null && b !== null && a >= b ? a-b : null
  const fraction = (a,b) => a !== null && b !== null && b > 0 && a <= b ? `${Math.round(a/b*100)}%\n${a}/${b}` : null
  const sections = (Array.isArray(raw) ? raw : []).filter(r => Number.isInteger(r.setnum) && r.setnum >= 0 && r.setnum <= 5
    && String(r.eventid) === String(official.EventID) && r.eventyear === official.EventYear && r.matchid === official.MatchID)
    .map(r => {
      const value = (key,side) => count(r[key + side])
      // 官方无比赛数据的占位响应不能变成一整页虚构的零。
      if (!['totservplayed','totptswon','aces'].some(k => (value(k,'a') || 0) + (value(k,'b') || 0) > 0)) return null
      const row = (label,fn) => [label,fn(flip?'b':'a'),fn(flip?'a':'b')]
      const rows = [
        row('ACE',s=>value('aces',s)),row('双误',s=>value('dblflt',s)),
        row('一发成功率',s=>fraction(value('ptsplayed1stserv',s),value('totservplayed',s))),
        row('一发得分率',s=>fraction(value('ptswon1stserv',s),value('ptsplayed1stserv',s))),
        row('二发得分率',s=>fraction(sub(value('ptstotwonserv',s),value('ptswon1stserv',s)),sub(value('totservplayed',s),value('ptsplayed1stserv',s)))),
        row('破发点兑现率',s=>fraction(value('breakptsconv',s),value('breakptsplayed',s))),
        row('破发点挽救率',s=>{const other=s==='a'?'b':'a';return fraction(sub(value('breakptsplayed',other),value('breakptsconv',other)),value('breakptsplayed',other))}),
        row('发球得分率',s=>fraction(value('ptstotwonserv',s),value('totservplayed',s))),
        row('接发得分率',s=>{const other=s==='a'?'b':'a';return fraction(sub(value('totservplayed',other),value('ptstotwonserv',other)),value('totservplayed',other))}),
        row('接一发得分率',s=>{const o=s==='a'?'b':'a';return fraction(sub(value('ptsplayed1stserv',o),value('ptswon1stserv',o)),value('ptsplayed1stserv',o))}),
        row('接二发得分率',s=>{const o=s==='a'?'b':'a';return fraction(sub(sub(value('totservplayed',o),value('ptsplayed1stserv',o)),sub(value('ptstotwonserv',o),value('ptswon1stserv',o))),sub(value('totservplayed',o),value('ptsplayed1stserv',o)))}),
        row('保发率',s=>{const o=s==='a'?'b':'a';return fraction(sub(value('servgamesplayed',s),value('breakptsconv',o)),value('servgamesplayed',s))}),
        row('发球局数',s=>value('servgamesplayed',s)),row('总得分',s=>value('totptswon',s)),
      ].filter(r=>r[1] !== null || r[2] !== null)
      return rows.length ? { n:r.setnum, rows } : null
    }).filter(Boolean).sort((a,b)=>a.n-b.n)
  if (!sections.length || new Set(sections.map(s=>s.n)).size !== sections.length) return null
  return { v:1,h:String(match.home.id),a:String(match.away.id),ts:new Date(now).toISOString(),
    sourceAt:official.LastUpdated || '',complete:official.MatchState === 'F',
    provider:'wta',schema:2,source:'WTA 官方',url:`https://www.wtatennis.com/tournaments/${official.EventID}/event/${official.EventYear}/scores/${official.MatchID}`,sections }
}
/** 同场统计短暂缺盘/缺项时保留最后有效值，并明确标为尚未补齐。 */
function mergeStats(previous, next) {
  if(!previous || previous.h!==next.h || previous.a!==next.a)return next
  if(previous.complete && !next.complete)return previous
  let retained=false
  const sections=new Map((next.sections||[]).map(s=>[s.n,{...s,rows:s.rows.map(r=>r.slice())}]))
  for(const old of previous.sections||[]){
    const section=sections.get(old.n)
    if(!section){sections.set(old.n,old);retained=true;continue}
    for(const row of old.rows){
      const current=section.rows.find(r=>r[0]===row[0])
      if(!current){section.rows.push(row.slice());retained=true;continue}
      for(const side of [1,2])if(current[side]===null && row[side]!==null){current[side]=row[side];retained=true}
    }
  }
  if(previous.complete && retained)return previous
  const source=retained && previous.source!==next.source ? [...new Set([next.source,previous.source].flatMap(s=>String(s||'').split(' + ')).filter(Boolean))].join(' + ') : next.source
  return {...next,source,sections:[...sections.values()].sort((a,b)=>a.n-b.n),complete:next.complete && !retained}
}
async function collectOfficial(cloud, options = {}) {
  const now = options.now ?? Date.now(), request = options.read || read
  if (!cloud) cloud = require('@tencent-ai/workbuddy-cloud-sdk').createWorkBuddyCloud(require('../utils/cloud-config'))
  let rows = options.matches || []
  rows = rows.filter(m=>m.comp==='wta' && ['live','finished','upcoming'].includes(m.status) && Date.parse(m.start)<=now+3*3600000 && Date.parse(m.start)>=now-30*DAY)
  if (!rows.length) return {matches:0,writes:0}
  const keys=[...new Set(rows.map(m=>'wta:tennis-stats:'+dayKey(m.start)))]
  const old=await cloud.database.from('team_roster').select('id,payload').in('id',keys)
  if(old.error)throw Error(old.error.message || '统计缓存读取失败')
  const buckets=new Map((old.data||[]).map(row=>[row.id,row.payload])), changed=new Set()
  const due=rows.filter(m=>{
    const bucket=buckets.get('wta:tennis-stats:'+dayKey(m.start)),p=bucket?.matches?.[m.id]
    const wait=m.status==='live'||now-Date.parse(m.start)<2*DAY?cadence.LIVE_STATS_MS:6*3600000
    if(!options.force&&now-Date.parse(bucket?.attempts?.[m.id]||'')<wait)return false
    if(options.force)return true
    return !p || p.provider==='live-tennis' || p.schema!==2 || p.h!==String(m.home.id)||p.a!==String(m.away.id)
      || (!p.complete && now-Date.parse(p.ts)>=wait) || (p.complete && now-Date.parse(p.ts)>=cadence.FINAL_STATS_MS && now-Date.parse(m.start)<2*DAY)
  }).sort((a,b)=>(a.status==='live'?0:1)-(b.status==='live'?0:1)||Date.parse(b.start)-Date.parse(a.start)).slice(0,options.maxOfficialMatches??40)
  if(!due.length)return {matches:rows.length,fetched:0,writes:0}
  const from=new Date(now-31*DAY).toISOString().slice(0,10),to=new Date(now+DAY).toISOString().slice(0,10)
  const calendar=await request(`${API}/tournaments/?from=${from}&to=${to}&pageSize=100`)
  const events=(calendar.content||[]), eventLists=new Map(), pending=[]
  for(const m of due){
    const event=findEvent(m,events);if(!event)continue
    const id=String(event.tournamentGroup.id)+'/'+event.year
    if(!eventLists.has(id)){
      try{eventLists.set(id,await request(`${API}/tournaments/${id}/matches`))}catch(e){console.warn('[tennis-stats] 分站读取失败',id,e.message);eventLists.set(id,null)}
    }
    const found=findMatch(m,eventLists.get(id)?.matches||[])
    if(found && ['F','P'].includes(found.row.MatchState) && String(found.row.EventID)===String(event.tournamentGroup.id) && found.row.EventYear===event.year)pending.push({m,found,id})
  }
  let cursor=0,fetched=0,failed=0
  await Promise.all(Array.from({length:Math.min(3,pending.length)},async()=>{
    while(cursor<pending.length){const {m,found,id}=pending[cursor++]
      try{
        const raw=await request(`${API}/tournaments/${id}/matches/${found.row.MatchID}/stats`)
        const p=normalize(raw,m,found.row,found.flip,now);if(!p)continue
        const key='wta:tennis-stats:'+dayKey(m.start),bucket=buckets.get(key)||{v:1,matches:{}}
        bucket.matches[m.id]=mergeStats(bucket.matches[m.id],p);buckets.set(key,bucket);changed.add(key);fetched++
      }catch(e){failed++;console.warn('[tennis-stats] 单场统计暂不可用',m.id,e.message)}
    }
  }))
  for(const m of due){
    const id='wta:tennis-stats:'+dayKey(m.start),bucket=buckets.get(id)||{v:1,matches:{}}
    bucket.attempts={...bucket.attempts,[m.id]:new Date(now).toISOString()};buckets.set(id,bucket);changed.add(id)
  }
  for(const id of changed){const out=await cloud.database.from('team_roster').upsert({id,comp:'wta',team_id:id.slice(4),payload:buckets.get(id),generated_at:new Date(now).toISOString(),updated_at:new Date(now).toISOString()},{onConflict:'id'});if(out.error)throw Error(out.error.message || '统计缓存写入失败')}
  return {matches:rows.length,matched:pending.length,fetched,failed,writes:changed.size}
}
async function loadMatches(cloud) {
  let rows = null
  if (!rows) {
    rows = decodeSnapshot(require('../data/matches'))
    try { rows = archive.mergeRows(rows,archive.archiveRows(require('../data/tennis-events'))) } catch (_) { /* 首次归档未生成 */ }
    // 同时读取 ATP/WTA 独立归档，避免 checkout 赛程陈旧。
    const fields=['version','events','teams','rounds','venues'].map(k=>`${k}:meta->tennisEvents->${k}`)
      .concat('atp:meta->tennisEvents->matches->atp','wta:meta->tennisEvents->matches->wta').join(',')
    const current=await cloud.database.from('schedule_cache').select(fields).eq('id','latest').maybeSingle()
    if(current.error)console.warn('[tennis-stats] 最新分站归档暂不可用，保留本地赛程',current.error.message)
    else if(current.data?.version===3 && (Array.isArray(current.data.wta)||Array.isArray(current.data.atp))){
      rows=archive.mergeRows(rows,archive.archiveRows({...current.data,matches:{atp:current.data.atp||[],wta:current.data.wta||[]}}))
    }
  }
  return rows
}
const bucketKey = m => `${m.comp}:tennis-stats:${dayKey(m.start)}`
function hasCore(p) {
  const rows=p?.sections?.find(s=>s.n===0)?.rows||[]
  return ['ACE','双误','总得分'].every(label=>{const r=rows.find(r=>r[0]===label);return r&&r[1]!=null&&r[2]!=null})
}
/** 官方已有值优先；补充源只填空，不把较少字段的页面覆盖到官方统计上。 */
function supplement(primary,secondary) {
  const sections=primary.sections.map(s=>({...s,rows:s.rows.map(r=>r.slice())}))
  let added=false
  for(const s of secondary.sections){
    let target=sections.find(p=>p.n===s.n)
    if(!target){sections.push(s);added=true;continue}
    for(const row of s.rows){
      const old=target.rows.find(r=>r[0]===row[0])
      if(!old){target.rows.push(row.slice());added=true;continue}
      for(const side of [1,2])if(old[side]===null&&row[side]!==null){old[side]=row[side];added=true}
    }
  }
  return added?{...primary,ts:secondary.ts,source:'WTA 官方 + Live-tennis',sections:sections.sort((a,b)=>a.n-b.n),complete:primary.complete&&secondary.complete}:primary
}
async function collectRelay(cloud, options) {
  const now=options.now, rows=options.matches, request=options.readHtml || relay.read
  if(!rows.length)return {matches:0,fetched:0,writes:0}
  const keys=[...new Set(rows.map(bucketKey))]
  const old=await cloud.database.from('team_roster').select('id,payload').in('id',keys)
  if(old.error)throw Error(old.error.message || '统计缓存读取失败')
  const buckets=new Map((old.data||[]).map(row=>[row.id,row.payload])),changed=new Set()
  const due=rows.filter(m=>{
    const bucket=buckets.get(bucketKey(m)),p=bucket?.matches?.[m.id]
    const wait=m.status==='live'||now-Date.parse(m.start)<2*DAY?cadence.LIVE_STATS_MS:6*3600000
    if(!options.force&&now-Date.parse(bucket?.relayAttempts?.[m.id]||'')<wait)return false
    const same=p&&p.h===String(m.home.id)&&p.a===String(m.away.id)
    // WTA 已有新鲜官方统计时，不额外请求第三方，更不把官方数据换成少字段版本。
    if(m.comp==='wta'&&same&&(p.provider==='wta'||p.source==='WTA 官方')&&(p.complete||now-Date.parse(p.ts)<wait)&&hasCore(p))return false
    if(m.comp==='wta'&&same&&!hasCore(p))return true
    if(options.force)return true
    return !same||!p.complete&&now-Date.parse(p.ts)>=wait
      ||p.complete&&now-Date.parse(p.ts)>=cadence.FINAL_STATS_MS&&now-Date.parse(m.start)<2*DAY
  }).sort((a,b)=>(a.status==='live'?0:1)-(b.status==='live'?0:1)||Date.parse(b.start)-Date.parse(a.start))
    .slice(0,options.maxRelayMatches??40)
  if(!due.length)return {matches:rows.length,fetched:0,writes:0}
  const pages=new Map()
  async function entries(date) {
    if(!pages.has(date))pages.set(date,request(relay.BASE+'/zh/result/'+date).then(html=>relay.parseSchedule(html,date)))
    return pages.get(date)
  }
  const deadline=Date.now()+(options.budgetMs??90000)
  let cursor=0,fetched=0,matched=0,failed=0
  await Promise.all(Array.from({length:Math.min(2,due.length)},async()=>{
    while(cursor<due.length){
      if(Date.now()>=deadline)break
      const m=due[cursor++],key=bucketKey(m)
      try{
        const date=m.date||new Date(Date.parse(m.start)+8*3600000).toISOString().slice(0,10)
        const found=relay.findMatch(m,await entries(date))
        if(found&&[1,2].includes(found.entry.status)){
          matched++
          const p=relay.normalize(await request(relay.queryUrl(found.entry)),m,found,now)
          if(p){
            const bucket=buckets.get(key)||{v:1,matches:{}},previous=bucket.matches[m.id]
            const primary=previous&&previous.h===p.h&&previous.a===p.a&&(previous.provider==='wta'||previous.source==='WTA 官方')
              &&(previous.complete||now-Date.parse(previous.ts)<10*60000)
            bucket.matches[m.id]=primary?supplement(previous,p):mergeStats(previous,p)
            buckets.set(key,bucket);fetched++
          }
        }
      }catch(e){failed++;console.warn('[tennis-stats] Live-tennis 暂不可用',m.id,e.message)}
      const bucket=buckets.get(key)||{v:1,matches:{}}
      bucket.relayAttempts={...bucket.relayAttempts,[m.id]:new Date(now).toISOString()};buckets.set(key,bucket);changed.add(key)
    }
  }))
  for(const id of changed){
    const comp=id.split(':')[0]
    const out=await cloud.database.from('team_roster').upsert({id,comp,team_id:id.slice(comp.length+1),payload:buckets.get(id),generated_at:new Date(now).toISOString(),updated_at:new Date(now).toISOString()},{onConflict:'id'})
    if(out.error)throw Error(out.error.message || '统计缓存写入失败')
  }
  return {matches:rows.length,matched,fetched,failed,writes:changed.size}
}
async function main(cloud, options = {}) {
  if(!cloud)cloud=require('@tencent-ai/workbuddy-cloud-sdk').createWorkBuddyCloud(require('../utils/cloud-config'))
  const now=options.now??Date.now()
  const rows=(options.matches||await loadMatches(cloud)).filter(m=>['atp','wta'].includes(m.comp)
    &&require('../utils/tennis-scope').allows(m)
    &&['live','finished','upcoming'].includes(m.status)&&Date.parse(m.start)<=now+3*3600000&&Date.parse(m.start)>=now-30*DAY)
    .filter(m=>m.home?.name&&m.away?.name&&!/^(?:TBD|待定)$/i.test(m.home.name)&&!/^(?:TBD|待定)$/i.test(m.away.name))
  if(!rows.length)return {matches:0,writes:0}
  let official={matches:0,fetched:0,writes:0}
  try{official=await collectOfficial(cloud,{...options,now,matches:rows.filter(m=>m.comp==='wta')})}
  catch(e){if(options.relay===false)throw e;console.warn('[tennis-stats] WTA 官方暂不可用，尝试补缺来源',e.message);official.error=e.message}
  const fallback=options.relay===false?{fetched:0,writes:0}:await collectRelay(cloud,{...options,now,matches:rows})
  return {matches:rows.length,matched:(official.matched||0)+(fallback.matched||0),fetched:(official.fetched||0)+(fallback.fetched||0),
    failed:(official.failed||0)+(fallback.failed||0),writes:official.writes+fallback.writes,sources:{official,liveTennis:fallback}}
}
if(require.main===module)main().then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error(e.message);process.exitCode=1})
module.exports={findEvent,findMatch,normalize,mergeStats,main,collectRelay,dayKey,hasCore}
