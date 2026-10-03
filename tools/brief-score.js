// 选题算法：从一个窗口内的已结束比赛中，算出哪一条最值得做成当日头版
// 设计原则：不依赖任何外部新闻源，只用 data/matches.js 已有的结构化字段
// 本文件只在构建期使用，不进小程序包

const T = require('./teams-tier.js');

// 赛事基础权重：0-100，代表这个赛事本身的分量
const COMP_WEIGHT = {
  worlds: 100,  // 全球总决赛
  msi: 92,      // 季中冠军赛
  // 俱乐部足球整体上调 +8（用户裁定：五大联赛德比应优先于 LEC 决赛）。
  // 调整前后对照见文件末尾的注释，改动一处必须重跑 tools/brief-pick.js 验证。
  ucl: 96,      // 欧冠
  epl: 82,      // 英超
  liga: 80,     // 西甲
  seriea: 78,   // 意甲
  bundesliga: 78,
  ligue1: 74,   // 法甲
  uel: 66,      // 欧联
  nba: 74,      // NBA：与五大联赛同档，中文语境下关注度相当
  lpl: 64,
  lck: 64,
  lec: 52,      // LEC：国内关注度明显低于 LPL/LCK，刻意压低
  chn: 54,      // 中国之队
  // 欧国联：国家队比赛日通常独占一天，但英西、德荷这种对决在真实体育报纸上就是头版。
  // 定 58 是为了让「豪门对决 +26」后能压过同期 LCK/LPL 常规赛（64+16=80），
  // 又不会高到盖过五大联赛豪门对决（74+26=100）。
  nations: 58,
  // ── 2026-10-03 补全（此前这 10 项没有条目，只能吃兜底的默认值 30）────────────
  // 后果不是「分数略低」这么轻：默认 30 让「德杯瑞士轮 BO1」压过了「KPL 擂台赛 BO5」，
  // 于是头版成了连队名都写不出来的杯赛小组赛。默认值只该兜底，不该当主力。
  // 补全后必须重跑 `node tools/brief-pick.js` 看排序有没有被翻掉。
  asiacup: 70,   // 亚洲杯（国家队正赛，中国队参赛时再 +20）
  acl: 56,       // 亚冠精英：低于欧联 66，与中国赛事同档（中国球队参赛有话题）
  csl: 56,       // 中超
  cba: 56,       // CBA：与中超同档，国内关注度相当
  uecl: 54,      // 欧协联：明显低于欧联/欧冠
  kpl: 52,       // 王者荣耀职业联赛：国内关注度不低，但低于 LPL/LCK 的 64
  agames: 62,    // 亚运会电竞：国家队性质，高于常规联赛
  friendly: 44,  // 国际友谊赛：练兵性质，除非中国队出战否则不该上头版
  u17: 40,       // U17 世界杯（中国队参赛时再 +20）
  u17w: 40,      // U17 女足世界杯
  demacia: 38,   // 德杯：LPL 区域杯赛里的二线赛事，刻意压到所有正赛之下
  // ── 2026-10-04 新增 5 项赛事（不给它们吃默认值 30）──────────────────────
  acl2: 50,      // 亚冠二级：低于亚冠精英 56，但有中超球队（+20 中国关联仍生效）
  wucl: 48,      // 女足欧冠：关注度低于男足欧冠，高于德杯
  lib: 46,       // 解放者杯：南美最高级别俱乐部赛事，中文语境关注度为中低
  mls: 44,       // 美职联：与国际友谊赛同档（梅西效应已过，且时区对国内不友好）
  cnl: 38,       // 北美国家联赛：与德杯同档，中文语境几乎没有关注度
};

// stage 字段形如「全球总决赛 · 瑞士轮」或「英超」：前半是赛事名，后半才是阶段
// ⚠️ 必须先剥离赛事名 —— 否则「全球总决赛 · 瑞士轮」会被误判成「决赛」（踩过这个坑）
function parseStage(stage) {
  const s = String(stage || '');
  const parts = s.split('·').map((x) => x.trim());
  return parts.length > 1 ? parts[parts.length - 1] : s;
}

// 阶段加成：淘汰赛越靠后越值钱。顺序必须从具体到笼统，
// 否则「四分之一决赛」会先被 /决赛/ 命中拿到决赛的分。
// ⚠️ 「瑞士轮」必须单列在「小组赛」之前：两者分值一样，但**标签不同**，
//    正文里会把「小组赛」写成「淘汰赛阶段，每一场都不能失手」——
//    瑞士轮是积分循环制，根本不是淘汰赛（2026-10-03 用户截图里就是这么错的）。
const STAGE_RULES = [
  { test: /四分之一|八强/, add: 24, label: '四分之一决赛' },
  { test: /半决赛|四强/, add: 32, label: '半决赛' },
  { test: /决赛|冠军赛/, add: 42, label: '决赛' },
  { test: /淘汰|附加赛|季后|资格赛|保级/, add: 18, label: '淘汰赛阶段' },
  { test: /瑞士轮/, add: 4, label: '瑞士轮' },
  { test: /小组赛|分组|循环/, add: 4, label: '小组赛' },
];

function stageBonus(stageRaw) {
  const stage = parseStage(stageRaw);
  for (const r of STAGE_RULES) {
    if (r.test.test(stage)) return r;
  }
  return { add: 0, label: '' };
}

// 单场比赛打分
function score(m) {
  const reasons = [];
  const comp = m.comp;
  const h = m.home || {};
  const a = m.away || {};
  // 🔴 队名一律过显示口径（`zh || name`）—— 电竞俱乐部 `zh` 是空的，
  //    直接取 `.zh` 会让 isStrong/isCn 全部返回 false（见 teams-tier.js 文件头）
  const hz = T.disp(h);
  const az = T.disp(a);
  const hs = Number(h.score) || 0;
  const as = Number(a.score) || 0;
  const diff = Math.abs(hs - as);

  // 1. 赛事分量
  let s = COMP_WEIGHT[comp] != null ? COMP_WEIGHT[comp] : 30;

  // 2. 阶段
  const st = stageBonus(m.stage);
  s += st.add;
  if (st.label) reasons.push(st.label);

  // 3. 强队：强强对话 > 单方豪门 > 无
  // ⚠️ 「豪门对决 +34」是落实「五大联赛德比优先于 LEC 决赛」的关键旋钮。
  // 它只影响足球与国家队 —— 因为 isT1() 只认 FOOTBALL_T1 / NATIONAL_T1，
  // 电竞队伍不在 T1 名单里。所以调高它不会误伤 LPL/LCK 决赛：
  //   马德里德比 80+34+6 = 120  >  LEC 决赛 52+42+16+8 = 118   ← 要的效果
  //   LPL 决赛   64+42+16+8+6+20 = 156                        ← 不受影响，仍最高
  // 改这个值必须重跑回测：调到 26 时德比会被 LEC 决赛压过去（用户否决的排法）。
  const hT1 = T.isT1(hz);
  const aT1 = T.isT1(az);
  const hS = T.isStrong(hz);
  const aS = T.isStrong(az);
  if (hT1 && aT1) { s += 34; reasons.push('豪门对决'); }
  else if (hS && aS) { s += 16; reasons.push('强强对话'); }
  else if (hT1 || aT1) { s += 9; reasons.push('豪门出战'); }
  else if (hS || aS) { s += 4; reasons.push('强队出战'); }

  // 4. 冷门：名单上的强队被非强队击败 —— 报纸头版最爱
  // ⚠️ 必须分级：一刀切 +38 会让「帕尔马 2-1 热那亚」这种保级队互啄
  // 盖过「马竞 2-1 皇马」的马德里德比（回测踩过这个坑）。
  // 只有掀翻 T1 豪门才算真冷门；掀翻二线强队只是小冷门。
  const beatT1 = (hT1 && !aS && as > hs) || (aT1 && !hS && hs > as);
  const beatT2 = (hS && !aS && as > hs) || (aS && !hS && hs > as);
  if (beatT1) { s += 36; reasons.push('冷门'); }
  else if (beatT2) { s += 12; reasons.push('小冷门'); }

  // 5. 戏剧性：不同项目用不同尺度
  // ⚠️ 悬殊比分必须看是谁赢谁 —— 强队大胜鱼腩是日常，弱队大胜强队才是地震
  const winner = hs > as ? h : (as > hs ? a : null);
  const loser = hs > as ? a : (as > hs ? h : null);
  const wStrong = !!winner && T.isStrong(T.disp(winner));
  const lStrong = !!loser && T.isStrong(T.disp(loser));

  if (T.isFootball(comp)) {
    if (diff >= 5) {
      if (wStrong && !lStrong) { s += 10; reasons.push('强队大胜'); }
      else if (!wStrong && lStrong) { s += 34; reasons.push('弱队大胜强队'); }
      else { s += 22; reasons.push('比分悬殊'); }
    } else if (diff === 4) {
      if (wStrong && !lStrong) s += 5;
      else if (!wStrong && lStrong) { s += 26; reasons.push('弱队大胜强队'); }
      else { s += 15; reasons.push('大比分'); }
    } else if (diff === 1) {
      s += 6;
      reasons.push('一球之差');
    }
  } else if (T.isEsports(comp)) {
    // ⚠️ 电竞没有「球」，只有「局」。「1-0」在 BO1 里是赢下唯一一局，
    //    绝不能说成「一球之差」（2026-10-03 用户截图里就是这么错的）。
    // ✅ 用「赛制需要几局取胜」分档，别写死 3 —— KPL 决赛是 BO7，需要 4 胜。
    const best = Math.max(hs, as);
    const worst = Math.min(hs, as);
    const bo = Number(m.bo) || 1;
    const need = Math.ceil(bo / 2); // 赢下系列赛所需局数：BO1→1、BO3→2、BO5→3、BO7→4
    if (bo >= 5 && best === need && worst === need - 1) { s += 28; reasons.push('BO' + bo + ' 打满'); }
    else if (bo >= 5 && best === need && worst <= 1) { s += 8; reasons.push('BO' + bo + ' 横扫'); }
    else if (bo >= 3 && best === need && worst === need - 1) { s += 6; reasons.push('BO' + bo); }
    else if (bo >= 3 && best === need) { reasons.push('BO' + bo); }
  } else if (T.isBasketball(comp)) {
    if (diff >= 25) { s += 18; reasons.push('大比分'); }
    else if (diff <= 3) { s += 16; reasons.push('毫厘之差'); }
  }

  // 6. 中国关联：按队伍判断，国际赛事里的 LPL 队伍同样算
  // ⚠️ 这是本产品最关键的定位旋钮，不是可以随手调的小分。
  // 20 的含义：中国队出战 ≈ 一场欧洲「强强对话」（+16），且同分时优先给中国（见 tieBreak）。
  // 调到 14 时，中国男足 0-3 新西兰 会被 德国 0-1 希腊 压过去 —— 中文体育报纸不会这么排。
  // 调到 26 以上，中国队打马尔代夫也会盖过豪门对决，同样失真。
  // ⚠️ 2026-10-03 补了 kpl：KPL 是中国赛区的联赛，与 lpl 同等对待
  //    （KPL 队名带中国城市前缀，但不在 CN_CLUBS 名单里，不补就永远拿不到中国关联分）。
  if (comp === 'lpl' || comp === 'chn' || comp === 'kpl') { s += 6; reasons.push('中国赛事'); }
  if (T.isCn(hz) || T.isCn(az)) { s += 20; reasons.push('中国队伍出战'); }

  return { score: Math.round(s), reasons };
}

/**
 * 这场比赛够不够格上头版？
 *
 * ⚠️ 判据是「**能不能写成人话**」，不是新闻价值：
 *    队名缺失时标题会退化成「战胜，比分1-0」这种没有主语的句子（2026-10-03 用户截图），
 *    与其出一句空话，不如不出头条、改走前瞻分支。
 *    实测 630 场已结束比赛里队名齐全率 100%（用显示口径统计），所以这道闸门平时不误伤，
 *    只在数据源突然变脸时兜底。
 */
const PLACEHOLDER = /^(tbd|tba|待定|\?|-)+$/i;
function headlineWorthy(m) {
  const h = T.disp(m.home);
  const a = T.disp(m.away);
  if (!h || !a) return false;
  if (PLACEHOLDER.test(h) || PLACEHOLDER.test(a)) return false;
  return true;
}

// 同分时怎么排：足球优先 → 局数多的优先 → 中国关联 → 分差 → 开赛时间
// ⚠️ 「足球优先」是 2026-10-03 用户口述的排序偏好（电竞当头条时措辞容易空）。
//    放在**只在同分时生效**的位置是有意的：它不该推翻已经算好的权重
//    —— 用户此前裁定过「LPL 决赛 156 分仍是最高」，那是权重问题不是同分问题。
function tieBreak(x, y) {
  const fx = T.isFootball(x.comp) ? 1 : 0;
  const fy = T.isFootball(y.comp) ? 1 : 0;
  if (fx !== fy) return fy - fx;
  const bo = (Number(y.bo) || 1) - (Number(x.bo) || 1);
  if (bo !== 0) return bo;
  const cnX = (T.isCn(T.disp(x.home)) || T.isCn(T.disp(x.away)) || x.comp === 'lpl' || x.comp === 'chn' || x.comp === 'kpl') ? 1 : 0;
  const cnY = (T.isCn(T.disp(y.home)) || T.isCn(T.disp(y.away)) || y.comp === 'lpl' || y.comp === 'chn' || y.comp === 'kpl') ? 1 : 0;
  if (cnX !== cnY) return cnY - cnX;
  const dX = Math.abs((Number(x.home.score) || 0) - (Number(x.away.score) || 0));
  const dY = Math.abs((Number(y.home.score) || 0) - (Number(y.away.score) || 0));
  if (dX !== dY) return dY - dX;
  return Date.parse(y.start) - Date.parse(x.start);
}

// 在一个窗口内挑出头版与备选
// ⚠️ 队名不全的比赛**直接剔掉**（见 headlineWorthy）：它们既写不出标题，
//    在简讯里也只会显示成「demacia： 1-0 」这种半截行。
//    全部候选都不够格时返回空数组 → brief-build 自动落到前瞻分支，宁可不设头条。
function pick(list, topN) {
  return list
    .filter((m) => m.status === 'finished')
    .filter(headlineWorthy)
    .map((m) => {
      const r = score(m);
      return Object.assign({}, m, { _score: r.score, _reasons: r.reasons });
    })
    .sort((x, y) => (y._score - x._score) || tieBreak(x, y))
    .slice(0, topN || 5);
}

module.exports = { score, pick, headlineWorthy, tieBreak, COMP_WEIGHT, stageBonus };
