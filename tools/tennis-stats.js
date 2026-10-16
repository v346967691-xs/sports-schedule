/** WTA 官方单场统计增强。只写独立公共日桶，不改赛程、比分或其他赛事详情。 */
const { nameKey } = require('../utils/tennis-names')
const { decodeSnapshot } = require('../utils/snapshot')
const archive = require('../utils/tennis-event')
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
        row('发球局数',s=>value('servgamesplayed',s)),row('总得分',s=>value('totptswon',s)),
      ].filter(r=>r[1] !== null || r[2] !== null)
      return rows.length ? { n:r.setnum, rows } : null
    }).filter(Boolean).sort((a,b)=>a.n-b.n)
  if (!sections.length || new Set(sections.map(s=>s.n)).size !== sections.length) return null
  return { v:1,h:String(match.home.id),a:String(match.away.id),ts:new Date(now).toISOString(),
    sourceAt:official.LastUpdated || '',complete:official.MatchState === 'F',
    source:'WTA 官方',url:`https://www.wtatennis.com/tournaments/${official.EventID}/event/${official.EventYear}/scores/${official.MatchID}`,sections }
}
async function main(cloud, options = {}) {
  const now = options.now ?? Date.now(), request = options.read || read
  if (!cloud) cloud = require('@tencent-ai/workbuddy-cloud-sdk').createWorkBuddyCloud(require('../utils/cloud-config'))
  let rows = options.matches
  if (!rows) {
    rows = decodeSnapshot(require('../data/matches'))
    try { rows = archive.mergeRows(rows,archive.archiveRows(require('../data/tennis-events'))) } catch (_) { /* 首次归档未生成 */ }
    // Actions 的 checkout 快照可能已旧；只读云端网球归档的 WTA 分区，不下载整张赛程。
    const fields=['version','events','teams','rounds','venues'].map(k=>`${k}:meta->tennisEvents->${k}`)
      .concat('wta:meta->tennisEvents->matches->wta').join(',')
    const current=await cloud.database.from('schedule_cache').select(fields).eq('id','latest').maybeSingle()
    if(current.error)console.warn('[tennis-stats] 最新分站归档暂不可用，保留本地赛程',current.error.message)
    else if(current.data?.version===3 && Array.isArray(current.data.wta)){
      rows=archive.mergeRows(rows,archive.archiveRows({...current.data,matches:{wta:current.data.wta}}))
    }
  }
  rows = rows.filter(m=>m.comp==='wta' && ['live','finished','upcoming'].includes(m.status) && Date.parse(m.start)<=now+3*3600000 && Date.parse(m.start)>=now-30*DAY)
  if (!rows.length) return {matches:0,writes:0}
  const keys=[...new Set(rows.map(m=>'wta:tennis-stats:'+dayKey(m.start)))]
  const old=await cloud.database.from('team_roster').select('id,payload').in('id',keys)
  if(old.error)throw Error(old.error.message || '统计缓存读取失败')
  const buckets=new Map((old.data||[]).map(row=>[row.id,row.payload])), changed=new Set()
  const due=rows.filter(m=>{
    const bucket=buckets.get('wta:tennis-stats:'+dayKey(m.start)),p=bucket?.matches?.[m.id]
    const wait=m.status==='live'||now-Date.parse(m.start)<2*DAY?10*60000:6*3600000
    if(now-Date.parse(bucket?.attempts?.[m.id]||'')<wait)return false
    return !p || p.h!==String(m.home.id)||p.a!==String(m.away.id)
      || (!p.complete && now-Date.parse(p.ts)>wait) || (p.complete && now-Date.parse(p.ts)>6*3600000 && now-Date.parse(m.start)<2*DAY)
  })
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
        bucket.matches[m.id]=p;buckets.set(key,bucket);changed.add(key);fetched++
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
if(require.main===module)main().then(result=>console.log(JSON.stringify(result))).catch(e=>{console.error(e.message);process.exitCode=1})
module.exports={findEvent,findMatch,normalize,main,dayKey}
