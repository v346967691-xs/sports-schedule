/** Live-tennis 公开统计页面适配。只解析白名单字段，不执行网页脚本。 */
const names = require('../utils/tennis-names')
const tennis = require('../utils/tennis')
const BASE = 'https://www.live-tennis.cn'
const DAY = 86400000
function decode(s) {
  return String(s || '').replace(/&quot;/g,'"').replace(/&#39;|&apos;/g,"'").replace(/&amp;/g,'&').replace(/&nbsp;/g,' ')
    .replace(/&#(x[0-9a-f]+|\d+);/gi,(_,n)=>{const v=n[0].toLowerCase()==='x'?parseInt(n.slice(1),16):Number(n);return v<=0x10ffff?String.fromCodePoint(v):''})
}
const text = s => decode(String(s || '').replace(/<script\b[\s\S]*?<\/script>/gi,'').replace(/<[^>]*>/g,' ')).replace(/\s+/g,' ').trim()
function attr(tag,key) {
  const m=new RegExp('(?:^|\\s)'+key+'\\s*=\\s*(?:"([^"]*)"|\'([^\']*)\'|([^\\s>]+))','i').exec(tag)
  return m?decode(m[1]??m[2]??m[3]):''
}
function blockText(html,cls) {
  const re=new RegExp('<div\\b[^>]*class=["\']?'+cls+'[^>]*>([\\s\\S]*?)<\\/div>','i')
  return text(re.exec(html)?.[1])
}
function parseSchedule(html,date) {
  const starts=[...html.matchAll(/<div\b[^>]*class="cResultTour\s+cResultTour\d+"[^>]*>/g)]
  const out=[]
  starts.forEach((tour,i)=>{
    const body=html.slice(tour.index,starts[i+1]?.index??html.length)
    const city=blockText(body,'cResultTourInfoCity'),title=blockText(body,'cResultTourInfoName')
    const games=[...body.matchAll(/<div\b[^>]*class="cResultMatch\s+[^"<>]*"[^>]*>/g)]
    games.forEach((game,j)=>{
      if(attr(game[0],'is-double')!=='0')return
      const part=body.slice(game.index,games[j+1]?.index??body.length)
      const call=/open_stat\(([^)]*)\)/.exec(part)
      if(!call)return
      const raw=decode(call[1]).match(/"(?:[^"\\]|\\.)*"/g)
      if(!raw||raw.length!==8)return
      let args
      try{args=raw.map(v=>JSON.parse(v))}catch(_){return}
      const [eid,comp,matchid,year,id1,id2,p1,p2]=args
      if(!['atp','wta'].includes(comp)||!/^[ML]S\d+$/.test(matchid)||!/^\d+$/.test(eid)||!/^20\d{2}$/.test(year)||!id1||!id2||id1===id2)return
      const playerNames=[...part.matchAll(/<img\b[^>]*class=["']?playerFlag\b[^>]*>([\s\S]*?)<br\s*\/?\s*>/gi)]
        .map(m=>text(m[1].replace(/<span\b[^>]*class=["']?entrySign\b[^>]*>[\s\S]*?<\/span>/gi,'')))
      if(playerNames.length!==2)return
      const ts=blockText(part,'cResultMatchTime')
      out.push({eid,comp,matchid,year,id1,id2,p1,p2,names:playerNames,city,title,date,
        round:blockText(part,'cResultMatchRound'),status:Number(attr(game[0],'match-status')),
        start:/^\d{10}$/.test(ts)?Number(ts)*1000:null})
    })
  })
  return out
}
const ALIASES = {
  // 仅合并已核对的完整选手身份译名；不按姓氏或缩写猜人。
  '亚历山大兹韦列夫':'亚历山大兹维列夫',
  '叶莲娜奥斯塔彭科':'叶莲娜奥斯塔朋科',
  '伊加斯维亚特克':'伊加斯瓦泰克',
  '叶琳娜斯维托利娜':'伊莉娜斯维托丽娜',
  '安李':'李安',
  '索纳伊卡塔尔':'索尼娅卡塔尔',
  '伊加希维昂泰克':'伊加斯瓦泰克',
  '卡洛琳娜穆霍娃':'卡罗利娜穆霍娃',
  '蒂亚娜施内德':'季阿娜施耐德',
  '叶琳娜斯维托丽娜':'伊莉娜斯维托丽娜',
  '蕾拉费尔南德斯':'莱拉费尔南德斯',
  '贾丝明保利尼':'加斯明鲍利尼',
  '阿什琳克鲁格':'阿什林克鲁格',
  '李吉妮':'李安', // WTA 326096，官方 Ann Li
  '曾丽美':'贾尼丝张', // WTA 328818，官方 Janice Tjen
  '马娅赫瓦林斯卡':'玛雅赫瓦林斯卡',
  '汤米保罗':'托米保罗',
}
function nameKey(value) {
  const raw=String(value||'').normalize('NFD').replace(/[\u0300-\u036f]/g,'').toLowerCase()
  const key=(/[\u3400-\u9fff]/.test(raw)?raw:names.nameKey(raw)).replace(/[^\p{L}\p{N}]/gu,'')
  return ALIASES[key]||key
}
function playerKeys(p) {
  return new Set([p.name,p.zh,names.nameZh(p.name)].filter(Boolean).map(nameKey))
}
function roundKey(s) {
  const t=String(s||'').split('·').at(-1).trim()
  if(/^(?:Final|Finals|决赛)$/i.test(t))return 'f'
  if(/Semifinal|半决赛/i.test(t))return 'sf'
  if(/Quarterfinal|¼决赛|1\/4决赛|四分之一决赛/i.test(t))return 'qf'
  const round=/^(?:Round\s+|第)(\d+)(?:轮)?$/i.exec(t)
  return round?'r'+round[1]:''
}
function stationMatches(match,entry) {
  const station=tennis.tournamentOf(match).name
  const s=nameKey(station),city=nameKey(entry.city),title=nameKey(entry.title)
  if(!s||!city&&!title)return false
  if(city&&s.includes(city)||title&&s.includes(title)||title&&title.includes(s))return true
  const aliases={'中国网球公开赛':['北京'],'美国网球公开赛':['纽约'],'澳大利亚网球公开赛':['墨尔本'],'法国网球公开赛':['巴黎'],'温布尔登':['伦敦'],'加拿大':['多伦多','蒙特利尔']}
  return Object.entries(aliases).some(([key,values])=>station.includes(key)&&values.some(v=>entry.city.includes(v)))
}
function findMatch(match,entries) {
  const home=playerKeys(match.home),away=playerKeys(match.away),round=roundKey(match.stage)
  const found=entries.filter(e=>e.comp===match.comp&&e.year===String(match.date||match.start).slice(0,4)
    && (e.date===match.date||e.start!==null&&Math.abs(e.start-Date.parse(match.start))<DAY)
    && stationMatches(match,e)&&(!round||!roundKey(e.round)||round===roundKey(e.round)))
    .map(e=>({entry:e,flip:home.has(nameKey(e.names[1]))&&away.has(nameKey(e.names[0])),
      exact:home.has(nameKey(e.names[0]))&&away.has(nameKey(e.names[1]))||home.has(nameKey(e.names[1]))&&away.has(nameKey(e.names[0]))}))
    .filter(e=>e.exact)
  // 同一场可能同时出现在相邻日期页面；身份相同才合并，歧义不猜。
  const unique=new Map(found.map(f=>[[f.entry.comp,f.entry.eid,f.entry.year,f.entry.matchid].join(':'),f]))
  return unique.size===1?[...unique.values()][0]:null
}
const LABELS={ACE:'ACE','双误':'双误','制胜分':'制胜分','非受迫性失误':'非受迫性失误','一发成功率':'一发成功率','一发得分率':'一发得分率','二发得分率':'二发得分率','破发点转化率':'破发点兑现率','破发点挽救率':'破发点挽救率','接发球得分率':'接发得分率','接一发得分率':'接一发得分率','接二发得分率':'接二发得分率','网前得分率':'网前得分率','总得分':'总得分','最快一发速度':'最快一发速度','平均一发速度':'平均一发速度','平均二发速度':'平均二发速度'}
function value(raw,speed) {
  if(speed){const kph=/<span\b[^>]*class=["'][^"']*cStatKPH[^"']*["'][^>]*>([\s\S]*?)<\/span>/i.exec(raw);const n=Number(text(kph?.[1]));return n>0&&n<300?`${n} km/h`:null}
  const t=text(raw)
  if(/-\d/.test(t))return null
  const ratio=/(\d+)\s*\/\s*(\d+)/.exec(t)
  if(ratio){const a=Number(ratio[1]),b=Number(ratio[2]);return b>0&&a<=b?`${Math.round(a/b*100)}%\n${a}/${b}`:null}
  return /^\d+$/.test(t)?Number(t):null
}
function queryUrl(e) {
  return BASE+'/zh/stat/query?'+new URLSearchParams({eid:e.eid,type:e.comp,matchid:e.matchid,year:e.year,id1:e.id1,id2:e.id2,p1:e.p1,p2:e.p2})
}
function normalize(html,match,found,now=Date.now()) {
  const e=found.entry
  const ids=[...html.matchAll(/\/pic\/hs\/([^"'\s)]+)/g)].map(m=>m[1]).slice(0,2)
  if(ids[0]!==e.id1||ids[1]!==e.id2)return null
  const sections=[]
  for(const table of html.matchAll(/<table\b[^>]*\bid=["']?iStatTable(\d+)["'\s>][^>]*>([\s\S]*?)<\/table>/gi)){
    const n=Number(table[1]);if(n>5)continue
    const rows=[]
    const firstCell=/<td\b([^>]*)>([\s\S]*?)<\/td>/i.exec(table[2])
    const elapsed=firstCell&&attr(firstCell[1],'colspan')==='3'?text(firstCell[2]):''
    for(const row of table[2].matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)){
      const cells=[...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>m[1]);if(cells.length!==3)continue
      const rawLabel=text(cells[1]),label=rawLabel==='保发率'?(e.comp==='atp'?'发球得分率':'保发率'):LABELS[rawLabel]
      if(!label)continue
      const speed=rawLabel.includes('速度'),a=value(cells[0],speed),b=value(cells[2],speed)
      if(a!==null||b!==null)rows.push([label,found.flip?b:a,found.flip?a:b])
    }
    if(rows.some(r=>r.slice(1).some(v=>typeof v==='number'?v>0:typeof v==='string'&&/\d+\/([1-9]\d*)/.test(v))))sections.push({n,rows,duration:/^\d{2}:\d{2}:\d{2}$/.test(elapsed)&&elapsed!=='00:00:00'?elapsed:''})
  }
  if(!sections.some(s=>s.n===0)||new Set(sections.map(s=>s.n)).size!==sections.length)return null
  const scoreTable=/<table\b[^>]*id=["']?iStatScoreTable["'\s>][^>]*>([\s\S]*?)<\/table>/i.exec(html)?.[1]||''
  // 退赛前未打完的一盘也有真实技术统计，按有数字的盘计数；空白预留盘不计入。
  const played=[...scoreTable.matchAll(/<tr\b[^>]*>([\s\S]*?)<\/tr>/gi)].filter(row=>{
    const scores=[...row[1].matchAll(/<td\b[^>]*>([\s\S]*?)<\/td>/gi)].map(m=>text(m[1]))
    return scores.length===2&&scores.every(s=>/^\d+(?:\s+\d+)?$/.test(s))
  }).length
  return {v:1,h:String(match.home.id),a:String(match.away.id),ts:new Date(now).toISOString(),complete:e.status===2&&played>0&&sections.length>=played+1,
    provider:'live-tennis',schema:2,source:'Live-tennis',url:queryUrl(e),identity:[e.comp,e.eid,e.year,e.matchid].join(':'),sections:sections.sort((a,b)=>a.n-b.n)}
}
async function read(url) {
  const r=await fetch(url,{signal:AbortSignal.timeout(20000),headers:{'User-Agent':'sports-schedule/1.0 (public tennis statistics)'}})
  if(!r.ok)throw Error('Live-tennis HTTP '+r.status)
  return r.text()
}
module.exports={BASE,parseSchedule,findMatch,normalize,queryUrl,read,nameKey}
