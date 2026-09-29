// 每日资讯选题回测：按「早报 06:00 / 晚报 21:00」双轨窗口，算出每一期的头版与备选
// 用法：node tools/brief-pick.js                → 只打印汇总
//       node tools/brief-pick.js 2026-09-27     → 打印指定出报日的明细
// 窗口定义见 tools/brief-window.js

const W = require('./brief-window.js');

function fmt(m) {
  return m.home.zh + ' ' + m.home.score + '-' + m.away.score + ' ' + m.away.zh;
}

function show(tag, label, res) {
  console.log('\n[' + tag + '] ' + label + '　窗口内 ' + res.list.length + ' 场，已结束 ' + res.fin.length + ' 场');
  if (!res.top.length) {
    console.log('   （空窗 → 需改出前瞻）');
    return;
  }
  res.top.forEach((m, i) => {
    const mark = i === 0 ? '★ 头版' : '  备选' + i;
    const stage = (m.stage || '').split('·').pop().trim();
    console.log('  ' + mark + '  ' + String(m._score).padStart(3) + '  [' + m.comp + '] '
      + stage.padEnd(10) + ' ' + fmt(m) + '   (' + m._reasons.join('、') + ')');
  });
}

const detail = process.argv[2];

if (detail) {
  const prev = W.prevDay(detail);
  const m = W.morning(detail, 5, W.carryOver(prev));
  const e = W.evening(detail, 5);
  console.log('=== 出报日 ' + detail + ' 明细 ===');
  show('早报', detail + ' 06:00（' + prev + ' 18:00 → ' + detail + ' 06:00）', m);
  show('晚报', detail + ' 21:00（' + detail + ' 06:00 → ' + detail + ' 18:00）', e);
  process.exit(0);
}

// ⚠️ 出报日 ≠ 比赛日。matches.js 的 date 是 UTC 日期，而早报窗口是「昨日 18:00 → 当日 06:00」，
// 所以一场北京时间 11-09 15:00 的比赛（UTC 11-09）归属的是 11-10 的早报。
// 若只在「有比赛的日期」上迭代，11-10 无比赛就会被跳过，导致 2025 世界赛决赛整条漏报。
const finished = W.M.filter((m) => m.status === 'finished');
const dayList = W.pubDays();

console.log('=== 每日资讯选题回测（北京时间）===');
console.log('已结束比赛 ' + finished.length + ' 场　出报日 ' + dayList.length + ' 天（'
  + dayList[0] + ' → ' + dayList[dayList.length - 1] + '）');

let mHits = 0; let eHits = 0;
let mEmpty = 0; let eEmpty = 0;
let carryTotal = 0;

dayList.forEach((ds) => {
  const m = W.morning(ds, 3, W.carryOver(W.prevDay(ds)));
  const e = W.evening(ds, 3);
  carryTotal += m.carry.length;
  if (m.top.length) mHits++; else mEmpty++;
  if (e.top.length) eHits++; else eEmpty++;
});

console.log('\n=== 汇总 ===');
console.log('  早报 06:00 有内容 ' + mHits + ' 期，空窗 ' + mEmpty + ' 期　→ 空窗率 ' + Math.round(mEmpty / dayList.length * 100) + '%');
console.log('  晚报 21:00 有内容 ' + eHits + ' 期，空窗 ' + eEmpty + ' 期　→ 空窗率 ' + Math.round(eEmpty / dayList.length * 100) + '%');
console.log('  保险条款触发（晚窗口未打完、结转次日早报）：' + carryTotal + ' 场');
console.log('\n  注：晚报空窗率高是因为 NBA 2026-27 赛季尚未开打（200 场全是 upcoming，');
console.log('      date 范围 2026-10-04 → 2026-11-15）。这 200 场里 194 场落在晚报窗口，');
console.log('      且有赛程的 32 天中 32 天晚报窗口都有比赛 —— 赛季开打后晚报填充率预计 100%。');
