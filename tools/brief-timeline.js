// 回测速览：每一期只打印一行「头版」，便于通读全时间轴判断选题质量
// 用法：node tools/brief-timeline.js [起始出报日] [结束出报日]
// 例：node tools/brief-timeline.js 2025-10-25 2025-11-12

const W = require('./brief-window.js');

const from = process.argv[2] || '0000-01-01';
const to = process.argv[3] || '9999-12-31';

const dayList = W.pubDays().filter((d) => d >= from && d <= to);

console.log('出报日       早报 06:00（昨18:00→今06:00）                                   晚报 21:00（今06:00→今18:00）');
console.log('─'.repeat(148));

let mHits = 0; let eHits = 0;

dayList.forEach((ds) => {
  const m = W.morning(ds, 3, W.carryOver(W.prevDay(ds)));
  const e = W.evening(ds, 3);
  if (m.top.length) mHits++;
  if (e.top.length) eHits++;

  const pad = (s, n) => {
    let w = 0;
    for (const ch of s) w += ch.charCodeAt(0) > 127 ? 2 : 1;
    return s + ' '.repeat(Math.max(0, n - w));
  };

  const cell = (top) => (top.length
    ? String(top[0]._score).padStart(3) + ' [' + top[0].comp + '] '
      + top[0].home.zh + ' ' + top[0].home.score + '-' + top[0].away.score + ' ' + top[0].away.zh
      + '　' + top[0]._reasons.join('、')
    : '（空窗 → 改出前瞻）');

  console.log(ds + '  ' + pad(cell(m.top), 64) + '  ' + cell(e.top));
});

console.log('─'.repeat(148));
console.log('共 ' + dayList.length + ' 个出报日：早报有内容 ' + mHits + ' 期，晚报有内容 ' + eHits + ' 期');
