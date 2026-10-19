/** 特殊赛制视图：复用缓存，不从滚动赛程累加积分榜，不按日期猜签位。 */
const tree = require('./tournament-bracket')
const legacy = require('./bracket')
const board = require('./elimination-board')
const view = require('./view')
const valid = id => !!id && !/^(TBD|待定|0)$/i.test(String(id))
const meta = m => m.format || {}
const label = m => String(meta(m).phase || m.stage || '')
const name = t => valid(t && t.id) ? view.nameOf(t) : '待定'
const num = n => typeof n === 'number' && Number.isFinite(n) ? n : null
function result(m) {
  if (m.status !== 'finished') return ''
  if (valid(m.winnerId) && [m.home,m.away].some(t => String(t.id) === String(m.winnerId))) return String(m.winnerId)
  const a=num(m.home.score),b=num(m.away.score)
  return a!==null && b!==null && a!==b && (!m.bo || Math.max(a,b)>=Math.floor(m.bo/2)+1) ? String(a>b?m.home.id:m.away.id) : ''
}
function card(m) {
  const f=meta(m), winner=result(m)
  return {id:m.id,title:f.roundLabel || view.roundLabel(m.stage,'') || '对阵',home:name(m.home),away:name(m.away),
    homeScore:num(m.home.score),awayScore:num(m.away.score),hasScore:num(m.home.score)!==null && num(m.away.score)!==null,
    homeWin:winner===String(m.home.id),awayWin:winner===String(m.away.id),status:m.status,
    time:`${m.date || String(m.start || '').slice(0,10)} ${m.time || ''}`.trim(),
    statusText:m.status==='finished'?'已结束':m.status==='live'?'进行中':m.statusText || '未开始',
    tag:f.leg ? `第${f.leg}回合` : f.game ? `第${f.game}场` : m.bo ? `BO${m.bo}` : '',route:f.route || ''}
}
function entry(m, round, scores) {
  return {id:m.id,matchIds:[m.id],round,sides:[m.home,m.away].map((t,i)=>({id:String(t.id || ''),name:name(t),score:scores?scores[i]:num(t.score)})),
    winnerId:result(m),status:m.status,statusText:m.statusText || '已结束',start:m.start,timeLabel:card(m).time}
}
function branchOf(m) {
  const f=meta(m),s=label(m).replace(/^全球总决赛\s*·\s*/,'').trim()
  if (/^(upper|lower|final)$/.test(f.branch)) return f.branch
  if (/败者|loser|lower/i.test(s)) return 'lower'
  if (/胜者|winner.*bracket|upper/i.test(s)) return 'upper'
  if (/(?:^|·)\s*总决赛\s*$|grand.?final/i.test(s)) return 'final'
  return ''
}
function branchRound(m, fallback) {
  const f=meta(m),s=label(m),r=s.match(/(?:round|第)\s*(\d+)\s*轮?/i)
  if(Number.isFinite(f.roundOrder))return {order:f.roundOrder,label:f.roundLabel || `第${f.roundOrder}轮`}
  if(r)return {order:Number(r[1]),label:`第${r[1]}轮`}
  if(/决赛|final/i.test(s))return {order:100,label:branchOf(m)==='final'?'总决赛':'组内决赛'}
  return {order:fallback,label:'已公布对阵'}
}
/** 仅已完赛的完整8队14场标准双败可按逐场结果重建；不接受裁剪窗口或矛盾记录。 */
function completeDouble(matches) {
  if(matches.length!==14 || matches.some(m=>!result(m)))return null
  const list=matches.slice().sort((a,b)=>String(a.start).localeCompare(String(b.start)))
  const ids=list.slice(0,4).flatMap(m=>[String(m.home.id),String(m.away.id)])
  if(ids.length!==new Set(ids).size || ids.some(id=>!valid(id)))return null
  const losses=new Map(ids.map(id=>[id,0])),rounds=new Map(),mapped=[]
  for(const m of list) {
    const a=String(m.home.id),b=String(m.away.id),la=losses.get(a),lb=losses.get(b)
    if(la===undefined || lb===undefined || la>1 || lb>1)return null
    const branch=la===0&&lb===0?'upper':la===1&&lb===1?'lower':'final'
    if(branch==='final' && m!==list[list.length-1])return null
    const order=Math.max(rounds.get(branch+':'+a)||0,rounds.get(branch+':'+b)||0)+1
    rounds.set(branch+':'+a,order);rounds.set(branch+':'+b,order)
    mapped.push({...m,format:{...meta(m),branch,roundOrder:order,roundLabel:branch==='final'?'总决赛':`第${order}轮`}})
    const loser=result(m)===a?b:a;losses.set(loser,losses.get(loser)+1)
  }
  if(mapped.filter(m=>meta(m).branch==='upper').length!==7 || mapped.filter(m=>meta(m).branch==='lower').length!==6 || mapped.filter(m=>meta(m).branch==='final').length!==1)return null
  return mapped
}
function doubleTabs(matches, scope) {
  const keys={upper:'胜者组',lower:'败者组',final:'总决赛'}
  // 显式标签优先；MSI历史主赛段只有完整校验通过才归组，不把所有“淘汰赛”当成双败。
  const explicit=matches.some(m=>branchOf(m))
  const mapped=explicit?matches:scope==='msi'?completeDouble(matches):null
  if(!mapped)return []
  const tabs=Object.entries(keys).map(([key,title])=>{
    const list=mapped.filter(m=>branchOf(m)===key)
    const entries=list.map(m=>entry(m,branchRound(m,1)))
    return {key:`double:${key}`,label:title,kind:'board',tree:tree.build(entries),cards:list.map(card),
      note:key==='lower'?'败者组再负一场即淘汰；来源只标注已确认的比赛。':'按已确认的轮次和晋级关系展示。'}
  })
  const known=mapped.filter(m=>branchOf(m)),byId=new Map(known.map(m=>[m.id,m]))
  tabs.forEach(tab=>tab.cards.forEach(c=>{
    const m=byId.get(c.id)
    const arrivals=[]
    for(const side of [m.home,m.away]) {
      const earlier=known.filter(p=>p.id!==m.id && p.start<m.start && [p.home,p.away].some(t=>String(t.id)===String(side.id)) && result(p))
        .sort((a,b)=>b.start.localeCompare(a.start))[0]
      if(earlier && branchOf(m)==='lower' && branchOf(earlier)==='upper' && result(earlier)!==String(side.id))arrivals.push(`${name(side)}：由胜者组落入`)
    }
    c.route=[c.route,...arrivals].filter(Boolean).join('；')
  }))
  const unknown=mapped.filter(m=>!branchOf(m))
  if(unknown.length)tabs.push({key:'double:pending',label:'分组待公布',kind:'cards',cards:unknown.map(card),note:'来源尚未标明胜者组或败者组，暂不归组。'})
  return tabs
}
function seriesCards(matches) {
  const buckets=new Map()
  matches.forEach(m=>{
    const f=meta(m)
    // 只有明确系列赛ID，或同一赛事赛季、轮次、双方身份齐全时，才合并。
    if(!['two-leg','series'].includes(f.type)||!f.tie || !f.event)return
    const key=`${f.event}:${f.phase || m.stage}:${f.tie}`
    const list=buckets.get(key)||[];list.push(m);buckets.set(key,list)
  })
  return [...buckets.entries()].map(([key,list])=>{
    list.sort((a,b)=>String(a.start).localeCompare(String(b.start)))
    // 未来场次的 series 也可能含累计值，按完整性、胜场总数选快照，避免未来空值覆盖赛果。
    const latest=list.slice().sort((a,b)=>Number(meta(b).completed)-Number(meta(a).completed)
      || Object.values(meta(b).wins || {}).reduce((s,n)=>s+(num(n)||0),0)-Object.values(meta(a).wins || {}).reduce((s,n)=>s+(num(n)||0),0)
      || String(b.start).localeCompare(String(a.start)))[0]
    const f=meta(latest),first=list[0],sides=[first.home,first.away],ids=sides.map(s=>String(s.id))
    if(ids.some(id=>!valid(id))||list.some(m=>[m.home,m.away].some(t=>!ids.includes(String(t.id)))))return null
    let scores=[null,null],finished=false,winner=''
    if(f.type==='two-leg'){
      const legs=list.map(m=>meta(m).leg)
      const complete=list.length===2 && legs.includes(1)&&legs.includes(2) && list.every(m=>m.status==='finished'&&num(m.home.score)!==null&&num(m.away.score)!==null)
      if(complete){scores=ids.map(id=>list.reduce((sum,m)=>sum+(String(m.home.id)===id?m.home.score:m.away.score),0));finished=true;winner=f.winnerId || ''}
    }else{
      scores=ids.map(id=>num((f.wins || {})[id]));finished=f.completed===true;winner=f.winnerId || ''
    }
    const totalKnown=scores.every(n=>n!==null)
    const headline=totalKnown?`${scores[0]} – ${scores[1]}`:f.type==='two-leg'?'待汇总':'局分待更新'
    const node={...latest,id:key,home:{...sides[0],score:scores[0]},away:{...sides[1],score:scores[1]},status:finished?'finished':latest.status==='live'?'live':'upcoming',winnerId:winner,bo:f.type==='series'?f.total:null}
    return {key,event:f.event,title:f.roundLabel || f.phase || '系列赛',home:name(sides[0]),away:name(sides[1]),headline,
      caption:f.type==='two-leg'?'两回合总比分':`系列赛局分${f.total?` · BO${f.total}`:''}`,
      note:f.type==='two-leg'&&!totalKnown?'待两回合赛果齐全后汇总；不将单回合比分当总比分。':'',
      penalties:Array.isArray(f.penalties)&&f.penalties.every(n=>num(n)!==null)?`点球 ${ids.map(id=>f.penalties[[latest.home,latest.away].findIndex(t=>String(t.id)===id)]).join(' – ')}`:'',
      games:list.map(card),entry:{...entry(node,{order:f.roundOrder || 1,label:f.roundLabel || '已公布对阵'},scores),winnerId:winner,matchIds:list.map(m=>m.id),summaryLabel:f.type==='two-leg'?'两回合总比分':'系列赛局分'}}
  }).filter(Boolean)
}
function standingsTab(table,matches,cat,comp) {
  if(!table || !(table.groups || []).some(g=>(g.rows || []).length))return null
  const league=['ucl','uel','uecl','wucl','acl'].includes(comp)
  const grouped=table.groups.length>1 && !['nba','mls'].includes(comp)
  if(!league&&!grouped&&!/小组|循环|round.?robin/i.test(table.season || ''))return null
  return {key:'groups',label:league?'联赛阶段':'小组赛',kind:'groups',season:table.season || '',
    note:'排名与出线分区沿用官方积分榜；分区表示资格位置，不代表已锁定晋级。',
    groups:table.groups.map((g,i)=>{
      const rows=(g.rows || []).map((r,j)=>({id:String(r.id),name:r.zh || r.abbr || r.name,pos:r.pos || j+1,
        played:r.played??'—',wins:r.wins??'—',losses:r.losses??'—',points:r.pts??'—',
        zone:r.zone&&r.zone.label || '',zoneColor:r.zone&&r.zone.color || '',zoneBreak:!!r.zone && (j===(g.rows.length-1)||r.zone.label!==(g.rows[j+1].zone || {}).label)}))
      const keys=new Set((g.rows || []).flatMap(r=>[String(r.id),String(r.abbr || '')]).filter(Boolean))
      const games=matches.filter(m=>!(/决赛|final|淘汰|playoff/i.test(label(m))) && [m.home,m.away].every(t=>keys.has(String(t.id))||keys.has(String(t.abbr || '')))).map(card)
      return {key:String(i),name:g.name || (league?'联赛积分榜':'小组积分榜'),rows,games,esports:cat==='esports'}
    })}
}
function seriesTree(series) {
  const entries=series.map(s=>s.entry),edges=[]
  entries.forEach(from=>{
    if(!valid(from.winnerId))return
    const event=series.find(s=>s.entry===from).event
    const targets=entries.filter(to=>to.round.order===from.round.order+1 && to.sides.some(t=>t.id===from.winnerId)
      && series.find(s=>s.entry===to).event===event)
    if(targets.length===1)edges.push({from:from.id,to:targets[0].id})
  })
  return tree.build(entries,{edges})
}
function build(matches, options={}) {
  const list=[...new Map((matches || []).filter(m=>m&&m.home&&m.away&&m.status!=='canceled').map(m=>[m.id,m])).values()]
    .sort((a,b)=>String(a.start).localeCompare(String(b.start)))
  const tabs=[],comp=options.comp || '',cat=options.cat || ''
  const group=standingsTab(options.table,list,cat,comp)
  if(group)tabs.push(group)
  const series=seriesCards(list)
  const eligible=list.filter(m=>!(/瑞士|swiss|小组|循环/i.test(label(m))))
  // 区分入围赛、主赛段及不同赛季；不把它们的败场混在一起。
  const scopes=new Map()
  eligible.forEach(m=>{
    if(!branchOf(m) && meta(m).type!=='double' && !(comp==='msi'&&!/入围|play.in/i.test(label(m))))return
    const f=meta(m),key=(f.event || `${comp}:${String(m.start).slice(0,4)}`)+':'+(f.phaseGroup || (/入围|play.in/i.test(label(m))?'play-in':'main'))
    const rows=scopes.get(key)||[];rows.push(m);scopes.set(key,rows)
  })
  const doubles=[...scopes.values()].flatMap(rows=>doubleTabs(rows,comp))
  // 同一入口只显示最新一个赛事段的双败，避免跨赛季页签键重复。
  if(doubles.length){const latest=[...scopes.values()].reverse().find(rows=>doubleTabs(rows,comp).length);tabs.push(...doubleTabs(latest,comp))}
  const pathways=eligible.filter(m=>!branchOf(m)&&/入围|资格|附加|冒泡|play.in|qualif|play.off/i.test(label(m)) && meta(m).type!=='two-leg' && meta(m).type!=='series')
  if(pathways.length)tabs.push({key:'path',label:'资格与附加赛',kind:'cards',cards:pathways.map(card),note:'按已公布赛程展示资格争夺；未确认的后续去向不连线。'})
  const seriesEvents=[...new Set(series.map(s=>s.event))]
  seriesEvents.forEach(event=>{
    const rows=series.filter(s=>s.event===event),title=rows.every(s=>s.caption==='两回合总比分')?'两回合淘汰赛':'系列赛'
    tabs.push({key:`series:${event}`,label:seriesEvents.length>1?`${event.split(':').pop()} ${title}`:title,kind:'series',series:rows,
      tree:seriesTree(rows),note:'点开对阵查看各场结果；总比分与单场比分分别展示。'})
  })
  const placements=eligible.filter(m=>/季军|三四名|排位|third.place|bronze|placement/i.test(label(m)))
  if(placements.length)tabs.push({key:'placement',label:'季军与排位',kind:'cards',cards:placements.map(card),note:'排位赛独立于争冠路径。'})
  // 有特殊阶段时，把正常单败也收进同一阶段入口；没有特殊阶段则沿用现有页面签表。
  const plain=list.filter(m=>!branchOf(m)&&!meta(m).tie)
  const normal=comp!=='msi'&&board.normalize(legacy.buildBracket(plain,options.compName || ''),comp)
  if(tabs.length&&normal&&normal.nodes.length)tabs.push({key:'knockout',label:'淘汰赛',kind:'board',tree:normal,cards:[],note:''})
  const initial=tabs.find(t=>t.key.startsWith('double:') && /胜者|败者|总决赛/.test(options.stage || '') && t.label===(/败者/.test(options.stage)?'败者组':/胜者/.test(options.stage)?'胜者组':'总决赛'))
    || (/季军|排位|三四/.test(options.stage || '')?tabs.find(t=>t.key==='placement'):null)
    || (/入围|资格|附加/.test(options.stage || '')?tabs.find(t=>t.key==='path'):null)
    || (/决赛|淘汰|final/i.test(options.stage || '')?tabs.find(t=>t.key==='knockout'||t.kind==='series'||t.key==='double:upper'):null)
    || tabs[0]
  return {key:`${comp}:${options.stage || ''}`,tabs,initial:initial?initial.key:'',expanded:!!options.stage,handlesBracket:tabs.some(t=>t.kind==='board'||t.kind==='series'),updatedAt:options.updatedAt || ''}
}
module.exports={build,card,result,branchOf,completeDouble,seriesCards,seriesTree,standingsTab}
