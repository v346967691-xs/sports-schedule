/** 只展示已匹配到双方选手的统计；缺值与真实的零严格区分。 */
function build(payload,match) {
  if(!payload||payload.v!==1||payload.h!==String(match.home.id)||payload.a!==String(match.away.id))return null
  const sections=(payload.sections||[]).map(s=>({key:s.n,label:s.n===0?'全场':`第${s.n}盘`,rows:(s.rows||[])
    .filter(r=>Array.isArray(r)&&r.length===3&&(r[1]!==null||r[2]!==null))
    .map(r=>({label:r[0],home:r[1]===null?'—':String(r[1]),away:r[2]===null?'—':String(r[2])}))})).filter(s=>s.rows.length)
  if(!sections.length)return null
  const at=Date.parse(payload.ts)
  return {sections,source:payload.source||'WTA 官方',complete:!!payload.complete,
    updated:Number.isFinite(at)?new Date(at+8*3600000).toISOString().replace('T',' ').slice(0,16)+' 北京时间':'时间待确认'}
}
module.exports={build}
