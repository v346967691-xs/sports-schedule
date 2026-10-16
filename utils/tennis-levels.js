// 2026 官方等级兜底，不跨年沿用。滚动周历不覆盖已结束分站。
// ATP: https://www.atptour.com/en/news/what-is-the-2026-atp-tour-calendar/
// WTA: https://api.wtatennis.com/tennis/tournaments/?from=2026-09-01&to=2026-12-31&pageSize=100
const levels={atp:{'China Open':500,'Kinoshita Group Japan Open Tennis Championships':500,
  'Rolex Shanghai Masters':1000,'Rolex Paris Masters':1000,'Erste Bank Open':500,'Swiss Indoors Basel':500,
  'Bybit Stockholm Open':250,'BNP Paribas Fortis European Open':250,'Almaty Open':250},
  wta:{'China Open':1000,'Dongfeng Voyah Wuhan Open':1000,'Ningbo Open':500,'Kinoshita Group Japan Open':250,
    'Guangzhou Open':250,'Toray Pan Pacific Open Tennis':500,'Prudential Hong Kong Tennis Open':250,'Chennai Open':250}}
function level(tour,name,date){const value=String(date||'').slice(0,4)==='2026'&&levels[tour]&&levels[tour][String(name||'').trim()];return value?`${tour.toUpperCase()} ${value}`:''}
function mergeCalendar(previous,incoming){
  const rows=new Map()
  ;(previous||[]).concat(incoming||[]).forEach(e=>{if(e&&e.name&&e.level)rows.set([e.tour,e.name,e.start,e.end].join('|'),e)})
  return [...rows.values()]
}
module.exports={level,mergeCalendar}
