// 出报窗口的权威定义 —— 早报与晚报共用，改窗口只需改这一个文件
//
//   早报（当日 06:00 出报）：昨日 18:00 → 当日 06:00，12 小时
//   晚报（当日 21:00 出报）：当日 06:00 → 当日 18:00，12 小时
//   两窗口首尾相接、互不重叠，24 小时全覆盖。
//
// 为什么是 06/21 而不是 06/18（tools/brief-schedule.js 的实测结论）：
// ⚠️ 窗口按「开赛时间」归属，但出报那一刻必须已经打完才算数。
// 晚窗口 [06:00, 18:00) 里的比赛最晚要打到 21:30（LPL 17 点场、LCK 16 点场），
// 若 18:00 出报，实测 142 场里漏 107 场 = 75%（LCK 45、LPL 38、worlds 12、MSI 12）。
// 21:00 出报则零漏场。早窗口 [18:00, 06:00) 的比赛最晚 06:00 前结束，06:00 出报恰好。
// → 不对称不是设计瑕疵，是赛事真实分布决定的：欧洲夜场赶得上早报，亚洲下午场赶不上 18 点。
//
// 保险条款：早报额外收「昨日 06:00–18:00 开赛、但昨日 21:00 仍未结束」的比赛。
// 正常情况下这个集合是空集，只为防 BO5 拖到 4 小时这类异常长局，避免比赛彻底消失。

const M = require('../utils/snapshot').decodeSnapshot(require('../data/matches.js'));
const { pick } = require('./brief-score.js');

const BJ = '+08:00';
const MORNING_HOUR = 6;    // 早报出报时刻
const EVENING_HOUR = 21;   // 晚报出报时刻
const SPLIT_HOUR = 18;     // 窗口分界：晚窗口的末端（按开赛小时）

function bjMs(dateStr, hour) {
  return Date.parse(dateStr + 'T' + String(hour).padStart(2, '0') + ':00:00' + BJ);
}

function inWindow(from, to) {
  return M.filter((m) => {
    const t = Date.parse(m.start);
    return t >= from && t < to;
  });
}

function prevDay(dateStr) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') - 86400000).toISOString().slice(0, 10);
}

function nextDay(dateStr) {
  return new Date(Date.parse(dateStr + 'T00:00:00Z') + 86400000).toISOString().slice(0, 10);
}

// 晚报：当日 06:00 → 当日 18:00 开赛的比赛，21:00 出报
function evening(pubDate, coverN) {
  const list = inWindow(bjMs(pubDate, 6), bjMs(pubDate, SPLIT_HOUR));
  const fin = list.filter((m) => m.status === 'finished');
  return {
    window: [bjMs(pubDate, 6), bjMs(pubDate, SPLIT_HOUR)],
    at: bjMs(pubDate, EVENING_HOUR),
    list, fin,
    top: fin.length ? pick(fin, coverN || 3) : [],
  };
}

// 早报：昨日 18:00 → 当日 06:00，外加昨日晚窗口的「未打完」结转
function morning(pubDate, coverN, carryIds) {
  const prev = prevDay(pubDate);
  const list = inWindow(bjMs(prev, SPLIT_HOUR), bjMs(pubDate, MORNING_HOUR));
  const carry = (carryIds || []).length
    ? inWindow(bjMs(prev, 6), bjMs(prev, SPLIT_HOUR)).filter((m) => carryIds.includes(m.id))
    : [];
  const fin = list.concat(carry).filter((m) => m.status === 'finished');
  return {
    window: [bjMs(prev, SPLIT_HOUR), bjMs(pubDate, MORNING_HOUR)],
    at: bjMs(pubDate, MORNING_HOUR),
    list, carry, fin,
    top: fin.length ? pick(fin, coverN || 3) : [],
  };
}

// 昨日晚窗口里「21:00 还没结束」的比赛 id —— 交给次日早报兜底
function carryOver(pubDate) {
  const e = evening(pubDate, 1);
  return e.list.filter((m) => m.status !== 'finished').map((m) => m.id);
}

// 出报日集合：早报归属「比赛日 +1」、晚报归属「比赛日」，取并集。
// ⚠️ matches.js 的 date 是 UTC 日期，与北京日期错位，两个都要算（详见 brief-pick.js 注释）
function pubDays() {
  const done = M.filter((m) => m.status === 'finished');
  const set = new Set();
  done.forEach((m) => {
    set.add(m.date);
    set.add(nextDay(m.date));
  });
  return Array.from(set).sort();
}

/**
 * 这期到出报时刻了吗？
 *
 * 生成脚本跟着赛程同步每 15 分钟跑一次（幂等重算最近两天），所以「当天 21:00 的晚报」
 * 往往在下午就已经被算出来并写进云表了 —— 那一刻晚窗口里的比赛多半还没打完，
 * 出来的是一份残稿，而客户端按 pub_at 倒序取，它稳居第一，用户直接看穿。
 *
 * → 未到期次不落库（brief-push.js），客户端也不展示（utils/brief.js 的 isDue）。
 *   两处同一条规则，小程序打不到 tools/，所以是两份实现，改一处必须同步另一处。
 *
 * ⚠️ 解析不出时刻时返回 true：无法判断早晚的行不该因为空值被判成「未到期」而整体消失。
 * 注意：daily_brief 的 RLS 只允许删除 generated_at 早于 90 天前的行，
 * 所以已经写进去的未来期次脚本删不掉，只能靠上述规则从源头避免 + 人工清理。
 */
function isDue(pubAtIso, now) {
  const t = Date.parse(pubAtIso || '');
  if (!Number.isFinite(t)) return true;
  return t <= (now === undefined || now === null ? Date.now() : now);
}

module.exports = {
  BJ, bjMs, inWindow, prevDay, nextDay,
  morning, evening, carryOver, pubDays, isDue,
  MORNING_HOUR, EVENING_HOUR, SPLIT_HOUR, M,
};
