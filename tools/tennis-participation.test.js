const test=require('node:test'),assert=require('node:assert/strict')
const official=require('./tennis-participation'),view=require('../utils/tennis-insights')
const now=Date.parse('2026-10-16T06:00:00Z')
const calendar=[{name:'Wuhan',city:'wuhan',start:'2026-10-12',end:'2026-10-18'},
  {name:'Osaka',city:'osaka',start:'2026-10-19',end:'2026-10-25'},
  {name:'Beijing',city:'beijing',start:'2026-10-12',end:'2026-10-18'}]
const players=[{name:'Qinwen Zheng',key:'qinwen zheng'},{name:'Mirra Andreeva',key:'andreeva mirra'},{name:'Elina Svitolina',key:'elina svitolina'}]
const source='https://www.wtatennis.com/news/123/zheng-andreeva-to-miss-wuhan'
const news='<script>{"datePublished":"2026-10-12T03:01:00Z"}</script><h1>Zheng, Andreeva to miss Wuhan Open following Beijing final</h1>'
  +'<p><a>Zheng Qinwen</a> and Mirra Andreeva will not compete at the Dongfeng Voyah Wuhan Open this week following their final at the China Open in Beijing.</p>'
test('official withdrawal subjects and destination exclude other players, past stations and wrong editions',()=>{
  const result=official.parseWithdrawal(news,source,calendar,players,now)
  assert.equal(result.length,2);assert.ok(result.every(row=>row.name==='Wuhan'))
  assert.ok(result.some(row=>row.key==='qinwen zheng'))
  assert.equal(official.parseWithdrawal(news.replace('2026-10-12','2025-10-12'),source,calendar,players,now).length,0)
  assert.equal(official.parseWithdrawal(news.replace('2026-10-12','2026-10-20'),source,calendar,players,now).length,0)
  assert.deepEqual(official.newsLinks('<a href="/news/123/zheng-to-miss-wuhan"></a><a href="https://elsewhere/news/123/withdraw"></a>'),['https://www.wtatennis.com/news/123/zheng-to-miss-wuhan'])
})
test('current tournaments are fetched and official announcements override stale playing entries without mutating the previous cache',async()=>{
  const previous={entryLists:[{name:'Wuhan',start:'2026-10-12',checkedAt:new Date(now).toISOString(),entries:[{key:'qinwen zheng',role:'main',status:'playing'}]}]}
  const before=JSON.stringify(previous),read=[]
  const payload={tour:'wta',calendar,players}
  await official.refresh(payload,previous,now,{eventIds:{wuhan:[1075,'wuhan'],osaka:[405,'osaka']},
    parseEntries:()=>[{key:'qinwen zheng',role:'main',status:'playing'}],
    readUrl:async url=>{read.push(url);return url.endsWith('/news')?'<a href="/news/123/zheng-andreeva-to-miss-wuhan"></a>':url.includes('/player-list')?'data-year="2026"':news}})
  assert.ok(read.some(url=>url.includes('/1075/wuhan/2026/player-list')))
  assert.equal(JSON.stringify(previous),before)
  const entry=payload.entryLists.find(row=>row.name==='Wuhan').entries.find(row=>row.key==='qinwen zheng')
  assert.equal(entry.status,'withdrawn')
  const status=view.participation(payload,players[0],[],now).find(row=>row.name==='Wuhan')
  assert.equal(status.title,'官方已确认退赛');assert.equal(status.phaseLabel,'赛事进行中')
  assert.match(status.source,/wtatennis.com\/news/)
})
test('a tournament already under way never falls back to a pre-tournament registration state',()=>{
  const payload={tour:'wta',calendar:[calendar[0]]}
  const current=view.participation(payload,players[0],[],now)[0]
  assert.equal(current.title,'本站参赛状态待核实');assert.equal(current.phase,'live')
  assert.doesNotMatch(current.title,/待报名|未开始/)
  const partial={...payload,entryLists:[{name:'Wuhan',start:'2026-10-12',checkedAt:new Date(now).toISOString(),complete:false,entries:[]}]}
  assert.equal(view.participation(partial,players[0],[],now)[0].title,'本站参赛状态待核实')
  assert.equal(view.pointsDetails({gains:[{event:'WUHAN',points:0}],drops:[]}).gains.length,0,'zero-point placeholders do not masquerade as newly earned points')
})
test('full given name and customary surname override older translations without changing athlete identity',()=>{
  const names=require('../utils/tennis-names')
  assert.equal(names.nameZh('Elina Svitolina'),'伊莉娜·斯维托丽娜')
  assert.equal(names.nameZh('Iga Świątek'),'伊加·斯瓦泰克')
  const match=names.localizeMatch({comp:'wta',home:{name:'Swiatek Iga',zh:'伊加·斯维亚特克'},away:{name:'Elina Svitolina',zh:'叶林娜·斯维托林纳'}})
  assert.equal(match.home.zh,'伊加·斯瓦泰克');assert.equal(match.away.zh,'伊莉娜·斯维托丽娜')
  assert.equal(match.home.name,'Swiatek Iga');assert.equal(match.away.name,'Elina Svitolina')
  assert.equal(names.nameZh('Swiatek'),'','surname alone must not identify an athlete')
  assert.equal(names.nameZh('Qinwen Zheng'),'郑钦文','native Chinese names keep their customary order')
  assert.equal(names.nameZh('Camila Osorio'),'卡米拉·奥索里奥','use the registered full name rather than only a second surname')
  assert.equal(names.nameZh('Anna Bondar'),'安娜·邦达尔','western display order is given name then surname')
  assert.equal(names.nameZh('Fábián Marozsán'),'法比安·马洛桑')
  assert.equal(names.nameZh('Unknown Player'),'','unknown full names are left to the upstream fallback')
})
test('cache signatures ignore JSONB key order and verification clocks but never ignore an actual withdrawal',()=>{
  const {signature}=require('./tennis-insights')
  const first={tour:'wta',players:[{name:'Qinwen Zheng',points:2018}],entryLists:[{name:'Wuhan',checkedAt:'2026-10-16T00:00:00Z',entries:[{key:'qinwen zheng',status:'playing'}]}]}
  const reordered={entryLists:[{entries:[{status:'playing',key:'qinwen zheng'}],checkedAt:'2026-10-16T06:00:00Z',name:'Wuhan'}],players:[{points:2018,name:'Qinwen Zheng'}],tour:'wta'}
  assert.equal(signature(first),signature(reordered))
  reordered.entryLists[0].entries[0].status='withdrawn'
  assert.notEqual(signature(first),signature(reordered))
})
