const M = require('D:/work/wbzone/sports-schedule/data/matches.js');

console.log('=== NBA 全部比赛的北京时间分布（不论状态）===');
const nbah = {};
M.filter(m => m.comp === 'nba').forEach(m => {
  const h = parseInt(m.time.split(':')[0], 10);
  nbah[h] = (nbah[h] || 0) + 1;
});
Object.entries(nbah).sort((a, b) => b[1] - a[1]).forEach(([h, c]) => console.log('  ' + h + '点: ' + c + ' 场'));
console.log('  NBA 已结束场次:', M.filter(m => m.comp === 'nba' && m.status === 'finished').length, '/', M.filter(m => m.comp === 'nba').length);

// 找几个典型日窗口，看每个窗口内「已结束」的比赛有多少
console.log('\n=== 各日期窗口(当日06:00→次日06:00)内容量 ===');
function windowStat(dateStr) {
  const s = Date.parse(dateStr + 'T06:00:00+08:00');
  const e = s + 86400000;
  const inWin = M.filter(m => {
    const t = Date.parse(m.start);
    return t >= s && t < e;
  });
  const fin = inWin.filter(m => m.status === 'finished');
  const comps = {};
  fin.forEach(m => { comps[m.comp] = (comps[m.comp] || 0) + 1; });
  const cstr = Object.entries(comps).map(([k, v]) => k + '×' + v).join(' ');
  return { date: dateStr, total: inWin.length, fin: fin.length, comps: cstr };
}
['2026-09-19', '2026-09-20', '2026-09-22', '2026-09-23', '2026-09-25', '2026-09-26', '2026-09-27', '2026-09-28']
  .forEach(d => {
    const r = windowStat(d);
    console.log('  ' + r.date + ' 窗口: 共 ' + String(r.total).padStart(3) + ' 场, 已结束 ' + String(r.fin).padStart(3) + ' 场   ' + r.comps);
  });

// 最近一个已结束比赛最多的时间点分布：看看凌晨 3-6 点还有多少比赛在打
console.log('\n=== 所有已结束比赛的北京时间时段汇总 ===');
const all = {};
M.filter(m => m.status === 'finished').forEach(m => {
  const h = parseInt(m.time.split(':')[0], 10);
  all[h] = (all[h] || 0) + 1;
});
Object.entries(all).sort((a, b) => parseInt(a[0]) - parseInt(b[0])).forEach(([h, c]) => {
  const bar = '#'.repeat(Math.min(c, 60));
  console.log('  ' + String(h).padStart(2) + '点 ' + String(c).padStart(3) + ' ' + bar);
});
