// 日报写作层：把一场已结束的比赛写成报纸的标题、导语、正文
//
// ⚠️ 反幻觉是这一层的第一原则，比文采重要得多。
// 现有数据只有：队名、比分、赛事、阶段、球场、开赛时间、BO 局数、队色。
// 没有进球者、没有事件时间轴、没有控球/射门、没有排名、没有让分。
// 所以「绝杀」「逆转」「让二追三」「补时」「点球」「加时」这些**一律不许写** ——
// 它们看起来很自然，但数据推不出来，写了就是编。
// 允许写的是能从比分与赛制严格推出的判断，例如：
//   BO5 打到 3-2 → 打了五局、最后一局定胜负 → 可以说「决胜局」「打满五局」
//   足球 2-1     → 可以说「一球之差」「险胜」，但**不能**说「绝杀」
//   足球 0-0     → 「互交白卷」
//   一方 0 球    → 「零封」

const T = require('./teams-tier.js');
const N = require('./team-nickname.js');
// 阶段判定必须复用 brief-score 的 stageBonus，不要在这里另写正则：
// ⚠️ 「半决赛」包含「决赛」二字，自己写 /决赛/ 会把半决赛判成决赛，
// 标题就会写出「世界赛半决赛，T1 问鼎」这种硬伤（回测踩过）。
const { stageBonus } = require('./brief-score.js');

const COMP_ZH = {
  worlds: '英雄联盟全球总决赛', msi: '季中冠军赛', ucl: '欧冠', uel: '欧联',
  epl: '英超', liga: '西甲', seriea: '意甲', bundesliga: '德甲', ligue1: '法甲',
  nba: 'NBA', lpl: 'LPL', lck: 'LCK', lec: 'LEC', chn: '中国之队', nations: '欧国联',
};

function compZh(comp) { return COMP_ZH[comp] || comp; }

function stageZh(stageRaw) {
  const s = String(stageRaw || '');
  const parts = s.split('·').map((x) => x.trim());
  return parts.length > 1 ? parts[parts.length - 1] : s;
}

// ── 叙事识别 ───────────────────────────────────────────
// 按新闻价值从高到低判定，一场比赛只认一个主叙事。
// 返回 { key, label } —— label 会作为理由展示给用户看
function narrative(m) {
  const h = m.home || {}; const a = m.away || {};
  const hs = Number(h.score) || 0;
  const as = Number(a.score) || 0;
  const diff = Math.abs(hs - as);
  const comp = m.comp;
  const stage = stageZh(m.stage);
  const bo = Number(m.bo) || 1;

  const win = hs > as ? h : (as > hs ? a : null);
  const lose = hs > as ? a : (as > hs ? h : null);
  const wStrong = !!win && T.isStrong(win.zh);
  const lStrong = !!lose && T.isStrong(lose.zh);
  const wT1 = !!win && T.isT1(win.zh);
  const lT1 = !!lose && T.isT1(lose.zh);

  // 1. 夺冠：用 stageBonus 的判定结果，避免「半决赛」被当成决赛
  const st = stageBonus(m.stage);
  if (st.label === '决赛') {
    return { key: 'champion', label: '冠军战' };
  }

  // 2. 冷门：非豪门掀翻豪门
  // ⚠️ 判据是「胜者不是 T1 且 负者是 T1」，不是「胜者不是强队」。
  // 用后者会漏掉「科莫 4-1 RB莱比锡」这种二线队掀翻豪门的标准冷门（回测踩过）。
  if (win && !wT1 && lT1) {
    return { key: 'upset', label: '冷门' };
  }

  // 3. 血洗 / 大胜
  if (T.isFootball(comp)) {
    if (diff >= 5) return { key: 'rout', label: '大比分' };
    if (diff === 4) return { key: 'bigwin', label: '大胜' };
  }

  // 4. 电竞：打满 / 横扫 / 三局苦战
  if (T.isLol(comp)) {
    const best = Math.max(hs, as); const worst = Math.min(hs, as);
    if (bo >= 5 && best === 3 && worst === 2) return { key: 'thriller', label: '打满五局' };
    if (bo >= 5 && best === 3 && worst === 0) return { key: 'sweep', label: '零封横扫' };
    // ⚠️ BO5 打满与横扫之间是 3-1，这个分支不能漏 —— 漏了就会掉到 clash，
    // 正文还会被误写成"打满五局"（回测时踩过）
    if (bo >= 5 && best === 3 && worst === 1) return { key: 'dominant', label: '五局内解决' };
    if (bo >= 3 && best === 2 && worst === 1) return { key: 'close_series', label: '三局苦战' };
    if (bo >= 3 && best === 2 && worst === 0) return { key: 'sweep', label: '直落两局' };
  }

  // 5. 德比 / 豪门对决
  if (T.isT1(h.zh) && T.isT1(a.zh)) return { key: 'derby', label: '豪门对决' };

  // 6. 平局
  if (diff === 0) {
    if (T.isFootball(comp) && hs === 0) return { key: 'goalless', label: '互交白卷' };
    return { key: 'draw', label: '战平' };
  }

  // 7. 险胜
  if (T.isFootball(comp) && diff === 1) return { key: 'nailbiter', label: '一球之差' };
  if (comp === 'nba' && diff <= 3) return { key: 'nailbiter', label: '毫厘之差' };

  // 8. 零封
  if (T.isFootball(comp) && (hs === 0 || as === 0) && Math.max(hs, as) >= 3) {
    return { key: 'shutout', label: '零封' };
  }

  // 9. 对轰
  if (T.isFootball(comp) && hs >= 3 && as >= 3) return { key: 'goalfest', label: '进球大战' };

  // 10. 强强对话
  if (wStrong && lStrong) return { key: 'clash', label: '强强对话' };

  return { key: 'plain', label: '' };
}

// ── 标题 ───────────────────────────────────────────────
// 标题模板按叙事分类。同一叙事给多套，用 index 轮换，避免连续几天撞句式。
const TITLE_TPL = {
  // ⚠️ 比分顺序：凡是「胜者在前」的句式一律用 c.ws（胜者分-负者分），
  // 凡是「主队在前」的句式才用 c.score（主队分-客队分）。
  // 混用会写出「IG 击败 JDG，比分 1-3」这种方向颠倒的标题（回测踩过）。
  champion: [
    (c) => c.w + '夺冠：' + c.ws + '击败' + c.l + '，捧起' + c.comp + '冠军',
    (c) => c.comp + c.stage + '，' + c.w + '问鼎',
    (c) => '加冕时刻：' + c.w + ' ' + c.ws + ' 战胜' + c.l,
  ],
  upset: [
    (c) => '冷门：' + c.w + ' ' + c.ws + ' 掀翻' + c.l,
    (c) => c.l + '主场折戟，' + c.w + '带走胜利',
    (c) => '不属于' + c.l + '的夜晚：' + c.ws + '不敌' + c.w,
  ],
  rout: [
    (c) => c.w + '血洗' + c.l + '，比分' + c.ws,
    (c) => '一场' + c.ws + '：' + c.w + '碾压' + c.l,
  ],
  bigwin: [
    (c) => c.w + '大胜' + c.l + '，比分' + c.ws,
    (c) => c.ws + '，' + c.w + '轻松过关',
  ],
  thriller: [
    (c) => '打满五局：' + c.w + '决胜局力克' + c.l,
    (c) => '五局鏖战，' + c.w + ' ' + c.ws + ' 险胜' + c.l,
  ],
  sweep: [
    (c) => c.w + '零封' + c.l + '，系列赛' + c.ws,
    (c) => '干净利落：' + c.w + ' ' + c.ws + ' 带走' + c.l,
  ],
  dominant: [
    (c) => c.w + ' ' + c.ws + ' 拿下' + c.l + '，未让比赛拖入决胜局',
    (c) => '五局三胜制，' + c.w + '以 ' + c.ws + ' 取胜',
  ],
  close_series: [
    (c) => c.w + '三局苦战拿下' + c.l + '，比分' + c.ws,
    (c) => c.ws + '：' + c.w + '在第三局分出胜负',
  ],
  derby: [
    (c) => c.comp + '德比：' + c.w + '一球制胜' + c.l,
    (c) => c.w + '与' + c.l + '的对话，' + c.ws + '分出胜负',
    (c) => '豪门对决：' + c.w + '力压' + c.l + '，比分' + c.ws,
  ],
  nailbiter: [
    (c) => '一球之差：' + c.w + ' ' + c.ws + ' 险胜' + c.l,
    (c) => c.ws + '，' + c.w + '带走三分',
    (c) => c.w + '险过关，' + c.l + '功亏一篑',
  ],
  draw: [
    (c) => c.h2 + '与' + c.a2 + '握手言和，比分 ' + c.score,
    (c) => c.comp + '：' + c.h2 + ' ' + c.score + ' ' + c.a2 + '，各取一分',
  ],
  goalless: [
    (c) => c.h2 + '与' + c.a2 + '互交白卷',
    (c) => '没有进球的夜晚：' + c.h2 + ' 0-0 ' + c.a2,
  ],
  shutout: [
    (c) => c.w + '零封' + c.l + '，比分' + c.ws,
    // ⚠️ 别写「XX防线未失一球」—— 会被读成「XX 自己的防线没丢球」，
    // 而实际意思是 XX 没让对手进球。改成「被零封」主语就没歧义了。
    (c) => c.ws + '，' + c.l + '被零封',
  ],
  goalfest: [
    (c) => '进球大战：' + c.ws + '，' + c.w + '笑到最后',
    (c) => c.h2 + ' ' + c.score + ' ' + c.a2 + '，一场对攻',
  ],
  clash: [
    (c) => c.w + '击败' + c.l + '，比分' + c.ws,
    (c) => c.comp + '强强对话：' + c.w + '拿下' + c.l,
  ],
  plain: [
    (c) => c.w + '战胜' + c.l + '，比分' + c.ws,
    (c) => c.comp + '：' + c.w + '击败' + c.l,
  ],
};

function title(m, seq) {
  const nar = narrative(m);
  const h = m.home || {}; const a = m.away || {};
  const hs = Number(h.score) || 0;
  const as = Number(a.score) || 0;
  const win = hs > as ? h : (as > hs ? a : null);
  const lose = hs > as ? a : (as > hs ? h : null);

  const [lh, la] = N.pairLabel(h.zh, a.zh);
  const ctx = {
    comp: compZh(m.comp),
    stage: stageZh(m.stage),
    score: hs + '-' + as,                                    // 主队在前
    ws: win ? Math.max(hs, as) + '-' + Math.min(hs, as) : hs + '-' + as, // 胜者在前
    h2: lh, a2: la,
    w: win ? N.label(win.zh) : lh,
    l: lose ? N.label(lose.zh) : la,
  };

  const tpls = TITLE_TPL[nar.key] || TITLE_TPL.plain;
  const tpl = tpls[(seq || 0) % tpls.length];
  return { text: tpl(ctx), narrative: nar };
}

// ── 导语（答案优先，一句话把结果说完）────────────────────
function lead(m) {
  const h = m.home || {}; const a = m.away || {};
  const hs = Number(h.score) || 0;
  const as = Number(a.score) || 0;
  const comp = compZh(m.comp);
  const stage = stageZh(m.stage);
  const stagePart = stage && stage !== comp ? comp + stage : comp;
  const win = hs > as ? h : (as > hs ? a : null);

  let result;
  if (!win) result = h.zh + '与' + a.zh + ' ' + hs + '-' + as + ' 握手言和';
  else {
    const lose = win === h ? a : h;
    result = win.zh + ' ' + Math.max(hs, as) + '-' + Math.min(hs, as) + ' 击败' + lose.zh;
  }
  return '北京时间' + m.date + ' ' + (m.time || '') + '，' + stagePart + '一场比赛结束，' + result + '。';
}

// ── 正文（三段，只用可推的事实）──────────────────────────
function body(m) {
  const h = m.home || {}; const a = m.away || {};
  const hs = Number(h.score) || 0;
  const as = Number(a.score) || 0;
  const diff = Math.abs(hs - as);
  const comp = compZh(m.comp);
  const stage = stageZh(m.stage);
  const bo = Number(m.bo) || 1;
  const nar = narrative(m);
  const st = stageBonus(m.stage);
  const paras = [];

  // 段 1：场合
  // ⚠️ venue 为空时是中立场（电竞决赛、国家队友谊赛常见），不能写「主场」
  const wname = hs > as ? h.zh : (as > hs ? a.zh : null);
  let p1 = comp + (stage && stage !== comp ? stage : '') + '，'
    + (m.venue ? h.zh + '坐镇' + m.venue + '迎战' + a.zh : h.zh + '对阵' + a.zh) + '。';
  paras.push(p1);

  // 段 2：比分解读（严格按可推的事实）
  let p2;
  if (T.isLol(m.comp)) {
    const best = Math.max(hs, as);
    const worst = Math.min(hs, as);
    // ⚠️ 局数描述必须由 best/worst 决定，不能只看 bo ——
    // 只看 bo 会把 3-0 横扫写成「打满五局」（回测踩过）
    if (bo >= 5 && best === 3 && worst === 2) {
      p2 = '系列赛打满五局，' + wname + '以 ' + best + '-' + worst + ' 拿下，决胜局分出高下。';
    } else if (bo >= 5 && best === 3 && worst === 0) {
      p2 = '连下三城，' + wname + ' 3-0 横扫对手，未丢一局。';
    } else if (bo >= 5) {
      p2 = '五局三胜制下，' + wname + '以 ' + best + '-' + worst + ' 取胜，第五局未用上。';
    } else if (bo >= 3 && best === 2 && worst === 1) {
      p2 = '三局苦战，' + wname + '以 ' + best + '-' + worst + ' 拿下，第三局定胜负。';
    } else if (bo >= 3) {
      p2 = '直落两局，' + wname + ' ' + best + '-' + worst + ' 取胜。';
    } else {
      p2 = '单局决胜，' + wname + '拿下这一分。';
    }
  } else if (hs === as) {
    p2 = hs === 0 ? '九十分钟互无建树，比分定格在 0-0。' : '双方战成 ' + hs + '-' + as + '，各取一分。';
  } else {
    const w = hs > as ? h : a;
    const l = hs > as ? a : h;
    if (diff === 1) p2 = '双方仅一球之差，' + w.zh + '把握住机会，' + l.zh + '未能扳回。';
    else if (diff >= 5) p2 = '比分 ' + hs + '-' + as + '，' + w.zh + '优势明显，比赛早早就失去悬念。';
    else if (Math.min(hs, as) === 0) p2 = w.zh + '零封对手，' + hs + '-' + as + ' 的比分说明了一切。';
    else if (hs >= 3 && as >= 3) p2 = '一场对攻战，双方合力打进 ' + (hs + as) + ' 球，' + w.zh + '笑到最后。';
    else p2 = w.zh + '以 ' + Math.max(hs, as) + '-' + Math.min(hs, as) + ' 击败' + l.zh + '，分差 ' + diff + ' 球。';
  }
  paras.push(p2);

  // 段 3：意义（只用队伍档次、赛事分量、中国关联这些静态事实）
  const bits = [];
  const hT1 = T.isT1(h.zh); const aT1 = T.isT1(a.zh);
  if (hT1 && aT1) bits.push('这是两支顶级球队之间的对话');
  else if (T.isStrong(h.zh) && T.isStrong(a.zh)) bits.push('两队都属本赛事的强队之列');
  if (T.isCn(h.zh) || T.isCn(a.zh)) bits.push('中国队伍出战，对国内球迷而言分量不同');
  else if (m.comp === 'lpl' || m.comp === 'chn') bits.push('中国赛区的比赛');
  if (st.label === '决赛') bits.push('这一场直接关系到冠军归属');
  else if (st.label === '半决赛') bits.push('胜者距离决赛只差一步');
  else if (st.label === '四分之一决赛') bits.push('八强战，输球即止步');
  else if (st.label === '淘汰赛阶段' || st.label === '小组赛') bits.push('淘汰赛阶段，每一场都不能失手');
  if (nar.key === 'upset') bits.push('结果并不在多数人的预期之内');
  paras.push(bits.length ? bits.join('，') + '。' : '这场比赛的结果，将计入本阶段的后续走势。');

  return paras;
}

// ── 数据栏（纯数据，零风险）────────────────────────────
function factbox(m) {
  return {
    comp: compZh(m.comp),
    stage: stageZh(m.stage),
    time: m.date + ' ' + (m.time || ''),
    venue: m.venue || '',
    home: { zh: m.home.zh, abbr: m.home.abbr, score: m.home.score, color: N.color(m.home.color) },
    away: { zh: m.away.zh, abbr: m.away.abbr, score: m.away.score, color: N.color(m.away.color) },
    bo: Number(m.bo) || null,
  };
}

module.exports = { narrative, title, lead, body, factbox, compZh, stageZh, COMP_ZH };
