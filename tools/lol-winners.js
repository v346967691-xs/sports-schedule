/** 单局胜方：腾讯官方赛事数据 + Games of Legends 明确赛果；不以击杀/经济猜胜负。 */
const SUPPORTED=new Set(['worlds','lpl','lck','lec','msi','demacia'])
const memo=new Map()
const clean=s=>String(s||'').replace(/<[^>]*>/g,'').replace(/&amp;/g,'&').trim()
const key=s=>clean(s).toLowerCase().replace(/[^a-z0-9]/g,'')
const aliases={mvk:'movistarkoi',mkoi:'movistarkoi',gen:'geng',hle:'hanwhalifeesports',kc:'karminecorp',c9:'cloud9',g2:'g2esports',t1:'t1',dk:'dpluskia',bds:'teambds',vit:'teamvitality',th:'teamheretics',fnc:'fnatic',navi:'natusvincere',sk:'skgaming',blg:'bilibiligaming',ig:'invictusgaming',jdg:'jdgaming',tes:'topesports',al:'anyoneslegend',we:'teamwe',wbg:'weibogaming',lng:'lngesports',fur:'furia'}
const canonical=s=>aliases[key(s)]||key(s)
const same=(name,team)=>[team.id,team.code,team.name].filter(Boolean).some(s=>canonical(s)===canonical(name))
async function request(url,options={}){
  const cacheKey=url+'|'+(options.body||'')
  const old=memo.get(cacheKey)
  if(old&&Date.now()-old.at<5*60000)return old.promise
  const promise=(async()=>{const r=await fetch(url,{...options,signal:AbortSignal.timeout(12000)});if(!r.ok)throw Error(`HTTP ${r.status}`);return r.text()})()
  memo.set(cacheKey,{at:Date.now(),promise})
  try{return await promise}catch(e){memo.delete(cacheKey);throw e}
}
function pair(a,b,home,away){return same(a,home)&&same(b,away)?false:same(a,away)&&same(b,home)?true:null}
function validWinners(rows,m,games){
  if(!rows.length||new Set(rows.map(r=>r.n)).size!==rows.length)return false
  if(rows.some(r=>!Number.isInteger(r.n)||r.n<1||!games.some(g=>g.number===r.n&&g.state==='completed')||!['home','away'].includes(r.winner)))return false
  const h=rows.filter(r=>r.winner==='home').length,a=rows.length-h
  if(m.status==='finished')return rows.length===games.filter(g=>g.state==='completed').length&&h===m.home.score&&a===m.away.score
  return h<=(m.home.score??Infinity)&&a<=(m.away.score??Infinity)
}
function jsonp(text){return JSON.parse(String(text).replace(/^\s*var\s+\w+\s*=\s*/,'').replace(/;\s*$/,''))}
function tencentRows(data,m,games,now=Date.now()){
  const flip=pair(data.teamAName,data.teamBName,m.home,m.away)
  if(flip===null||Math.abs(Date.parse(data.matchTime)-Date.parse(m.start))>2*3600000||!Date.parse(data.matchTime))return []
  const rows=(data.matchInfos||[]).filter(g=>Date.parse(g.matchEndTime)<=now&&g.matchEndTime&&[data.teamAId,data.teamBId].includes(g.matchWin))
    .map(g=>({n:g.bo,winner:(g.matchWin===data.teamAId)!==flip?'home':'away'}))
  return validWinners(rows,m,games)?rows:[]
}
function parseMatchList(html){
  const table=(html.match(/<table\b[^>]*class=['"][^'"]*table_list[^'"]*['"][^>]*>[\s\S]*?<\/table>/i)||[])[0]||''
  return [...table.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].map(([,row])=>{
    const cells=[...row.matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(r=>r[1])
    const id=(row.match(/game\/stats\/(\d+)\/page-summary/)||[])[1]
    const score=clean(cells[2]).match(/^(\d+)\s*-\s*(\d+)$/)
    return id&&cells.length>=7&&score?{id,a:clean(cells[1]),b:clean(cells[3]),hs:+score[1],as:+score[2],date:clean(cells.at(-1))}:null
  }).filter(Boolean)
}
function parseSummary(html,m,games){
  // 双方标题与每行显式 WIN/LOSS 同时校验，不能使用经济差或 CSS 箭头代替胜方。
  const section=html.slice(html.indexOf('<!-- game by game -->'))
  const teams=[...section.matchAll(/<h1>\s*<a\b[^>]*>([^<]+)<\/a>\s*<\/h1>/g)].slice(0,2).map(r=>clean(r[1]))
  if(teams.length!==2)return []
  const flip=pair(teams[0],teams[1],m.home,m.away)
  if(flip===null)return []
  const numbers=[...html.matchAll(/page-game\/['"][^>]*>Game\s+(\d+)<\/a>/g)].map(r=>+r[1])
  const blocks=section.split(/<div class=['"]row pb-1['"]>/).slice(1)
  const rows=blocks.map((block,i)=>{
    const result=[...block.matchAll(/<h1\b[^>]*class=['"]text_(?:victory|defeat)['"][^>]*>\s*(WIN|LOSS)\s*<\/h1>/g)].map(r=>r[1])
    if(result.length!==2||result[0]===result[1])return null
    return {n:numbers[i],winner:(result[0]==='WIN')!==flip?'home':'away'}
  }).filter(Boolean)
  return validWinners(rows,m,games)?rows:[]
}
function tournamentFor(name,comp){
  const patterns={worlds:/^Worlds\b/,lpl:/^LPL\s/,lck:/^LCK\s(?!CL\b)/,lec:/^LEC\s/,msi:/^MSI\b/,demacia:/^Demacia\b/}
  return !!patterns[comp]&&patterns[comp].test(name)
}
async function tencent(m,games,get,now){
  const groups={worlds:'1',lpl:'5',msi:'8',demacia:'4'}
  if(!groups[m.comp])return null
  const feed=jsonp(await get('https://lpl.qq.com/web201612/data/LOL_MATCH2_MATCH_HOMEPAGE_BMATCH_LIST.js'))
  const rows=(feed.msg||[]).filter(r=>r.bGameId===groups[m.comp]&&Math.abs(Date.parse(r.MatchDate.replace(' ','T')+'+08:00')-Date.parse(m.start))<=2*3600000
    &&pair(r.TeamShortNameA,r.TeamShortNameB,m.home,m.away)!==null)
  if(rows.length!==1)return null
  const script=await get('https://lpl.qq.com/web201612/js/after-data-1.js')
  const token=(script.match(/Authorization:\s*"([^"]+)"/)||[])[1]
  if(!token)return null
  const source='https://lpl.qq.com/es/stats.shtml?bmid='+rows[0].bMatchId
  const raw=JSON.parse(await get('https://open.tjstats.com/match-auth-app/open/v1/compound/matchDetail?matchId='+rows[0].bMatchId,{headers:{Authorization:token,accept:'application/json'}}))
  if(String(raw.data?.matchId)!==String(rows[0].bMatchId))return null
  const winners=tencentRows(raw.data,m,games,now)
  return winners.length?{winners,source,provider:'腾讯官方赛事数据'}:null
}
async function gol(m,games,get){
  const day=new Date(m.start).toISOString().slice(0,10),year=+day.slice(0,4)
  const catalog=JSON.parse(await get('https://gol.gg/tournament/ajax.trlist.php',{method:'POST',headers:{'Content-Type':'application/x-www-form-urlencoded'},body:'season=S'+(year-2010)}))
  const events=catalog.filter(row=>tournamentFor(row.trname,m.comp)&&row.firstgame<=day&&row.lastgame>=day)
  const candidates=[]
  for(const event of events){
    const html=await get('https://gol.gg/tournament/tournament-matchlist/'+encodeURIComponent(event.trname)+'/')
    for(const row of parseMatchList(html)){
      const flip=pair(row.a,row.b,m.home,m.away)
      if(row.date===day&&flip!==null&&(m.status!=='finished'||(flip?row.as:row.hs)===m.home.score&&(flip?row.hs:row.as)===m.away.score))candidates.push(row)
    }
  }
  if(candidates.length!==1)return null
  const source='https://gol.gg/game/stats/'+candidates[0].id+'/page-summary/'
  const winners=parseSummary(await get(source),m,games)
  return winners.length?{winners,source,provider:'Games of Legends'}:null
}
async function fetchWinners(m,games,get=request,now=Date.now()){
  if(!SUPPORTED.has(m.comp)||!Number.isFinite(Date.parse(m.start)))return null
  for(const source of [tencent,gol])try{const result=await source(m,games,get,now);if(result)return result}catch(e){console.warn('[lol-winners]',m.id,source.name,e.message)}
  return null
}
module.exports={SUPPORTED,fetchWinners,tencentRows,parseMatchList,parseSummary,tournamentFor,validWinners}
