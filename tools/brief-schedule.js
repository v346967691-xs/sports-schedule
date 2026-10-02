// 出报时刻选型：对若干候选时刻做「漏场率」评估
// 漏场 = 比赛按开赛时间落进了某一期的窗口，但出报那一刻它还没结束，
// 于是这一期报不了；而它又不属于下一期的窗口（开赛时间已过界）→ 彻底消失。
//
// 用法：node tools/brief-schedule.js

const M = require('../utils/snapshot').decodeSnapshot(require('../data/matches.js'));

const BJ = 8 * 3600000;

// 保守时长估计（分钟）：宁可估长，漏场才算得准
const DUR = {
  football: 135,   // 足球含中场与补时
  lol_bo1: 45, lol_bo3: 130, lol_bo5: 215,
  nba: 155,
};

function durMin(m) {
  if (m.comp === 'nba') return DUR.nba;
  const bo = Number(m.bo) || 1;
  if (bo >= 5) return DUR.lol_bo5;
  if (bo >= 3) return DUR.lol_bo3;
  if (m.comp === 'lpl' || m.comp === 'lck' || m.comp === 'lec' || m.comp === 'worlds' || m.comp === 'msi') {
    return bo >= 2 ? DUR.lol_bo3 : DUR.lol_bo1;
  }
  return DUR.football;
}

function bjHour(m) {
  return new Date(Date.parse(m.start) + BJ).getUTCHours();
}

// 评估：给定「晚报出报小时」（早报固定 06:00），算漏场
// 早报窗口 [昨日 evenH? 不 —— 早报固定 [昨18:00, 今06:00)，出报 06:00
// 晚报窗口 [今日 06:00, 今日 18:00)，出报 evenH 点
function evaluate(evenH) {
  let morningTotal = 0; let morningLost = 0;
  let eveningTotal = 0; let eveningLost = 0;
  const lostBy = {};

  M.forEach((m) => {
    if (m.status !== 'finished' && m.status !== 'live') return;
    const h = bjHour(m);
    const startMs = Date.parse(m.start);
    const endMs = startMs + durMin(m) * 60000;

    // 该比赛在当天（北京日期）出报的某一期
    const dayStr = new Date(startMs + BJ).toISOString().slice(0, 10);
    let pubMs;
    if (h >= 18 || h < 6) {
      morningTotal++;
      // 归属次日 06:00 早报
      const pubDay = h >= 18
        ? new Date(Date.parse(dayStr + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10)
        : dayStr;
      pubMs = Date.parse(pubDay + 'T06:00:00+08:00');
      if (endMs > pubMs) { morningLost++; lostBy[m.comp] = (lostBy[m.comp] || 0) + 1; }
    } else {
      eveningTotal++;
      pubMs = Date.parse(dayStr + 'T' + String(evenH).padStart(2, '0') + ':00:00+08:00');
      if (endMs > pubMs) { eveningLost++; lostBy[m.comp] = (lostBy[m.comp] || 0) + 1; }
    }
  });

  return { evenH, morningTotal, morningLost, eveningTotal, eveningLost, lostBy };
}

console.log('=== 出报时刻选型：漏场率评估（早报固定 06:00）===');
console.log('时长按保守估计：足球 135 分钟、LoL BO1/BO3/BO5 = 45/130/215 分钟、NBA 155 分钟\n');
console.log('晚报时刻   晚报窗口内   晚报漏场   早报窗口内   早报漏场   漏场构成');

[18, 19, 20, 21, 22].forEach((h) => {
  const r = evaluate(h);
  const pct = (a, b) => (b ? Math.round(a / b * 100) : 0) + '%';
  console.log('  ' + String(h).padStart(2) + ':00       '
    + String(r.eveningTotal).padStart(4) + ' 场     '
    + String(r.eveningLost).padStart(3) + ' (' + pct(r.eveningLost, r.eveningTotal).padStart(4) + ')   '
    + String(r.morningTotal).padStart(4) + ' 场     '
    + String(r.morningLost).padStart(3) + ' (' + pct(r.morningLost, r.morningTotal).padStart(4) + ')   '
    + (Object.keys(r.lostBy).length ? JSON.stringify(r.lostBy) : '—'));
});
