/** 只展示已匹配到双方选手的统计；缺值与真实的零严格区分。 */
const ORDER=['ACE','双误','制胜分','非受迫性失误','一发成功率','一发得分率','二发得分率','破发点兑现率','破发点挽救率','保发率','发球得分率','接发得分率','接一发得分率','接二发得分率','网前得分率','发球局数','总得分','最快一发速度','平均一发速度','平均二发速度']
function build(payload,match) {
  if(!payload||payload.v!==1||payload.h!==String(match.home.id)||payload.a!==String(match.away.id))return null
  const sections=(payload.sections||[]).map(s=>({key:s.n,label:s.n===0?'全场':`第${s.n}盘`,duration:s.duration||'',rows:(s.rows||[])
    .filter(r=>Array.isArray(r)&&r.length===3&&(r[1]!==null||r[2]!==null))
    .map(r=>({label:r[0],home:r[1]===null?'—':String(r[1]),away:r[2]===null?'—':String(r[2])})).sort((a,b)=>(ORDER.indexOf(a.label)<0?99:ORDER.indexOf(a.label))-(ORDER.indexOf(b.label)<0?99:ORDER.indexOf(b.label)))})).filter(s=>s.rows.length)
  if(!sections.length)return null
  const at=Date.parse(payload.ts)
  return {sections,source:payload.source||'网球统计',complete:!!payload.complete,
    updated:Number.isFinite(at)?new Date(at+8*3600000).toISOString().replace('T',' ').slice(0,16)+' 北京时间':'时间待确认'}
}
module.exports={build}
