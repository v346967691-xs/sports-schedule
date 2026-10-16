/** 官方在赛名单与退赛公告。只接受当期官方新闻里明确的退赛主语和分站。 */
const {nameKey}=require('../utils/tennis-names')
const DAY=86400000
const text=html=>String(html||'').replace(/<[^>]*>/g,' ').replace(/&nbsp;|&#160;/g,' ').replace(/&amp;/g,'&').replace(/\s+/g,' ').trim()
const words=value=>text(value).normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase().replace(/[^a-z0-9]+/g,' ').trim()
function newsLinks(html){
  return [...new Set([...String(html).matchAll(/href="(\/news\/\d+\/[a-z0-9-]+)"/g)].map(row=>row[1]))]
    .filter(path=>/to-miss|pulls?-out|withdraw/.test(path)).slice(0,8).map(path=>'https://www.wtatennis.com'+path)
}
function parseWithdrawal(html,source,calendar,players,now=Date.now()){
  const heading=(html.match(/<h1\b[^>]*>([\s\S]*?)<\/h1>/i)||[])[1]
  const publishedAt=(html.match(/"datePublished"\s*:\s*"([^"]+)"/)||[])[1]
  const at=Date.parse(publishedAt)
  if(!heading||!Number.isFinite(at)||at>now+300000||now-at>30*DAY||!/to miss|will miss|pulls? out|withdraw/i.test(text(heading)))return []
  const body=html.slice(html.indexOf('</h1>')+5)
  const paragraph=[...body.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p>/gi)].map(row=>text(row[1]))
    .find(line=>/\b(?:will miss|will not compete|has withdrawn|have withdrawn|withdraws from|pulls out|pulled out)\b/i.test(line))
  if(!paragraph)return []
  const parts=paragraph.split(/\b(?:will miss|will not compete|has withdrawn|have withdrawn|withdraws from|pulls out|pulled out)\b/i)
  const subject=' '+words(parts[0])+' '
  const target=' '+words(parts[1].split(/\bfollowing\b|\bafter\b|\bciting\b|\bbecause\b|\bdue to\b|[.!?]/i)[0])+' '
  const affected=players.filter(player=>{
    const name=words(player.name),reverse=words(player.name.split(/\s+/).reverse().join(' '))
    return subject.includes(' '+name+' ')||subject.includes(' '+reverse+' ')
  })
  // 城市与公告所属分站都必须落在同届日期窗口，不能把新闻提及的上一站算作退赛。
  const events=calendar.filter(event=>event.city&&target.includes(' '+words(event.city)+' ')
    &&at>=Date.parse(event.start)-35*DAY&&at<=Date.parse(event.end)+DAY)
  return events.flatMap(event=>affected.map(player=>({key:nameKey(player.name),name:event.name,start:event.start,end:event.end,
    source,publishedAt,checkedAt:new Date(now).toISOString(),status:'withdrawn'})))
}
async function refresh(payload,previous,now,{readUrl,parseEntries,eventIds}){
  const today=new Date(now+8*3600000).toISOString().slice(0,10)
  const events=payload.calendar.filter(event=>event.end>=today&&Date.parse(event.start)<now+30*DAY)
  let lists=(previous.entryLists||[]).map(list=>({...list,entries:list.entries.map(entry=>({...entry}))}))
  for(const event of events){
    const id=eventIds[String(event.city).toLowerCase()]
    if(!id)continue
    const source=`https://www.wtatennis.com/tournaments/${id[0]}/${id[1]}/${event.start.slice(0,4)}/player-list`
    try{
      const html=await readUrl(source,false),entries=parseEntries(html)
      if(!entries.length||!html.includes(`data-year="${event.start.slice(0,4)}"`))continue
      lists=lists.filter(list=>!(list.name===event.name&&list.start===event.start)).concat([{name:event.name,start:event.start,
        end:event.end,source,checkedAt:new Date(now).toISOString(),entries,complete:true}])
    }catch(err){console.warn('[tennis-entry] 保留上次名单',event.name,err.message)}
  }
  const updates=new Map((previous.withdrawals||[]).filter(row=>Date.parse(row.end)+30*DAY>=now).map(row=>[`${row.start}|${row.name}|${row.key}`,row]))
  const articles={...(previous.withdrawalArticles||{})}
  try{
    for(const source of newsLinks(await readUrl('https://www.wtatennis.com/news',false))){
      if(articles[source]&&now-Date.parse(articles[source])<6*3600000)continue
      try{
        const html=await readUrl(source,false)
        for(const row of parseWithdrawal(html,source,events,payload.players,now)){
          const key=`${row.start}|${row.name}|${row.key}`,old=updates.get(key)
          if(!old||Date.parse(row.publishedAt)>=Date.parse(old.publishedAt))updates.set(key,row)
        }
        articles[source]=new Date(now).toISOString()
      }catch(err){console.warn('[tennis-entry] 公告暂不可用',source)}
    }
  }catch(err){console.warn('[tennis-entry] 保留上次官方公告',err.message)}
  for(const row of updates.values()){
    let list=lists.find(list=>list.name===row.name&&list.start===row.start)
    if(!list){list={name:row.name,start:row.start,end:row.end,source:row.source,checkedAt:row.checkedAt,entries:[],complete:false};lists.push(list)}
    const old=list.entries.find(entry=>entry.key===row.key)
    list.entries=list.entries.filter(entry=>entry.key!==row.key).concat([{...(old||{}),key:row.key,role:old&&old.role||'main',status:'withdrawn',
      source:row.source,publishedAt:row.publishedAt,reason:'WTA 官方公告确认已退出本站比赛。'}])
  }
  payload.entryLists=lists.filter(list=>Date.parse(list.end||list.start)+30*DAY>=now)
  payload.withdrawals=[...updates.values()]
  payload.withdrawalArticles=Object.fromEntries(Object.entries(articles).filter(([,at])=>now-Date.parse(at)<30*DAY))
  payload.entryCheckedAt=new Date(now).toISOString()
}
module.exports={newsLinks,parseWithdrawal,refresh}
