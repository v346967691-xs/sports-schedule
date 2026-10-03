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
//
// 🔴 **两条踩过的红线，改动前先看**：
//  1. **队名一律用 `T.disp(team)`，不要直接写 `team.zh`。**
//     电竞俱乐部按用户要求「`zh` 留空、`name` 放简码」（sync.js 的 lolTeam），
//     显示口径是小程序的 `zh || name`。这里当初直接读 `.zh`，
//     于是电竞头条被写成了「战胜，比分1-0」—— 整句没有主语（2026-10-03 用户截图）。
//  2. **赛事中文名表 `COMP_ZH` 必须覆盖全部赛事 key**，
//     否则 `|| comp` 会把 `demacia` 这种原始 key 漏进正文。
//     smoke 有守卫，加赛事时同步补这张表。

const T = require('./teams-tier.js');
const N = require('./team-nickname.js');
// 阶段判定必须复用 brief-score 的 stageBonus，不要在这里另写正则：
// ⚠️ 「半决赛」包含「决赛」二字，自己写 /决赛/ 会把半决赛判成决赛，
// 标题就会写出「世界赛半决赛，T1 问鼎」这种硬伤（回测踩过）。
const { stageBonus } = require('./brief-score.js');

/**
 * 赛事 key → 报纸上用的中文名。
 *
 * 🔴 **必须覆盖全部 31 个赛事**（2026-10-03 补全到 26，10-04 再加 5 项）。这张表原来只有 13 项，
 *    缺的那一半会 `|| comp` **把原始 key 直接漏进正文** —— 用户截图里那句
 *    「北京时间…，demacia瑞士轮一场比赛结束」就是这么来的。
 *    `tools/smoke.js` 有守卫：每个赛事 key 都要有值、且值不能等于 key 本身。
 *    口径：取数据层的官方短名（西甲/意甲…），个别为标题长度或报纸习惯做微调。
 */
const COMP_ZH = {
  // 足球
  ucl: '欧冠', epl: '英超', liga: '西甲', seriea: '意甲', bundesliga: '德甲', ligue1: '法甲',
  uel: '欧联', uecl: '欧协联', nations: '欧国联', chn: '中国之队',
  csl: '中超', acl: '亚冠精英', asiacup: '亚洲杯',
  acl2: '亚冠二级', wucl: '女足欧冠', mls: '美职联', lib: '解放者杯', cnl: '北美国联',
  u17: 'U17世界杯', u17w: 'U17女足世界杯', friendly: '国际友谊赛',
  // 篮球
  nba: 'NBA', cba: 'CBA',
  // 电竞
  worlds: '全球总决赛', msi: '季中冠军赛', lpl: 'LPL', lck: 'LCK', lec: 'LEC',
  demacia: '德玛西亚杯', kpl: 'KPL', agames: '亚运会电竞',
};

function compZh(comp) { return COMP_ZH[comp] || comp; }

/**
 * 中英相邻时留一个空格：「RED战胜NAVI」「上海EDG.M以 3-2 拿下」都会挤成一坨。
 *
 * ⚠️ 判据是**边界字符**，不是「整串有没有汉字」——
 *    「上海EDG.M」是混排的，按后者判就不补空格，照样挤。
 * 中文队名原样不动（保持报纸该有的紧凑）。
 *   side='r' 名字后面接动词 → 结尾是拉丁/数字就补在右；'l' 反之补在左。
 */
function pad(name, side) {
  const s = String(name || '');
  if (!s) return s;
  if (side === 'r' && /[A-Za-z0-9]$/.test(s)) return s + ' ';
  if (side === 'l' && /^[A-Za-z0-9]/.test(s)) return ' ' + s;
  return s;
}

/** 清理拼接留下的双空格与首尾空格 */
function tidy(s) { return String(s || '').replace(/\s{2,}/g, ' ').trim(); }

/** 赛制里的数字用汉字：「五局三胜」而不是「5 局 3 胜」。超出表就退回阿拉伯数字。 */
const ZH_NUM = { 1: '一', 2: '二', 3: '三', 4: '四', 5: '五', 6: '六', 7: '七', 8: '八', 9: '九' };
function zhNum(n) { return ZH_NUM[n] || String(n); }
/** BO 局数 → 报纸上的说法：boZh='五局'、boRule='五局三胜' */
function boWords(bo) {
  const need = Math.ceil(bo / 2); // 赢下系列赛所需局数
  return { need, boZh: zhNum(bo) + '局', boRule: zhNum(bo) + '局' + zhNum(need) + '胜' };
}

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
  // 队名走显示口径（见文件头红线 1）
  const hz = T.disp(h); const az = T.disp(a);
  const hs = Number(h.score) || 0;
  const as = Number(a.score) || 0;
  const diff = Math.abs(hs - as);
  const comp = m.comp;
  const stage = stageZh(m.stage);
  const bo = Number(m.bo) || 1;

  const win = hs > as ? h : (as > hs ? a : null);
  const lose = hs > as ? a : (as > hs ? h : null);
  const wStrong = !!win && T.isStrong(T.disp(win));
  const lStrong = !!lose && T.isStrong(T.disp(lose));
  const wT1 = !!win && T.isT1(T.disp(win));
  const lT1 = !!lose && T.isT1(T.disp(lose));

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

  // 4. 电竞：打满 / 横扫 / 苦战
  // ⚠️ 用 `isEsports` 而不是 `isLol`，并把「赢下系列赛所需局数」算出来别写死 3
  //    —— KPL 决赛是 BO7（需要 4 胜），写死 3 会把它判成「五局内解决」。
  //    （原来 `isLol` 漏了 demacia/kpl/agames，电竞比赛会掉到通用分支拿足球措辞。）
  if (T.isEsports(comp)) {
    const best = Math.max(hs, as); const worst = Math.min(hs, as);
    const b = boWords(bo); // need / boZh / boRule —— 别写死 3，KPL 决赛是 BO7
    if (bo >= 5 && best === b.need && worst === b.need - 1) return { key: 'thriller', label: '打满' + b.boZh };
    if (bo >= 5 && best === b.need && worst === 0) return { key: 'sweep', label: '零封横扫' };
    // ⚠️ BO5 打满与横扫之间是 3-1，这个分支不能漏 —— 漏了就会掉到 clash，
    // 正文还会被误写成"打满五局"（回测时踩过）
    if (bo >= 5 && best === b.need && worst === 1) return { key: 'dominant', label: b.boZh + '内解决' };
    if (bo >= 3 && best === b.need && worst === b.need - 1) return { key: 'close_series', label: '三局苦战' };
    if (bo >= 3 && best === b.need && worst === 0) return { key: 'sweep', label: '直落两局' };
  }

  // 5. 豪门对决
  // ⚠️ 平局要排除在外：平局归下面的 draw / goalless，
  // 落到这一栏会被写成「斗牛士力压格子军团，比分 3-3」—— 自相矛盾。
  if (diff > 0 && T.isT1(hz) && T.isT1(az)) return { key: 'derby', label: '豪门对决' };

  // 6. 平局
  if (diff === 0) {
    if (T.isFootball(comp) && hs === 0) return { key: 'goalless', label: '互交白卷' };
    return { key: 'draw', label: '战平' };
  }

  // 7. 险胜：**只对足球与篮球成立**。「一球之差」用在电竞上是硬伤
  //    （2026-10-03 用户截图：德杯 1-0 被写成「双方仅一球之差」）。
  if (T.isFootball(comp) && diff === 1) return { key: 'nailbiter', label: '一球之差' };
  if (T.isBasketball(comp) && diff <= 3) return { key: 'nailbiter', label: '毫厘之差' };

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
    (c) => '打满' + c.boZh + '：' + c.w + '决胜局力克' + c.l,
    (c) => c.boZh + '鏖战，' + c.w + ' ' + c.ws + ' 险胜' + c.l,
  ],
  sweep: [
    (c) => c.w + '零封' + c.l + '，系列赛' + c.ws,
    (c) => '干净利落：' + c.w + ' ' + c.ws + ' 带走' + c.l,
  ],
  dominant: [
    (c) => c.w + ' ' + c.ws + ' 拿下' + c.l + '，未让比赛拖入决胜局',
    (c) => c.boRule + '制，' + c.w + '以 ' + c.ws + ' 取胜',
  ],
  close_series: [
    (c) => c.w + '三局苦战拿下' + c.l + '，比分' + c.ws,
    (c) => c.ws + '：' + c.w + '在第三局分出胜负',
  ],
  // ⚠️ 措辞必须跟着实际分差走（2026-09-30 翻车过）：
  // 这一栏曾经写死「一球制胜」，结果西班牙 4-1 克罗地亚的早报标题也写成
  // 「欧国联德比：斗牛士一球制胜格子军团」—— 分差是 3 球，直接被打脸。
  // 现在按 diff 分档：1 球才说「一球险胜」，3 球及以上说「大胜」，其余只说「力压」。
  //
  // ⚠️ 另外不再用「德比」二字：德比指同城/同地区的对手，而这里判据只是「双方都是 T1」，
  // 西班牙 vs 克罗地亚这种国家队碰面根本不是德比。写成德比是硬伤。
  derby: [
    (c) => c.comp + '豪门对决：' + c.w + (c.diff === 1 ? '一球险胜' : (c.diff >= 3 ? '大胜' : '力压')) + c.l + '，比分' + c.ws,
    (c) => c.w + '与' + c.l + '的对话，' + c.ws + '分出胜负',
    (c) => '豪门对决：' + c.w + '拿下' + c.l + '，比分' + c.ws,
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

  // 队名走显示口径（见文件头红线 1）；拉丁简码补一个外侧空格（见 pad）
  const [lh0, la0] = N.pairLabel(T.disp(h), T.disp(a));
  const lh = pad(lh0, 'r');
  const la = pad(la0, 'l');
  const winName = win ? T.disp(win) : ''
  const loseName = lose ? T.disp(lose) : ''
  const b = boWords(Number(m.bo) || 1);
  const ctx = {
    comp: compZh(m.comp),
    stage: stageZh(m.stage),
    score: hs + '-' + as,                                    // 主队在前
    ws: win ? Math.max(hs, as) + '-' + Math.min(hs, as) : hs + '-' + as, // 胜者在前
    diff: Math.abs(hs - as),                                 // 分差：措辞分档要用
    boZh: b.boZh, boRule: b.boRule, need: b.need,            // 赛制说法：BO7 不能写成「五局」
    h2: lh, a2: la,
    w: win ? pad(N.label(winName), 'r') : lh,
    l: lose ? pad(N.label(loseName), 'l') : la,
  };

  const tpls = TITLE_TPL[nar.key] || TITLE_TPL.plain;
  const tpl = tpls[(seq || 0) % tpls.length];
  return { text: tidy(tpl(ctx)), narrative: nar };
}

// ── 导语（答案优先，一句话把结果说完）────────────────────
function lead(m) {
  const h = m.home || {}; const a = m.away || {};
  const hz = T.disp(h); const az = T.disp(a);          // 显示口径，见文件头红线 1
  const hs = Number(h.score) || 0;
  const as = Number(a.score) || 0;
  const comp = compZh(m.comp);
  const stage = stageZh(m.stage);
  // ⚠️ 「德玛西亚杯」+「瑞士轮」中间要有分隔，否则读成「德玛西亚杯瑞士轮」一坨
  const stagePart = stage && stage !== comp ? comp + ' · ' + stage : comp;
  const win = hs > as ? h : (as > hs ? a : null);

  let result;
  if (!win) result = pad(hz, 'r') + '与' + pad(az, 'l') + ' ' + hs + '-' + as + ' 握手言和';
  else {
    const loseZh = T.disp(win === h ? a : h);
    const w0 = win === h ? hz : az;
    result = pad(w0, 'r') + ' ' + Math.max(hs, as) + '-' + Math.min(hs, as) + ' 击败' + pad(loseZh, 'l');
  }
  return tidy('北京时间' + m.date + ' ' + (m.time || '') + '，' + stagePart + '一场比赛结束，' + result + '。');
}

// ── 正文（三段，只用可推的事实）──────────────────────────
function body(m) {
  const h = m.home || {}; const a = m.away || {};
  const hz = T.disp(h); const az = T.disp(a);          // 显示口径，见文件头红线 1
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
  // ⚠️ 队名缺失时（理论上已被 headlineWorthy 挡住）宁可不写这句，也别留「，对阵。」
  if (hz && az) {
    paras.push(comp + (stage && stage !== comp ? ' · ' + stage : '') + '，'
      + (m.venue ? pad(hz, 'r') + '坐镇' + m.venue + '迎战' + pad(az, 'l') : pad(hz, 'r') + '对阵' + pad(az, 'l')) + '。');
  } else {
    paras.push(comp + (stage && stage !== comp ? ' · ' + stage : '') + '的一场较量已经结束。');
  }

  // 段 2：比分解读（严格按可推的事实）
  let p2;
  if (T.isEsports(m.comp)) {
    // ⚠️ 用「赢下系列赛所需局数」而不是写死 3（KPL 决赛是 BO7）
    // ⚠️ 电竞一律用「局」，**不许出现「球」** ——「双方仅一球之差」是足球的话
    const best = Math.max(hs, as);
    const worst = Math.min(hs, as);
    const bw = boWords(bo);                      // need / boZh / boRule
    const need = bw.need;
    const wname = pad(hs > as ? hz : az, 'r');   // 「上海EDG.M以…」要留一个空格
    if (bo >= 5 && best === need && worst === need - 1) {
      p2 = '系列赛打满' + bw.boZh + '，' + wname + '以 ' + best + '-' + worst + ' 拿下，决胜局分出高下。';
    } else if (bo >= 5 && best === need && worst === 0) {
      p2 = '连下' + zhNum(need) + '城，' + wname + ' ' + best + '-0 横扫对手，未丢一局。';
    } else if (bo >= 5) {
      // ⚠️ 中文术语是「五局三胜」（BO5 拿 3 局），不是「五局四胜」——
      //    写成 bo+1 会闹笑话（need 才是取胜所需局数）
      p2 = bw.boRule + '制下，' + wname + '以 ' + best + '-' + worst + ' 取胜，最后一局没有用上。';
    } else if (bo >= 3 && best === need && worst === need - 1) {
      p2 = '三局苦战，' + wname + '以 ' + best + '-' + worst + ' 拿下，第三局定胜负。';
    } else if (bo >= 3 && best === need) {
      p2 = '直落' + zhNum(need) + '局，' + wname + ' ' + best + '-' + worst + ' 取胜。';
    } else if (bo >= 3) {
      p2 = '三局两胜制下，' + wname + '以 ' + best + '-' + worst + ' 拿下系列赛。';
    } else {
      // 单局制（德杯瑞士轮这种 BO1）：只能说「拿下这一局」，
      // 不能出现任何「一球之差」式的足球措辞（2026-10-03 用户截图里的错）
      p2 = '单局定胜负，' + wname + '拿下唯一一局。';
    }
  } else if (hs === as) {
    p2 = hs === 0 ? '九十分钟互无建树，比分定格在 0-0。' : '双方战成 ' + hs + '-' + as + '，各取一分。';
  } else {
    const w = pad(hs > as ? hz : az, 'r');
    const l = pad(hs > as ? az : hz, 'l');
    if (T.isFootball(m.comp) && diff === 1) p2 = '双方仅一球之差，' + w + '把握住机会，' + l + '未能扳回。';
    else if (T.isFootball(m.comp) && diff >= 5) p2 = '比分 ' + hs + '-' + as + '，' + w + '优势明显，比赛早早就失去悬念。';
    else if (T.isFootball(m.comp) && Math.min(hs, as) === 0) p2 = w + '零封对手，' + hs + '-' + as + ' 的比分说明了一切。';
    else if (T.isFootball(m.comp) && hs >= 3 && as >= 3) p2 = '一场对攻战，双方合力打进 ' + (hs + as) + ' 球，' + w + '笑到最后。';
    else p2 = w + '以 ' + Math.max(hs, as) + '-' + Math.min(hs, as) + ' 击败' + l + '，分差 ' + diff + ' 分。';
  }
  paras.push(p2);

  // 段 3：意义（只用队伍档次、赛事分量、中国关联这些静态事实）
  // ⚠️ 「瑞士轮 / 小组赛」不能说成「淘汰赛阶段」—— 2026-10-03 用户截图里的硬伤。
  //    宁可少写一句，也不写语义错的套话。
  const bits = [];
  const hT1 = T.isT1(hz); const aT1 = T.isT1(az);
  if (hT1 && aT1) bits.push('这是两支顶级球队之间的对话');
  else if (T.isStrong(hz) && T.isStrong(az)) bits.push('两队都属本赛事的强队之列');
  if (T.isCn(hz) || T.isCn(az)) bits.push('中国队伍出战，对国内球迷而言分量不同');
  // ⚠️ **不要**为 `lpl`/`kpl` 另加一句「中国赛区的比赛」：这两个赛区**整建制都是中国队伍**，
  //    对一场内战的读者来说等于废话（正是用户 2026-10-03 说的"空洞"的一部分）。
  //    `chn`（国家队）走上面那句；`lpl`/`kpl` 没别的料就交给末尾的「无料不写段」。
  if (st.label === '决赛') bits.push('这一场直接关系到冠军归属');
  else if (st.label === '半决赛') bits.push('胜者距离决赛只差一步');
  else if (st.label === '四分之一决赛') bits.push('八强战，输球即止步');
  else if (st.label === '淘汰赛阶段') bits.push('淘汰赛阶段，输一场即出局');
  else if (st.label === '小组赛' || st.label === '瑞士轮') bits.push('赛制下每一场都影响出线形势');
  if (nar.key === 'upset') bits.push('结果并不在多数人的预期之内');
  // 🔴 **没料就不写这一段**。曾经的兜底句「将计入本阶段的后续走势」「这场比赛的赛果
  //    已记入当日赛程」都是填充物 —— 用户 2026-10-03 反馈的"措辞空洞"正是冲着这类句子。
  //    宁可正文少一段，也不要凑一句没有信息量的话（smoke 只要求 body 非空）。
  if (bits.length) paras.push(bits.join('，') + '。');

  return paras.map(tidy);
}

// ── 数据栏（纯数据，零风险）────────────────────────────
function factbox(m) {
  return {
    comp: compZh(m.comp),
    stage: stageZh(m.stage),
    time: m.date + ' ' + (m.time || ''),
    venue: m.venue || '',
    // ⚠️ 字段名沿用 `zh`（小程序按这个 key 取），但**填的是显示口径** `zh || name`
    //    —— 否则电竞比赛的队名栏是空的，比分悬在中间（用户截图里的样子）。
    home: { zh: T.disp(m.home), abbr: m.home.abbr, score: m.home.score, color: N.color(m.home.color) },
    away: { zh: T.disp(m.away), abbr: m.away.abbr, score: m.away.score, color: N.color(m.away.color) },
    bo: Number(m.bo) || null,
  };
}

module.exports = { narrative, title, lead, body, factbox, compZh, stageZh, pad, tidy, zhNum, boWords, COMP_ZH };
