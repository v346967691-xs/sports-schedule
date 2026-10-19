/** 复用已请求的 ESPN scoreboard 字段；不额外请求逐场 summary。 */
const number=v=>v!==null&&v!==undefined&&v!==''&&Number.isFinite(Number(v))?Number(v):null
function roundOf(raw) {
  const text=String(raw || '')
  if(/(?:conference|East|West)\s+finals?\b/i.test(text))return {roundOrder:7,roundLabel:'分区决赛'}
  if(/semi.?final/i.test(text))return {roundOrder:6,roundLabel:'半决赛'}
  if(/quarter.?final/i.test(text))return {roundOrder:5,roundLabel:'四分之一决赛'}
  if(/round.of.16|1\/8|last.16/i.test(text))return {roundOrder:4,roundLabel:'16强赛'}
  if(/round.of.32|last.32/i.test(text))return {roundOrder:3,roundLabel:'32强赛'}
  if(/(?:^|\b)(?:nba.)?finals?\b/i.test(text))return {roundOrder:8,roundLabel:'决赛'}
  if(/1st.round|first.round/i.test(text))return {roundOrder:4,roundLabel:'首轮'}
  return {}
}
function espn(event,competition,comp,source) {
  const c=competition || {},s=c.series || {},season=event.season || {}
  const note=(c.notes || []).map(n=>n.headline || n.text || '').join(' · ')
  const rawRound=c.round?.displayName || s.title || season.slug || ''
  const round=roundOf([rawRound,note].join(' '))
  const eventKey=`${source || comp.espn || comp.key}:${season.year || String(event.date || c.date || '').slice(0,4)}`
  const sides=c.competitors || [],ids=sides.map(t=>String(t.id || t.team?.id || '')).sort()
  const phase=round.roundLabel || (/league.phase/i.test(season.slug || '')?'联赛阶段':/group/i.test(season.slug || '')?'小组赛':/play.in/i.test(season.slug || '')?'附加赛':'')
  const f={}
  if(phase){f.phase=phase;f.event=eventKey;Object.assign(f,round)}
  if(comp.sport==='soccer'&&s.totalCompetitions===2){
    Object.assign(f,{event:eventKey,type:'two-leg',tie:String(s.id || ids.join(':')),phase:phase || s.title || '两回合淘汰赛',total:2})
    const leg=number(c.leg?.value ?? c.leg?.number ?? c.leg)
    const noteLeg=note.match(/\b([12])(?:st|nd)?\s*leg/i)
    if(leg===1||leg===2)f.leg=leg;else if(noteLeg)f.leg=Number(noteLeg[1])
    const win=(s.competitors || []).filter(t=>t.winner===true)
    if(s.completed&&win.length===1)f.winnerId=String(win[0].id)
    if(sides.length===2&&sides.every(t=>number(t.shootoutScore)!==null))f.penalties=sides.map(t=>number(t.shootoutScore))
  } else if(comp.sport==='basketball'&&s.type==='playoff'&&s.totalCompetitions>1){
    const region=/\bEast\b/i.test(note)?'东部':/\bWest\b/i.test(note)?'西部':''
    Object.assign(f,{event:eventKey,type:'series',tie:String(s.id || ids.join(':')),phase:[region,phase || '季后赛'].filter(Boolean).join(' · '),
      total:s.totalCompetitions,completed:s.completed===true,wins:Object.fromEntries((s.competitors || []).map(t=>[String(t.id),number(t.wins)]))})
    if(round.roundLabel==='首轮')f.roundOrder=5
    if(region)f.roundLabel=[region,round.roundLabel].filter(Boolean).join(' · ')
    const game=note.match(/\bGame\s*(\d+)/i);if(game)f.game=Number(game[1])
    const win=(s.competitors || []).filter(t=>t.winner===true || s.completed&&number(t.wins)>=Math.floor(s.totalCompetitions/2)+1)
    if(s.completed&&win.length===1)f.winnerId=String(win[0].id)
  } else if(comp.sport==='basketball'&&/play.in/i.test(season.slug || '')){
    Object.assign(f,{event:eventKey,phase:'附加赛',type:'path'})
    if(/7th.Place.vs.8th.Place/i.test(note))f.route='胜者获得第7种子；负者继续争夺第8种子'
    if(/9th.Place.vs.10th.Place/i.test(note))f.route='胜者继续争夺第8种子；负者淘汰'
  }
  return Object.keys(f).length?f:null
}
module.exports={espn,roundOf}
